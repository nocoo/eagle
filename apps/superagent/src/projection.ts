import type { Message as PiMessage } from "@earendil-works/pi-ai";
import type {
  ConversationView,
  EntryRecord,
  InboxState,
  LiveState,
} from "@earendil-works/pi-durable";
import { MAX_MESSAGES, MAX_PAGE, type Message, type Snapshot } from "./domain.ts";
import { modelFailure } from "./failure.ts";

export const boundedText = (text: string, limit = 32000) => {
  const points = Array.from(text);
  return points.length > limit ? `${points.slice(0, limit).join("")}\n[truncated]` : text;
};

function messageText(message: PiMessage): string {
  if (typeof message.content === "string") return boundedText(message.content);
  return boundedText(
    message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""),
  );
}

const CHAT_KINDS = new Set(["pi.user", "pi.assistant", "superagent.input"]);

export function entryMessage(entry: EntryRecord): Message | undefined {
  if (!CHAT_KINDS.has(entry.kind)) return undefined;
  const message = entry.model?.[0];
  if (!message || (message.role !== "user" && message.role !== "assistant")) return undefined;
  const state =
    message.role === "assistant" && message.stopReason === "error"
      ? "error"
      : message.role === "assistant" && message.stopReason === "aborted"
        ? "aborted"
        : "complete";
  const requestId =
    typeof entry.data === "object" &&
    entry.data !== null &&
    !Array.isArray(entry.data) &&
    typeof entry.data.requestId === "string"
      ? entry.data.requestId
      : undefined;
  return {
    id: `e_${entry.id}`,
    role: message.role,
    text: state === "error" ? "The model could not finish this answer." : messageText(message),
    state,
    createdAt: message.timestamp,
    ...(requestId === undefined ? {} : { requestId }),
  };
}

export function fitMessages(messages: Message[]): Message[] {
  const kept = messages.slice(-MAX_MESSAGES);
  while (kept.length > 0 && Buffer.byteLength(JSON.stringify(kept)) > MAX_PAGE) kept.shift();
  return kept;
}

export function project(view: ConversationView, base: Snapshot): Snapshot {
  const live = (view.docs["pi.live"] ?? {}) as LiveState;
  const inbox = (view.docs["pi.inbox"] ?? { items: [] }) as InboxState;
  const messages = view.entries.flatMap((entry) => {
    const message = entryMessage(entry);
    return message ? [message] : [];
  });
  const partial = live.generation?.message;
  if (partial)
    messages.push({
      id: `p_${live.generation?.attempt ?? 0}`,
      role: "assistant",
      text: messageText(partial),
      state: "streaming",
      createdAt: partial.timestamp,
    });
  const pending = inbox.items.flatMap((item) => {
    if (item.mode === "write") return [];
    const data = item.entry?.data as { requestId?: string } | undefined;
    const content = typeof item.content === "string" ? item.content : "Queued message";
    return [
      { id: `s_${item.id}`, requestId: data?.requestId ?? "", text: boundedText(content, 160) },
    ];
  });
  const fitted = fitMessages(messages);
  const committed = fitted.filter((message) => message.id.startsWith("e_"));
  const last = view.entries.toReversed().find((entry) => entry.model?.[0]?.role === "assistant");
  const lastMessage = last?.model?.[0];
  const { failure: previous, ...rest } = base;
  const failure =
    previous?.code === "storage_failed" || previous?.code === "task_parked"
      ? previous
      : lastMessage?.role === "assistant" && lastMessage.stopReason === "error" && !live.run
        ? { code: modelFailure(lastMessage.errorMessage), id: `model_e_${last?.id}` }
        : undefined;
  return {
    ...rest,
    messages: fitted,
    pending,
    running: live.run !== undefined,
    window: {
      oldestEntryId: committed[0] ? Number(committed[0].id.slice(2)) : null,
      newestEntryId: committed.at(-1) ? Number(committed.at(-1)?.id.slice(2)) : null,
      coverage: "window",
    },
    ...(failure === undefined ? {} : { failure }),
  };
}
