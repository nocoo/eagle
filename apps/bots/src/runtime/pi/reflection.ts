import { createHash } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import {
  awaitWithContext,
  withAbortSignal,
  withoutAbortSignal,
} from "@earendil-works/chord/context";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type Cursor,
  configure,
  defineDoc,
  defineDocFamily,
  defineExtension,
  type EntryRecord,
  GenerationTask,
  type Harness,
  hook,
  type TaskId,
  UsageDoc,
  type UsageState,
  wrapTool,
} from "@earendil-works/pi-durable";
import { deriveBotNote, type RunNote } from "../../core/domain.ts";
import { createNoteSetTool } from "../../tools/note.ts";
import type { NoteToolHost } from "../../tools/types.ts";
import type { UsageMeter } from "../../tools/usage.ts";
import { convertUsage } from "./convert.ts";

export const REFLECTION_EXTENSION = "bots-reflection";
export const REFLECTION_TOOL_ENTRY = "bots.reflection.tool";
export const REFLECTION_MAX_REQUESTS = 2;
export const REFLECTION_TIMEOUT_MS = 15_000;
export const REFLECTION_PROMPT =
  "Before finishing, consider whether the sidebar status should change to reflect the current work. If it should, call note_set with a concise, factual status. Otherwise leave it unchanged. Do not address the user.";

const Plan = defineDocFamily<
  {
    source: string;
    childId?: number;
    previous?: string;
    previousAt?: string;
    previousRevision?: string;
    fallback?: string;
    pendingNote?: string;
    pendingSource?: string;
    deadline?: number;
  },
  null
>({
  kind: "bots.reflection.plan",
  version: 1,
  scope: "session",
  family: true,
  initial: () => ({ source: "" }),
  checkpointWhen: () => false,
});

const planKey = (root: ConversationId, task: TaskId): string => `${root}:${task}`;

const Candidate = defineDoc<{
  source: string;
  note?: string;
  previous?: string;
  previousAt?: string;
  previousRevision?: string;
  parentTaskId?: number;
  published?: string[];
  requests?: number;
  deadline?: number;
}>({
  kind: "bots.reflection.candidate",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ source: "" }),
  checkpointWhen: () => false,
});

export const answerHash = (answer: AssistantMessage): string =>
  createHash("sha256").update(JSON.stringify(answer.content)).digest("hex");

