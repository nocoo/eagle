// The runtime boundary (docs/bots/ARCHITECTURE.md, "Ports"). A runtime translates its
// own behaviour into these events; it never numbers revisions, encodes frames or knows
// the catalog.
import type {
  AgentView,
  BusyMode,
  ConversationSnapshot,
  DeltaChange,
  ErrorKind,
  Message,
  PullSummary,
  Submission,
  TaskSummary,
  TriggerSummary,
  Usage,
} from "./domain.ts";

export { INVOCATION_ID, MAX_INVOCATION_TEXT } from "./Invocation.ts";

export type RuntimeEvent = { readonly trace: string } & (
  | { readonly type: "append"; readonly message: Message; readonly replaces?: string }
  | { readonly type: "delta"; readonly messageId: string; readonly changes: readonly DeltaChange[] }
  | {
      readonly type: "status";
      readonly running: boolean;
      readonly streaming: string | null;
      readonly inbox: readonly {
        readonly id: string;
        readonly mode: "followUp" | "steer" | "queue";
      }[];
    }
  | { readonly type: "submission"; readonly record: Submission }
  | { readonly type: "tasks"; readonly tasks: readonly TaskSummary[] }
  | { readonly type: "triggers"; readonly triggers: readonly TriggerSummary[] }
  | { readonly type: "pulls"; readonly pulls: readonly PullSummary[] }
  | { readonly type: "usage"; readonly usage: Usage }
  | { readonly type: "agent"; readonly agent: AgentView }
  | { readonly type: "snapshot"; readonly value: ConversationSnapshot }
  | {
      readonly type: "error";
      readonly failure: {
        readonly id: string;
        readonly kind: ErrorKind;
        readonly layer: "runtime" | "pi";
      };
      readonly message: string;
      readonly taskId?: string;
    }
);

export type RuntimeBotSpec = {
  readonly id: string;
  readonly dir: string;
  readonly model: { readonly provider: string; readonly modelId: string };
  /** A bot's stored reasoning level, when it has one; the runtime applies it per bot. */
  readonly thinkingLevel?: string;
  /** The tool groups this bot was given; `core` and `coding` are always included. */
  readonly toolGroups?: readonly string[];
  readonly trace: string;
};

export type SubmitInput = {
  readonly requestId: string;
  readonly text: string;
  readonly contextId?: string;
  readonly resourceHead?: string;
  readonly whenBusy: BusyMode;
  readonly trace: string;
};

export type RuntimeSubscription = {
  readonly snapshot: ConversationSnapshot;
  detach(): void;
};

export type RuntimeHistory = {
  readonly messages: readonly Message[];
  readonly hasMore: boolean;
};

/** P0's dedicated local history body limit; ordinary API/frame limits are unchanged. */
export const MAX_REPLICA_BODY_BYTES = 8 * 1024 * 1024;

export interface RuntimeHandle {
  /** Local P0 history handoff; passive import is distinct from a new local run. */
  replica?(command: {
    readonly method:
      | "export"
      | "import"
      | "run"
      | "status"
      | "bind"
      | "pull"
      | "apply"
      | "receipts"
      | "merge"
      | "heads"
      | "head"
      | "context";
    readonly params: unknown;
    readonly trace: string;
    /** Internal synchronization use-point check; never accepted from wire params. */
    readonly guard?: () => void;
    readonly expectedBinding?: {
      localBotId: string;
      sharedBotId: string;
      replicaId: string;
      epoch: string;
    };
  }): Promise<unknown>;
  refreshTools(trace: string): Promise<void>;
  /** A durable local context on this same open Harness; never opens another runtime. */
  context?(contextId: string, trace: string): Promise<RuntimeHandle>;
  /** Read-only persisted queued/placed work across this Bot's shared Harness, including unopened contexts. */
  outstanding?(trace: string): Promise<readonly Submission[]>;
  /** Atomic: the view at attachment plus every later commit, with nothing lost between. */
  subscribe(trace: string, sink: (event: RuntimeEvent) => void): Promise<RuntimeSubscription>;
  /** Idempotent by requestId; returns the submission's current record. */
  submit(input: SubmitInput): Promise<Submission>;
  submission(
    key:
      | { submissionId: string }
      | {
          requestId: string;
          contextId?: string;
          retry?: Pick<SubmitInput, "whenBusy" | "trace" | "contextId">;
        },
  ): Promise<Submission | undefined>;
  /** One committed message by entry id: how a peer reads the answer it was pointed at. */
  entryById?(entryId: string): Promise<Message | undefined>;
  /** Older messages, oldest first. The trace names the command that asked for them. */
  history(input: {
    beforeEntryId?: string;
    limit: number;
    trace?: string;
  }): Promise<RuntimeHistory>;
  abort(trace: string): Promise<void>;
  /** Retries parked work; never aborts a running answer. */
  recover(trace: string): Promise<void>;
  /** Runs one parked task again, by its wire id (`t_<n>`). */
  retryTask?(taskId: string, trace: string): Promise<void>;
  /** Stops one live task, by its wire id; the conversation keeps everything it committed. */
  abortTask?(taskId: string, trace: string): Promise<void>;
  busy(): Promise<{ run: boolean; tasks: boolean }>;
  /** Gateway settings changed: move a live conversation to the new model in place. */
  configureModel?(
    model: { readonly provider: string; readonly modelId: string },
    trace: string,
  ): Promise<void>;
  /** Gateway settings changed: move a live conversation to the new reasoning level. */
  configureThinkingLevel?(thinkingLevel: string, trace: string): Promise<void>;
  /** Gateway settings changed: keep only the chosen tool groups' extensions. */
  configureToolGroups?(toolGroups: readonly string[], trace: string): Promise<void>;
  close(trace: string, deadlineMs: number): Promise<"closed" | "timeout">;
}

export interface RuntimePort {
  readReplicaBinding?(
    spec: Pick<RuntimeBotSpec, "id" | "dir">,
  ): Promise<
    { sharedBotId: string; localBotId?: string; replicaId?: string; epoch?: string } | undefined
  >;
  open(spec: RuntimeBotSpec): Promise<RuntimeHandle>;
}
