// Subagents (docs/bots/RUNTIME.md, "Subagents"): a bot delegates a self-contained task to a
// child conversation it owns, driven through this extension rather than a second product.
// The child is an ordinary ownerless conversation in the same Harness, configured from the
// caller's agent but limited to the mandatory `core` and `coding` groups: it has no
// delegation tools, no optional group, no deferred loader and no shared-device tool, so it
// cannot spawn children or reach another machine.
import { type Context, withAbortSignal } from "@earendil-works/chord/context";
import { Type } from "@earendil-works/pi-ai";
import {
  type ConversationId,
  configure,
  defineExtension,
  defineTool,
  type Extension,
  section,
  type ToolRegistration,
  type Tx,
} from "@earendil-works/pi-durable";
import { failed, type ToolOutcome } from "../types.ts";

export const AGENTS_TOOLS_EXTENSION = "bots-agents";

/**
 * Tools a child may never call, whatever it inherits. Delegation would grow a tree;
 * `ask_user` is a card the client draws from the conversation it watches, and nobody watches a
 * child's, so the tool would promise a screen that does not exist; `note_set` writes the one
 * sidebar line of the bot, which belongs to the conversation a person is looking at.
 */
const CHILD_DENIED_TOOLS = [
  "agent_spawn",
  "agent_send",
  "agent_stop",
  "ask_user",
  "note_set",
] as const;

async function managedChild(tx: Tx, id: ConversationId, parent: ConversationId): Promise<boolean> {
  let cursor: Awaited<ReturnType<Tx["scanEntries"]>>["next"];
  do {
    const page = await tx.scanEntries({ conversationId: id }, 100, cursor);
    if (
      page.items.some(
        (entry) =>
          entry.conversationId === id &&
          entry.kind === "bots.agent" &&
          typeof entry.data === "object" &&
          entry.data !== null &&
          !Array.isArray(entry.data) &&
          entry.data.parentConversationId === parent,
      )
    )
      return true;
    cursor = page.next;
  } while (cursor !== undefined);
  return false;
}

const result = (outcome: ToolOutcome) => ({
  output: [{ type: "text" as const, text: outcome.output }],
  ...(outcome.isError === true ? { isError: true } : {}),
});

const agentId = (value: string): ConversationId | undefined => {
  const parsed = Number(value.replace(/^c_/, ""));
  return Number.isSafeInteger(parsed) && parsed > 0 ? (parsed as ConversationId) : undefined;
};

/** The text of one committed message entry, as the child's answer. */
const entryText = (record: { model?: unknown } | undefined): string => {
  const messages = (record as { model?: readonly { content?: unknown }[] } | undefined)?.model;
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        const text = (block as { type?: string; text?: unknown }).text;
        if (typeof text === "string") parts.push(text);
      }
    }
  }
  return parts.join("\n").trim();
};