export const reflectionExtension = (options: {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly note: NoteToolHost;
  readonly runNote: RunNote;
  readonly failed: (taskId: number, reason: string) => void;
}) => {
  const note = createNoteSetTool(options.note);
  const deadlines = new Map<number, () => void>();
  return defineExtension({
    name: REFLECTION_EXTENSION,
    wraps: [
      wrapTool(note, (original) => ({
        ...original,
        async execute(args, api, context) {
          const candidate = await api.snapshot(Candidate, api.conversationId, context);
          if (candidate === undefined) return original.execute(args, api, context);
          const staged = createNoteSetTool({
            botId: options.note.botId,
            current: options.note.current,
            async set(text) {
              await api.commit(async (tx) => {
                const candidate = await tx.doc(Candidate, api.conversationId);
                candidate.note = text;
                if (candidate.published?.includes(api.callId) === true) return;
                let cursor: Cursor | undefined;
                let source: EntryRecord | undefined;
                let call: ToolCall | undefined;
                do {
                  const page = await tx.scanEntries(
                    { conversationId: api.conversationId },
                    100,
                    cursor,
                  );
                  for (const entry of page.items) {
                    const message = entry.model?.[0];
                    if (
                      entry.conversationId !== api.conversationId ||
                      message?.role !== "assistant"
                    )
                      continue;
                    const found = message.content.find(
                      (block): block is ToolCall =>
                        block.type === "toolCall" &&
                        block.id === api.callId &&
                        block.name === "note_set",
                    );
                    if (found !== undefined) {
                      source = entry;
                      call = found;
                      break;
                    }
                  }
                  cursor = page.next;
                } while (source === undefined && cursor !== undefined);
                const original = source?.model?.[0];
                if (source === undefined || original?.role !== "assistant" || call === undefined) {
                  throw new Error("reflection note call is missing");
                }
                const message = JSON.parse(
                  JSON.stringify({ ...original, content: [call] }),
                ) as JsonValue;
                await tx.appendEntry(options.root.id, {
                  kind: REFLECTION_TOOL_ENTRY,
                  data: { childId: api.conversationId, source: source.id, message },
                });
                await tx.appendEntry(options.root.id, {
                  kind: REFLECTION_TOOL_ENTRY,
                  data: {
                    childId: api.conversationId,
                    source: source.id,
                    message: {
                      role: "toolResult",
                      toolCallId: api.callId,
                      toolName: "note_set",
                      content: [{ type: "text", text: "Note proposed for this answer." }],
                      isError: false,
                      timestamp: api.now(),
                    },
                  },
                });
                candidate.published = [...(candidate.published ?? []), api.callId];
              }, context);
              return text === "" ? {} : { note: text };
            },
          });
          const result = await staged.execute(args, api, context);
          return result.isError === true
            ? result
            : {
                ...result,
                output: [{ type: "text" as const, text: "Note proposed for this answer." }],
              };
        },
      })),
    ],
    hooks: [
      hook(GenerationTask, {
        async beforeRequest(_request, api, context) {
          if (api.conversationId === options.root.id) return;
          const candidate = await api.snapshot(Candidate, api.conversationId, context);
          if (candidate === undefined) return;
          const exhausted = await options.root.commit(async (tx) => {
            const current = await tx.doc(Candidate, api.conversationId);
            if (
              (current.requests ?? 0) >= REFLECTION_MAX_REQUESTS ||
              (current.deadline !== undefined && Date.now() >= current.deadline)
            )
              return true;
            current.requests = (current.requests ?? 0) + 1;
            return false;
          }, context);
          if (exhausted) {
            // Hook errors are advisory in the SDK. Abort this owned generation from outside
            // its invocation; awaiting the abort itself here would join this very hook.
            void options.harness
              .abortTask(api.taskId, withoutAbortSignal(context))
              .catch(() => undefined);
            await awaitWithContext(new Promise<never>(() => undefined), context);
          }
          if (candidate.deadline !== undefined) {
            deadlines.get(api.taskId)?.();
            const abort = () => {
              void options.harness
                .abortTask(api.taskId, withoutAbortSignal(context))
                .catch(() => undefined);
            };
            const timer = setTimeout(abort, Math.max(0, candidate.deadline - Date.now()));
            const clear = () => {
              clearTimeout(timer);
              context.abortSignal?.removeEventListener("abort", clear);
              deadlines.delete(api.taskId);
            };
            deadlines.set(api.taskId, clear);
            context.abortSignal?.addEventListener("abort", clear, { once: true });
          }
        },
        async afterResponse(_message, api) {
          deadlines.get(api.taskId)?.();
        },
        async onYield(answer, api, context) {
          if (api.conversationId !== options.root.id) return;
          try {
            const previous = options.note.current();
            const key = planKey(options.root.id, api.taskId);
            await options.root.commit(async (tx) => {
              const plan = await tx.doc(Plan, key, null);
              if (plan.source !== "") return;
              plan.source = answerHash(answer);
              plan.deadline = Date.now() + REFLECTION_TIMEOUT_MS;
              const text = answer.content
                .flatMap((block) => (block.type === "text" ? [block.text] : []))
                .join("");
              plan.fallback = options.runNote.peek() ?? deriveBotNote(text) ?? "";
              if (previous.note !== undefined) plan.previous = previous.note;
              if (previous.at !== undefined) plan.previousAt = previous.at;
              if (previous.revision !== undefined) plan.previousRevision = previous.revision;
            }, context);
            const childId = await options.root.commit(async (tx) => {
              const plan = await tx.doc(Plan, key, null);
              if (plan.childId !== undefined) return plan.childId as ConversationId;
              const last = (await tx.scanEntries({ conversationId: options.root.id }, 1)).items[0];
              if (last === undefined) throw new Error("reflection has no conversation entry");
              const child = await tx.forkConversation(options.root.id, last.id, {
                ownership: { kind: "task", taskId: api.taskId },
              });
              await tx.appendEntry(AssistantEntry, child.id, { model: [answer] });
              await configure(tx, child.id, { tools: [note] });
              const candidate = await tx.doc(Candidate, child.id);
              candidate.source = answerHash(answer);
              if (plan.deadline !== undefined) candidate.deadline = plan.deadline;
              candidate.parentTaskId = api.taskId;
              if (plan.previous !== undefined) candidate.previous = plan.previous;
              if (plan.previousAt !== undefined) candidate.previousAt = plan.previousAt;
              if (plan.previousRevision !== undefined)
                candidate.previousRevision = plan.previousRevision;
              plan.childId = child.id;
              return child.id;
            }, context);
            const child = await options.harness.conversation(childId, context);
            if (child === undefined) throw new Error("reflection conversation is missing");
            const submission = await child.submit(
              {
                type: "input",
                requestId: `reflection:${api.taskId}`,
                entry: { kind: "bots.reflection" },
                content: REFLECTION_PROMPT,
              },
              context,
            );
            const plan = await options.harness.snapshot(Plan, key, context);
            const remaining = (plan?.deadline ?? Date.now()) - Date.now();
            const timeout = AbortSignal.timeout(Math.max(0, remaining));
            let outcome: Awaited<ReturnType<typeof submission.wait>>;
            try {
              outcome = await submission.wait(withAbortSignal(timeout, context));
            } catch (error) {
              if (context.abortSignal?.aborted === true) throw error;
              await child.abort(withoutAbortSignal(context));
              options.failed(api.taskId, "budget");
              return;
            }
            if (outcome.status !== "done") {
              options.failed(api.taskId, outcome.reason);
              return;
            }
          } catch (error) {
            if (context.abortSignal?.aborted === true) throw error;
            options.failed(api.taskId, "internal");
          }
        },
      }),
    ],
  });
};

