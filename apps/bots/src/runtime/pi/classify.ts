// Failure classification (docs/bots/RUNTIME.md, "Failure channels"). pi reports trouble
// through four channels that can describe the same underlying failure, so only this
// module mints a failure identity, once per episode key, and the channels merely carry
// the classification.

import type { ReportInfo, SessionEnd, WatchEnd } from "@earendil-works/pi-durable";
import type { ErrorKind } from "../../core/domain.ts";

/** A failure the adapter mints: its layer is always one of the two adapter layers. */
export type AdapterFailure = {
  readonly id: string;
  readonly kind: ErrorKind;
  readonly layer: "runtime" | "pi";
};

/** A failure as the adapter reports it: the identity, its kind, and a content-free text. */
export type Classification = {
  readonly failure: AdapterFailure;
  readonly message: string;
  readonly reason?: string;
};

/** A classification, and whether this notification is the one that minted it. */
export type Minted = {
  readonly classification: Classification;
  readonly minted: boolean;
};

/** Fixed texts: a report's own message can echo model output, so it never travels. */
const MESSAGE: Readonly<Record<ErrorKind, string>> = {
  auth_failed: "the model endpoint refused the credentials",
  // Transport-only kinds: the adapter never mints them, but the map stays total.
  auth_scope: "the credential may not do that",
  client_active: "the client is still active",
  unknown_bot: "the bot is unknown",
  invalid_command: "the command was refused",
  limit_exceeded: "the bot is at its queue limit",
  version_mismatch: "the protocol version is not served",
  model_error: "the model request failed",
  session_failed: "the session failed",
  task_faulted: "a task failed",
  task_parked: "a task was parked after repeated interruptions",
  extension_error: "an extension failed",
  storage_failed: "the session storage failed",
  internal: "an internal failure",
};

const LISTENER_WINDOW_MS = 60_000;
/** The first two listener-error episodes of a window are recoverable; the third mints one. */
const LISTENER_ESCALATE_AT = 3;

/**
 * Failure identities are unique for the process, not for one Harness: two bots, or one
 * bot reopened, must never report the same id (docs/bots/OBSERVABILITY.md, dedupe unit).
 */
let nextFailureId = 0;

export type ClassifierOptions = {
  readonly now?: () => number;
};

export class FailureClassifier {
  readonly #now: () => number;
  readonly #episodes = new Map<string, Classification>();
  #generation = 1;
  #reports = 0;
  #escalations = 0;
  /** One entry per listener-error episode: several notifications share one key. */
  readonly #listenerEpisodes = new Map<string, number>();

  constructor(options: ClassifierOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** The harness episode: a reopen starts a new one, so a later failure is a new identity. */
  get generation(): number {
    return this.#generation;
  }

  nextGeneration(): number {
    this.#generation += 1;
    this.#listenerEpisodes.clear();
    return this.#generation;
  }

  /** Mints once per episode key; a repeated notification gets the existing identity. */
  classify(key: string, kind: ErrorKind, layer: "runtime" | "pi"): Minted {
    const known = this.#episodes.get(key);
    if (known !== undefined) return { classification: known, minted: false };
    nextFailureId += 1;
    const classification: Classification = {
      failure: { id: `f_${nextFailureId}`, kind, layer },
      message: MESSAGE[kind],
      reason: kind,
    };
    this.#episodes.set(key, classification);
    return { classification, minted: true };
  }

  /** A task that faulted while running, deduped against the same task's report. */
  taskFailed(event: { readonly taskId: string; readonly kind: string }): Minted {
    return this.classify(`task:${event.taskId}`, "task_faulted", "pi");
  }

  /**
   * `HarnessOptions.onReport`; the channel never mints on its own. `episode` names the
   * stream a listener failure belongs to, so its two notifications count once.
   */
  report(info: ReportInfo, episode = "report"): Minted | undefined {
    this.#reports += 1;
    switch (info.type) {
      case "task_parked":
        return this.classify(`task:${info.task.id}`, "task_parked", "pi");
      case "task_faulted":
        return this.classify(`task:${info.task.id}`, "task_faulted", "pi");
      case "task_error":
        return this.classify(`task:${info.task.id}`, "task_faulted", "pi");
      case "migration_failed":
      case "task_outdated":
        return this.classify(`task:${info.task.id}`, "internal", "pi");
      case "extension_error":
        // Without a task there is no correlation key, so each report is its own episode
        // (RUNTIME.md: "taskId when present, else the report's sequence").
        return this.classify(
          info.task === undefined ? `report:${this.#reports}` : `task:${info.task.id}`,
          "extension_error",
          "pi",
        );
      case "host_error":
        return this.classify(`host:${info.callback}`, "internal", "pi");
      case "session_failed":
        return this.#sessionFailed();
      case "listener_error":
        return this.listenerError(episode);
    }
  }

  /**
   * A watch that ended. Only `listener_error` and `session_failed` are faults; both
   * notifications of one listener failure pass the same `episode` key, so one fault
   * counts once.
   */
  watchEnd(end: WatchEnd, episode = "listener:0"): Minted | undefined {
    if (end.reason === "listener_error") return this.listenerError(episode);
    if (end.reason === "session_failed") return this.#sessionFailed();
    return undefined;
  }

  /** Counts one listener-error episode; the third inside a minute escalates once. */
  listenerError(episode: string): Minted | undefined {
    const now = this.#now();
    for (const [key, at] of this.#listenerEpisodes) {
      if (now - at >= LISTENER_WINDOW_MS) this.#listenerEpisodes.delete(key);
    }
    if (this.#listenerEpisodes.has(episode)) return undefined;
    this.#listenerEpisodes.set(episode, now);
    if (this.#listenerEpisodes.size < LISTENER_ESCALATE_AT) return undefined;
    if (this.#listenerEpisodes.size % LISTENER_ESCALATE_AT !== 0) return undefined;
    this.#escalations += 1;
    // An escalated listener is a runtime failure, not a pi one: the stream we failed to
    // keep up with belongs to the adapter.
    return this.classify(`listener-escalation:${this.#escalations}`, "internal", "runtime");
  }

  /** `harness.closed`: a close we asked for is not a failure, a failed session is. */
  sessionEnd(end: SessionEnd): Minted | undefined {
    return end.reason === "failed" ? this.#sessionFailed() : undefined;
  }

  /**
   * The session failure already reported for this harness, if any: a submit that fails
   * while the session is failing must reuse that identity, not mint a second one.
   */
  sessionEpisode(): Minted | undefined {
    const known = this.#episodes.get(`harness:${this.#generation}`);
    return known === undefined ? undefined : { classification: known, minted: false };
  }

  /** A submit the daemon refused before admission: the client keeps its text. */
  refusedBusy(): Minted {
    return this.classify("submit:busy", "limit_exceeded", "runtime");
  }

  /** Adapter operations share session failures with reports and watch termination. */
  operationFailed(operation: "submit" | "tools", cause: unknown): Minted {
    // A failed session is one episode key, whichever channel reports it first. Whichever
    // gets there first owns the record, so the layer of the identity is that channel's.
    if (isSessionFailure(cause))
      return this.classify(`harness:${this.#generation}`, "storage_failed", "runtime");
    return this.classify(`${operation}:${this.#generation}`, "internal", "runtime");
  }

  #sessionFailed(): Minted {
    return this.classify(`harness:${this.#generation}`, "storage_failed", "pi");
  }
}

const isSessionFailure = (cause: unknown): boolean =>
  cause instanceof Error && cause.name === "SessionFailed";
