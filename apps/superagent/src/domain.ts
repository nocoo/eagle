export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  state: "complete" | "streaming" | "error" | "aborted";
  createdAt: number;
  requestId?: string;
};

export type Configuration = {
  baseUrl: string;
  model: string;
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  apiKey: string;
};
export type PublicConfiguration = Omit<Configuration, "apiKey"> & { hasApiKey: boolean };
export type ConfigurationInput = Omit<Configuration, "apiKey"> & { apiKey?: string };

export type Submission = {
  id: string;
  requestId: string;
  status: "queued" | "placed" | "done" | "unanswered";
  entryId?: string;
  answerEntryId?: string;
  answer?: string;
  reason?: string;
};

export type FailureCode =
  | "storage_failed"
  | "task_parked"
  | "model_timeout"
  | "model_authentication"
  | "model_error";
export type Failure = { code: FailureCode; id: string };

export type Snapshot = {
  botId: "superagent";
  messages: Message[];
  pending: { id: string; requestId: string; text: string }[];
  running: boolean;
  modelReady: boolean;
  configuration: PublicConfiguration | null;
  window: {
    oldestEntryId: number | null;
    newestEntryId: number | null;
    coverage: "window";
    hasOlder: boolean;
  };
  failure?: Failure;
};
export type HistoryPage = {
  messages: Message[];
  hasMore: boolean;
  nextBefore?: number;
  coverage: "complete" | "partial";
};
export type ErrorCode =
  | "invalid_command"
  | "unauthorized"
  | "unconfigured"
  | "busy"
  | "limit_exceeded"
  | "storage_failed"
  | "internal"
  | "shutting_down"
  | "cancellation_unconfirmed"
  /** SG-003: this suggestion already has its one decision. */
  | "decision_exists";

export class ServiceError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode) {
    super(code);
    this.code = code;
  }
}

export const MAX_INPUT = 8000;
export const MAX_PENDING = 16;
export const MAX_FRAME = 256 * 1024;
export const MAX_PAGE = 192 * 1024;
export const MAX_MESSAGES = 100;
export const emptySnapshot = (): Snapshot => ({
  botId: "superagent",
  messages: [],
  pending: [],
  running: false,
  modelReady: false,
  configuration: null,
  window: { oldestEntryId: null, newestEntryId: null, coverage: "window", hasOlder: false },
});