export const trackReflectionUsage = (options: {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly botId: string;
  readonly usage: UsageMeter;
  readonly failed: (taskId: number, reason: string) => void;
}) => {
  const children = new Map<number, number>();
  let queue: Promise<void> = Promise.resolve();
  const book = (id: number, taskId: number, value: UsageState): void => {
    const total = convertUsage(value);
    if (total.totalTokens === 0 && (total.costUsd ?? 0) === 0) return;
    queue = queue
      .then(() => {
        options.usage.record({
          botId: options.botId,
          source: "model",
          counter: `reflection:${id}`,
          tokens: total.totalTokens,
          ...(total.costUsd === undefined ? {} : { costUsd: total.costUsd }),
        });
      })
      .catch(() => options.failed(taskId, "usage"));
  };
  const unsubscribe = options.harness.subscribeCommits((publication) => {
    for (const change of publication.changes) {
      if (
        change.type !== "document" ||
        change.record.kind !== Candidate.definition.kind ||
        change.conversationId === undefined ||
        change.value === null
      )
        continue;
      const taskId = change.value.parentTaskId;
      if (typeof taskId === "number") children.set(change.conversationId, taskId);
    }
    for (const change of publication.changes) {
      if (
        change.type !== "document" ||
        change.record.kind !== UsageDoc.definition.kind ||
        change.conversationId === undefined ||
        change.value === null
      )
        continue;
      const taskId = children.get(change.conversationId);
      if (taskId !== undefined)
        book(change.conversationId, taskId, change.value as unknown as UsageState);
    }
  });
  return {
    async restore(context: Context): Promise<void> {
      let cursor: Cursor | undefined;
      do {
        const page = await options.root.commit(
          (tx) => tx.scanConversations({ ownerConversationId: options.root.id }, 100, cursor),
          context,
        );
        for (const child of page.items) {
          const candidate = await options.harness.snapshot(Candidate, child.id, context);
          if (candidate?.parentTaskId === undefined) continue;
          children.set(child.id, candidate.parentTaskId);
          const value = await options.harness.snapshot(UsageDoc, child.id, context);
          if (value !== undefined) book(child.id, candidate.parentTaskId, value);
        }
        cursor = page.next;
      } while (cursor !== undefined);
      await queue;
    },
    async close(): Promise<void> {
      unsubscribe();
      await queue;
    },
  };
};

export const reflectionCandidate = async (options: {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly taskId: TaskId;
  readonly context: Context;
}) => {
  const plan = await options.harness.snapshot(
    Plan,
    planKey(options.root.id, options.taskId),
    options.context,
  );
  if (plan === undefined) return undefined;
  if (plan.childId === undefined) return plan;
  const candidate = await options.harness.snapshot(
    Candidate,
    plan.childId as ConversationId,
    options.context,
  );
  return candidate?.note === undefined
    ? plan
    : { ...plan, note: candidate.note, noteSource: candidate.source };
};

export const saveReflectionDecision = async (options: {
  readonly root: Conversation;
  readonly taskId: TaskId;
  readonly answer: AssistantMessage;
  readonly note: string;
  readonly context: Context;
}): Promise<void> => {
  await options.root.commit(async (tx) => {
    const plan = await tx.doc(Plan, planKey(options.root.id, options.taskId), null);
    plan.pendingNote = options.note;
    plan.pendingSource = answerHash(options.answer);
  }, options.context);
};

export const recoverReflectionNote = async (options: {
  readonly harness: Harness;
  readonly root: Conversation;
  readonly note: NoteToolHost;
  readonly context: Context;
}): Promise<void> => {
  let cursor: Cursor | undefined;
  do {
    const page = await options.root.entries({ order: "descending" }, 100, cursor, options.context);
    for (const entry of page.items) {
      if (entry.kind !== "pi.assistant") continue;
      const answer = entry.model?.[0];
      if (
        answer?.role !== "assistant" ||
        (answer.stopReason !== "stop" && answer.stopReason !== "length") ||
        entry.byTaskId === undefined
      )
        continue;
      const taskId = entry.byTaskId as TaskId<{ entryId: number }>;
      const task = await options.harness.getTask(taskId, options.context);
      if (
        task?.state.status !== "terminal" ||
        task.state.outcome.status !== "completed" ||
        task.state.outcome.result.entryId !== entry.id
      )
        continue;
      const candidate = await reflectionCandidate({
        harness: options.harness,
        root: options.root,
        taskId,
        context: options.context,
      });
      const current = options.note.current();
      if (candidate === undefined) return;
      const source = answerHash(answer);
      const text = answer.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      const note =
        candidate.pendingSource === source
          ? candidate.pendingNote
          : "noteSource" in candidate && candidate.noteSource === source
            ? candidate.note
            : candidate.source === source
              ? candidate.fallback
              : deriveBotNote(text);
      if (
        note !== undefined &&
        ((candidate.previous === current.note &&
          candidate.previousAt === current.at &&
          candidate.previousRevision === current.revision) ||
          (current.owner !== undefined && current.owner < taskId))
      )
        await options.note.set(note, current.revision, taskId);
      return;
    }
    cursor = page.next;
  } while (cursor !== undefined);
};
