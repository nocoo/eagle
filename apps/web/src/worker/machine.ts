import { DurableObject } from "cloudflare:workers";
import { changesBetween } from "../../../../packages/contracts/src/assessment.ts";
import type { Registration } from "../../../../packages/contracts/src/connect.ts";
import type {
  MachineView,
  Report,
} from "../../../../packages/contracts/src/schema.ts";
import { agentTokens } from "./auth.ts";
import { LiveRelay } from "./realtime.ts";

/** Current deterministic state for one machine plus the live relay. */
export class MachineState extends DurableObject<Env> {
  private live = new LiveRelay(this.ctx, (id) => this.authorized(id));
  fetch(request: Request) {
    const role = request.headers.get("x-live-role");
    if (role !== "agent" && role !== "viewer")
      return new Response(null, { status: 403 });
    const expires = Number(request.headers.get("x-live-expires"));
    const credentialId = request.headers.get("x-live-credential");
    const spaceId = request.headers.get("x-live-space") ?? undefined;
    if (role === "viewer") {
      const current = this.current();
      const config = this.ctx.storage.kv.get<Registration>("registration");
      if (
        config?.enabled === false ||
        !current?.report.spaces.some((s) => s.id === spaceId && !s.availability)
      )
        return new Response(null, { status: 404 });
    }
    return this.live.connect(
      role,
      expires,
      credentialId,
      spaceId,
      request.headers.get("x-live-format") === "styled-text-v1",
    );
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    this.live.message(socket, message);
  }
  webSocketClose(socket: WebSocket, code: number, reason: string) {
    try {
      // Reserved local-only codes (notably abrupt-disconnect 1006) cannot be sent.
      socket.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
    } finally {
      this.live.close(socket);
    }
  }
  webSocketError(socket: WebSocket) {
    try {
      socket.close(1011, "Connection failed");
    } finally {
      this.live.close(socket);
    }
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS receipts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      report_id TEXT NOT NULL UNIQUE,
      digest TEXT NOT NULL
    )`);
  }

  current(): MachineView | null {
    const state = this.ctx.storage.kv.get<MachineView>("current");
    const config = this.ctx.storage.kv.get<Registration>("registration");
    return state
      ? {
          ...state,
          name: config?.name ?? state.name,
        }
      : null;
  }

  registration(id: string): Registration | null {
    const stored = this.ctx.storage.kv.get<Registration>("registration");
    return (
      (stored ? { ...stored, watchPorts: stored.watchPorts ?? [] } : null) ??
      (Object.hasOwn(agentTokens(this.env), id)
        ? {
            id,
            name: this.current()?.name ?? id,
            source: "legacy",
            enabled: true,
            credentialId: null,
            createdAt: null,
            rotatedAt: null,
            expiresAt: null,
            watchPorts:
              this.current()?.report.machine.telemetry?.ports.map(
                ({ name, host, port }) => ({ name, host, port }),
              ) ?? [],
          }
        : null)
    );
  }

  configure(
    id: string,
    action: "create" | "rotate" | "rename" | "revoke",
    name?: string,
    watchPorts?: Registration["watchPorts"],
  ): Registration | null {
    const previous = this.registration(id);
    if (action === "create" ? previous !== null : previous === null)
      return null;
    const now = new Date().toISOString();
    const issue = action === "create" || action === "rotate";
    const machine: Registration = {
      id,
      watchPorts: watchPorts ?? previous?.watchPorts ?? [],
      name: name ?? previous?.name ?? id,
      source: issue ? "managed" : (previous?.source ?? "managed"),
      enabled: issue || (action !== "revoke" && !!previous?.enabled),
      credentialId: issue
        ? crypto.randomUUID()
        : (previous?.credentialId ?? null),
      createdAt: previous?.createdAt ?? now,
      rotatedAt: issue ? now : (previous?.rotatedAt ?? null),
      expiresAt: issue
        ? new Date(Date.now() + 365 * 86400_000).toISOString()
        : (previous?.expiresAt ?? null),
    };
    this.ctx.storage.kv.put("registration", machine);
    if (issue || action === "revoke") this.live.revoke();
    return machine;
  }

  forget(): boolean {
    const stored = this.ctx.storage.kv.get<Registration>("registration");
    if (!stored || stored.enabled) return false;
    this.ctx.storage.kv.delete("registration");
    return true;
  }

  private authorized(credentialId: string | null): boolean {
    const config = this.ctx.storage.kv.get<Registration>("registration");
    if (!config) return credentialId === null;
    return (
      config.enabled &&
      config.credentialId === credentialId &&
      (!config.expiresAt || Date.parse(config.expiresAt) > Date.now())
    );
  }

  ingest(report: Report, digest: string, credentialId: string | null = null) {
    if (!this.authorized(credentialId)) return { unauthorized: true } as const;
    return this.ctx.storage.transactionSync(() => {
      const sql = this.ctx.storage.sql;
      const previous = this.current();
      const now = new Date().toISOString();
      const receipt = sql
        .exec<{ seq: number; digest: string }>(
          "SELECT seq, digest FROM receipts WHERE report_id = ?",
          report.reportId,
        )
        .toArray()[0];
      if (receipt && receipt.digest !== digest)
        return { conflict: true } as const;
      const seq =
        receipt?.seq ??
        sql
          .exec<{ seq: number }>(
            "INSERT INTO receipts(report_id, digest) VALUES(?, ?) RETURNING seq",
            report.reportId,
            digest,
          )
          .one().seq;
      const newer =
        !previous ||
        report.capturedAt > previous.report.capturedAt ||
        (report.capturedAt === previous.report.capturedAt &&
          report.reportId > previous.report.reportId);
      const changes = newer
        ? changesBetween(previous?.report ?? null, report)
        : [];
      const current: MachineView = newer
        ? {
            id: report.machine.id,
            name: report.machine.name,
            report,
            receivedAt: now,
            lastSeen: now,
            warning: null,
            revision: (previous?.revision ?? 0) + 1,
            changes: changes.length ? changes : (previous?.changes ?? []),
            changedAt: changes.length
              ? report.capturedAt
              : (previous?.changedAt ?? null),
          }
        : { ...previous, lastSeen: now, revision: previous.revision + 1 };
      this.ctx.storage.kv.put("current", current);
      return { accepted: true, duplicate: !!receipt, seq } as const;
    });
  }

  async alarm() {
    this.live.sweep();
    await this.live.schedule();
  }

  heartbeat(warning?: string, credentialId: string | null = null) {
    if (!this.authorized(credentialId)) return { unauthorized: true } as const;
    const current = this.current();
    if (!current) return false;
    this.ctx.storage.kv.put("current", {
      ...current,
      lastSeen: new Date().toISOString(),
      warning: warning ?? current.warning,
      revision: current.revision + 1,
    });
    return true;
  }
}