export const createAgentTools = (
  childExtensions: readonly string[],
): readonly ToolRegistration[] => {
  const admissions = new Map<ConversationId, Set<AbortController>>();
  async function admit<T>(
    id: ConversationId,
    context: Context,
    action: (context: Context) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const admissionContext = withAbortSignal(controller.signal, context);
    const pending = admissions.get(id) ?? new Set<AbortController>();
    pending.add(controller);
    admissions.set(id, pending);
    try {
      // An admission a person stopped before it submitted must never reach the child.
      if (admissionContext.abortSignal?.aborted) throw new Error("agent_send_cancelled");
      return await action(admissionContext);
    } finally {
      pending.delete(controller);
      if (pending.size === 0) admissions.delete(id);
    }
  }
  return [
    defineTool({
      name: "agent_spawn",
      description:
        "Start a child agent that works on its own and remembers its own conversation. Returns its id; pass that id to agent_send and agent_stop. The child has the same model and reasoning level as you, and only the coding tools plus list: it cannot start children, ask the person, write the sidebar line, use an optional group, load deferred tools or reach another machine.",
      parameters: Type.Object({
        name: Type.String({
          description: "Short name for the child, for your notes and the run log",
        }),
        instructions: Type.Optional(
          Type.String({ description: "Extra standing instructions for this child only" }),
        ),
      }),
      execute: async (args, api, context) => {
        const parent = await api.agent(context);
        const extensions = parent.extensions.filter((extension) =>
          childExtensions.includes(extension.name),
        );
        const callable = new Set(
          extensions.flatMap((extension) => (extension.tools ?? []).map((tool) => tool.name)),
        );
        const tools = parent.tools.filter(
          (tool) =>
            callable.has(tool.name) &&
            !(CHILD_DENIED_TOOLS as readonly string[]).includes(tool.name),
        );
        const child = await api.commit(async (tx) => {
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await configure(tx, created.id, {
            ...(parent.model === undefined ? {} : { model: parent.model }),
            thinkingLevel: parent.thinkingLevel,
            extensions,
            tools,
            ...(args.instructions === undefined
              ? parent.instructions === undefined
                ? {}
                : { instructions: parent.instructions }
              : { instructions: args.instructions }),
            ...(parent.cwd === undefined ? {} : { cwd: parent.cwd }),
          });
          // A marker entry, so a later listing can tell a child apart from a conversation a
          // person created; it carries no `model`, so the child never sees it.
          await tx.appendEntry(created.id, {
            kind: "bots.agent",
            data: {
              name: args.name,
              parentConversationId: api.conversationId,
              createdAt: api.now(),
            },
          });
          return created;
        }, context);
        return result({
          output: `child ${args.name} started as c_${child.id}; pass c_${child.id} to agent_send`,
        });
      },
    }),
    defineTool({
      name: "agent_send",
      description:
        "Send a message to a child agent and wait for its answer. Returns the child's final text, or a failure with the settlement status when it did not answer.",
      parameters: Type.Object({
        agentId: Type.String({ description: "The id agent_spawn returned, for example c_12" }),
        message: Type.String({ description: "What the child should do" }),
      }),
      execute: async (args, api, context) => {
        const id = agentId(args.agentId);
        if (id === undefined) return result(failed(`unknown child agent ${args.agentId}`));
        const submit = async (admissionContext: Context) => {
          const ensureActive = () => {
            if (admissionContext.abortSignal?.aborted) throw new Error("agent_send_cancelled");
          };
          const child = await api.conversation(id, admissionContext);
          ensureActive();
          if (!child) return undefined;
          const managed = await api.commit(
            (tx) => managedChild(tx, id, api.conversationId),
            admissionContext,
          );
          ensureActive();
          if (!managed) return undefined;
          return child.submit(
            {
              type: "input",
              content: args.message,
              requestId: `agent:${api.taskId}:${id}:${api.now()}`,
              whenBusy: "followUp",
            },
            admissionContext,
          );
        };
        const submission = await admit(id, context, submit);
        if (!submission) return result(failed(`unknown child agent ${args.agentId}`));
        const settled = await submission.wait(context);
        if (settled.status !== "done") {
          const reason = settled.reason === undefined ? "" : ` (${settled.reason})`;
          return result(failed(`the child did not answer${reason}`));
        }
        const answerEntryId = settled.answer ?? settled.entry;
        const record =
          answerEntryId === undefined
            ? undefined
            : await api.commit((tx) => tx.entry(answerEntryId), context);
        const text = entryText(record);
        return result({ output: text.length > 0 ? text : "the child answered without text" });
      },
    }),
    defineTool({
      name: "agent_stop",
      description: "Stop a child agent: its queued work is withdrawn and it stays readable.",
      parameters: Type.Object({
        agentId: Type.String({ description: "The id agent_spawn returned" }),
      }),
      execute: async (args, api, context) => {
        const id = agentId(args.agentId);
        const child = id === undefined ? undefined : await api.conversation(id, context);
        if (child === undefined || id === undefined)
          return result(failed(`unknown child agent ${args.agentId}`));
        for (const controller of admissions.get(id) ?? []) controller.abort();
        await child.abort(context);
        return result({ output: `child ${args.agentId} stopped` });
      },
    }),
  ];
};

export const agentsSection = (): string =>
  [
    "You can delegate a self-contained piece of work to a child agent.",
    "Start one with agent_spawn, give it work with agent_send, and stop it with agent_stop.",
    "A child has its own conversation and the same model, but only the coding tools plus list: it cannot delegate, ask the person, use an optional group or reach another machine.",
    "Prefer doing the work yourself when it is short: a child costs another model request.",
  ].join("\n");

/** `childExtensions` are the extension names a child may select: the mandatory groups. */
export const agentsExtension = (childExtensions: readonly string[]): Extension =>
  defineExtension({
    name: AGENTS_TOOLS_EXTENSION,
    tools: createAgentTools(childExtensions),
    sections: [section("bots-agents", () => agentsSection())],
  });
