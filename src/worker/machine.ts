import { DurableObject } from "cloudflare:workers";
import { changesBetween } from "../shared/assessment.ts";
import type { Registration } from "../shared/connect.ts";
import {
  type DailyJob,
  type DailyReport,
  dailyCutoff,
  dailyStart,
  sampleHour,
} from "../shared/daily.ts";
import { compactHour, utcHour } from "../shared/report-input.ts";
import type { MachineView, Report } from "../shared/schema.ts";
import {
  canonical,
  type ManagerState,
  type PaneSummary,
  paneKey,
  type SummaryBatch,
  semanticContent,
  taskKey,
} from "../shared/summaries.ts";
import { agentTokens } from "./auth.ts";
import { LiveRelay, scheduleEarlier } from "./realtime.ts";

type Facts = Record<string, import("../shared/schema.ts").Evidence>;
type DailyState = DailyJob & {
  lease: string | null;
  expires: number;
  version: string;
  pending: DailyReport | null;
  completedVersion: string | null;
};
type SemanticRow = {
  seq: number;
  hour: string;
  content_hash: string;
  source: string;
  received_at: string;
  payload: string;
};
const RETENTION_DAYS = 30;
const MAX_RECORDS = 10000;
const unpack = (row: SemanticRow) => ({
  seq: row.seq,
  hour: row.hour,
  contentHash: row.content_hash,
  source: JSON.parse(row.source),
  receivedAt: row.received_at,
  value: JSON.parse(row.payload) as PaneSummary,
});

/** Current state plus separate semantic and short-lived hourly input streams. */
export class MachineState extends DurableObject<Env> {
  private live = new LiveRelay(this.ctx, this.env, (id) => this.authorized(id));
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
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS summary_receipts (sequence INTEGER PRIMARY KEY, digest TEXT NOT NULL)`,
    );
    ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS summary_outbox (event_id TEXT PRIMARY KEY, machine_id TEXT, space_id TEXT, pane_id TEXT, task_id TEXT, received_at TEXT, payload TEXT)`,
    );
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS semantic_records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
      hour TEXT NOT NULL, space_id TEXT NOT NULL, pane_id TEXT NOT NULL, task_id TEXT NOT NULL,
      sequence INTEGER NOT NULL, observed_at TEXT NOT NULL, received_at TEXT NOT NULL,
      content_hash TEXT NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS semantic_hours ON semantic_records(hour DESC,seq DESC);
    CREATE INDEX IF NOT EXISTS semantic_pane_hours ON semantic_records(space_id,pane_id,hour DESC,observed_at DESC,seq DESC);
    CREATE TABLE IF NOT EXISTS semantic_current (space_id TEXT,pane_id TEXT,task_id TEXT,observed_at TEXT,received_at TEXT,payload TEXT,PRIMARY KEY(space_id,pane_id,task_id));
    CREATE TABLE IF NOT EXISTS fact_evidence (pane_key TEXT,hash TEXT,task_id TEXT,received_at TEXT,payload TEXT,PRIMARY KEY(pane_key,hash));
    CREATE INDEX IF NOT EXISTS fact_retention ON fact_evidence(received_at);
    CREATE INDEX IF NOT EXISTS semantic_retention ON semantic_records(received_at);`);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS live_tasks(space_id TEXT,pane_id TEXT,task_id TEXT,PRIMARY KEY(space_id,pane_id))",
    );
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS hourly_facts (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, report_id TEXT UNIQUE NOT NULL,
      hour TEXT NOT NULL, captured_at TEXT NOT NULL, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS hourly_fact_hours ON hourly_facts(hour,seq);
    CREATE TABLE IF NOT EXISTS daily_jobs (date TEXT PRIMARY KEY, payload TEXT NOT NULL);
    DROP TABLE IF EXISTS hourly_jobs;
    DROP TABLE IF EXISTS hourly_steps;`);
  }

  current(): MachineView | null {
    const state = this.ctx.storage.kv.get<MachineView>("current");
    const config = this.ctx.storage.kv.get<Registration>("registration");
    return state
      ? {
          ...state,
          name: config?.name ?? state.name,
          summaries: state.report.spaces.flatMap((space) =>
            space.tabs.flatMap((tab) =>
              tab.panes.flatMap((pane) => {
                const row = this.ctx.storage.sql
                  .exec<{ payload: string }>(
                    "SELECT payload FROM semantic_current WHERE space_id=? AND pane_id=? ORDER BY (task_id=?) DESC,observed_at DESC LIMIT 1",
                    space.id,
                    pane.id,
                    pane.task.id,
                  )
                  .toArray()[0];
                return row ? [JSON.parse(row.payload) as PaneSummary] : [];
              }),
            ),
          ),
          manager: this.ctx.storage.kv.get<ManagerState>("manager") ?? null,
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

  private authorized(credentialId: string | null): boolean {
    const config = this.ctx.storage.kv.get<Registration>("registration");
    if (!config) return credentialId === null;
    return (
      config.enabled &&
      config.credentialId === credentialId &&
      (!config.expiresAt || Date.parse(config.expiresAt) > Date.now())
    );
  }

  ingest(
    report: Report,
    digest: string,
    credentialId: string | null = null,
    factKeys: Record<
      string,
      Record<string, import("../shared/schema.ts").Evidence>
    > = {},
  ) {
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
      if (
        !receipt &&
        Date.parse(report.capturedAt) >= Date.now() - 48 * 3600000
      )
        sql.exec(
          "INSERT OR IGNORE INTO hourly_facts(report_id,hour,captured_at,payload) VALUES(?,?,?,?)",
          report.reportId,
          utcHour(report.capturedAt),
          report.capturedAt,
          JSON.stringify(report),
        );
      sql.exec(
        "DELETE FROM hourly_facts WHERE hour < ?",
        utcHour(Date.now() - 48 * 3600000),
      );
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
      if (newer) {
        this.ctx.storage.kv.put("fact-keys", factKeys);
        this.ctx.storage.sql.exec("DELETE FROM live_tasks");
        for (const space of report.spaces.filter((s) => !s.availability))
          for (const pane of space.tabs.flatMap((t) => t.panes))
            this.ctx.storage.sql.exec(
              "INSERT INTO live_tasks VALUES(?,?,?)",
              space.id,
              pane.id,
              pane.task.id,
            );
        for (const [key, records] of Object.entries(factKeys))
          for (const [hash, evidence] of Object.entries(records))
            this.ctx.storage.sql.exec(
              "INSERT INTO fact_evidence VALUES(?,?,?,?,?) ON CONFLICT(pane_key,hash) DO UPDATE SET received_at=excluded.received_at,payload=excluded.payload",
              key,
              hash,
              evidence.taskId,
              now,
              JSON.stringify(evidence),
            );
        this.prune(now);
      }
      const { summaries: _summaries, manager: _manager, ...facts } = current;
      this.ctx.storage.kv.put("current", facts);
      return { accepted: true, duplicate: !!receipt, seq } as const;
    });
  }

  agentCurrent(credentialId: string | null) {
    return this.authorized(credentialId)
      ? this.current()
      : { unauthorized: true };
  }

  private dailyVersion(date: string) {
    const sql = this.ctx.storage.sql;
    const start = dailyStart(date);
    const cutoff = dailyCutoff(date);
    const facts = sql
      .exec<{ n: number; last: number }>(
        "SELECT count(*) n,coalesce(max(seq),0) last FROM hourly_facts WHERE captured_at>=? AND captured_at<?",
        start,
        cutoff,
      )
      .one();
    const semantics = sql
      .exec<{ n: number; last: number }>(
        "SELECT count(*) n,coalesce(max(seq),0) last FROM semantic_records WHERE observed_at>=? AND observed_at<?",
        start,
        cutoff,
      )
      .one();
    return `${facts.n}:${facts.last}:${semantics.n}:${semantics.last}`;
  }
  private dailyState(date: string): DailyState | undefined {
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM daily_jobs WHERE date=?",
        date,
      )
      .toArray()[0];
    return row ? JSON.parse(row.payload) : undefined;
  }
  private saveDailyState(job: DailyState) {
    this.ctx.storage.sql.exec(
      "INSERT INTO daily_jobs VALUES(?,?) ON CONFLICT(date) DO UPDATE SET payload=excluded.payload",
      job.date,
      JSON.stringify(job),
    );
  }
  dailyJobs(): DailyJob[] {
    return this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM daily_jobs ORDER BY date DESC LIMIT 60",
      )
      .toArray()
      .map(({ payload }) => {
        const {
          lease: _lease,
          expires,
          version: _version,
          pending: _pending,
          completedVersion: _completed,
          ...job
        } = JSON.parse(payload) as DailyState;
        return job.status === "running" && expires <= Date.now()
          ? { ...job, status: "failed" as const, error: "interrupted" }
          : job;
      });
  }
  pendingDailyArchives(): string[] {
    return this.ctx.storage.sql
      .exec<{ date: string }>(
        "SELECT date FROM daily_jobs WHERE json_extract(payload,'$.pending') IS NOT NULL ORDER BY date",
      )
      .toArray()
      .map(({ date }) => date);
  }
  claimDay(date: string, manual: boolean) {
    return this.ctx.storage.transactionSync(() => {
      const previous = this.dailyState(date);
      if (previous && previous.expires > Date.now())
        return { skipped: "in_progress" } as const;
      if (previous && !manual && !previous.pending)
        return { skipped: "already_attempted" } as const;
      const version = previous?.pending
        ? previous.version
        : this.dailyVersion(date);
      if (
        !previous?.pending &&
        Date.parse(dailyStart(date)) < Date.now() - 48 * 3600000
      )
        return { skipped: "input_expired" } as const;
      if (version === "0:0:0:0") return { skipped: "no_data" } as const;
      if (previous?.completedVersion === version)
        return { skipped: "unchanged" } as const;
      const job: DailyState = {
        date,
        lease: crypto.randomUUID(),
        expires: Date.now() + 5 * 60000,
        version,
        pending: previous?.pending ?? null,
        completedVersion: previous?.completedVersion ?? null,
        status: "running",
        stage: previous?.pending ? "archive" : "input",
        attempts: (previous?.attempts ?? 0) + 1,
        error: null,
        lastAttemptAt: new Date().toISOString(),
        lastSuccessAt: previous?.lastSuccessAt ?? null,
      };
      this.saveDailyState(job);
      this.ctx.storage.sql.exec(
        "DELETE FROM daily_jobs WHERE date<? AND json_extract(payload,'$.pending') IS NULL",
        new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10),
      );
      return { lease: job.lease as string, version, pending: job.pending };
    });
  }
  dayHourInput(date: string, hour: number) {
    const start = new Date(
      Date.parse(dailyStart(date)) + hour * 3600000,
    ).toISOString();
    const end =
      hour === 23
        ? dailyCutoff(date)
        : new Date(Date.parse(start) + 3600000).toISOString();
    const rows = this.ctx.storage.sql.exec<{ payload: string }>(
      "SELECT payload FROM hourly_facts WHERE hour=? AND captured_at<? ORDER BY captured_at,seq",
      start,
      end,
    );
    function* reports() {
      for (const row of rows) yield JSON.parse(row.payload) as Report;
    }
    const semantics = this.ctx.storage.sql
      .exec<SemanticRow>(
        "SELECT * FROM semantic_records WHERE hour=? AND observed_at<? ORDER BY observed_at,seq",
        start,
        end,
      )
      .toArray()
      .map(unpack);
    const input = compactHour(reports(), semantics);
    const sampled = sampleHour(input.records, hour);
    return {
      hour,
      records: sampled.records,
      coverage: {
        hour,
        snapshots: input.snapshots,
        semanticRecords: input.semanticRecords,
        inputRecords: input.records.length,
        retainedRecords: sampled.records.length,
        omittedRecords: sampled.omittedRecords,
        excerptedRecords: sampled.excerptedRecords,
        firstObservedAt: input.firstObservedAt,
        lastObservedAt: input.lastObservedAt,
      },
    };
  }
  dailyStage(date: string, lease: string, stage: string) {
    const job = this.dailyState(date);
    if (!job || job.lease !== lease || job.expires <= Date.now()) return false;
    job.stage = stage;
    this.saveDailyState(job);
    return true;
  }
  cacheDay(date: string, lease: string, result: DailyReport) {
    const job = this.dailyState(date);
    if (!job || job.lease !== lease || job.expires <= Date.now())
      return "lease_lost" as const;
    if (job.version !== this.dailyVersion(date))
      return "input_changed" as const;
    job.pending = result;
    job.stage = "archive";
    this.saveDailyState(job);
    return null;
  }
  finishDay(date: string, lease: string, error: string | null = null) {
    const job = this.dailyState(date);
    if (!job || job.lease !== lease || job.expires <= Date.now()) return false;
    if (!error && !job.pending) return false;
    job.status = error ? "failed" : "complete";
    job.error = error;
    job.expires = 0;
    job.lease = null;
    if (!error) {
      job.completedVersion = job.version;
      job.lastSuccessAt = new Date().toISOString();
      job.pending = null;
      job.stage = "complete";
    }
    this.saveDailyState(job);
    return true;
  }

  private latest(
    spaceId: string,
    paneId: string,
    taskId: string,
  ): PaneSummary | undefined {
    const row = this.ctx.storage.sql
      .exec<{ payload: string }>(
        "SELECT payload FROM semantic_current WHERE space_id=? AND pane_id=? AND task_id=?",
        spaceId,
        paneId,
        taskId,
      )
      .toArray()[0];
    return row ? JSON.parse(row.payload) : undefined;
  }
  private storeLatest(value: PaneSummary) {
    this.ctx.storage.sql.exec(
      `INSERT INTO semantic_current VALUES(?,?,?,?,?,?) ON CONFLICT(space_id,pane_id,task_id) DO UPDATE SET observed_at=excluded.observed_at,received_at=excluded.received_at,payload=excluded.payload WHERE excluded.observed_at>=semantic_current.observed_at AND json_extract(excluded.payload,'$.checkedAt')>=json_extract(semantic_current.payload,'$.checkedAt')`,
      value.spaceId,
      value.paneId,
      value.taskId,
      value.observedAt,
      value.receivedAt,
      JSON.stringify(value),
    );
  }
  private prune(now: string) {
    const cutoff = new Date(
      Date.parse(now) - RETENTION_DAYS * 86400000,
    ).toISOString();
    const sql = this.ctx.storage.sql;
    sql.exec(
      "DELETE FROM semantic_records WHERE (received_at < ? OR seq IN (SELECT seq FROM semantic_records ORDER BY seq DESC LIMIT -1 OFFSET ?)) AND event_id NOT IN (SELECT event_id FROM summary_outbox)",
      cutoff,
      MAX_RECORDS,
    );
    sql.exec(
      "DELETE FROM semantic_current WHERE (received_at < ? OR rowid IN (SELECT rowid FROM semantic_current ORDER BY received_at DESC LIMIT -1 OFFSET ?)) AND NOT EXISTS(SELECT 1 FROM live_tasks WHERE live_tasks.space_id=semantic_current.space_id AND live_tasks.pane_id=semantic_current.pane_id AND live_tasks.task_id=semantic_current.task_id)",
      cutoff,
      MAX_RECORDS,
    );
    sql.exec(
      "DELETE FROM fact_evidence WHERE received_at < ? OR rowid IN (SELECT rowid FROM fact_evidence ORDER BY received_at DESC LIMIT -1 OFFSET 50000)",
      cutoff,
    );
  }
  semanticHours(query: {
    spaceId?: string;
    paneId?: string;
    hour?: string;
    mode: "all" | "latest";
    limit: number;
    before?: string;
  }) {
    this.prune(new Date().toISOString());
    const clauses: string[] = [];
    const args: (string | number)[] = [];
    if (query.spaceId) {
      clauses.push("space_id=?");
      args.push(query.spaceId);
    }
    if (query.paneId) {
      clauses.push("pane_id=?");
      args.push(query.paneId);
    }
    if (query.hour) {
      clauses.push("hour=?");
      args.push(query.hour);
    }
    const where = () =>
      clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const retention = {
      days: RETENTION_DAYS,
      maxRecords: MAX_RECORDS,
      timezone: "UTC",
    };
    if (query.hour) {
      if (query.before) {
        clauses.push("seq<?");
        args.push(Number(query.before));
      }
      const rows = this.ctx.storage.sql
        .exec<SemanticRow>(
          "SELECT * FROM semantic_records" +
            where() +
            (query.mode === "latest"
              ? " ORDER BY observed_at DESC,seq DESC LIMIT 1"
              : " ORDER BY seq DESC LIMIT ?"),
          ...args,
          ...(query.mode === "all" ? [query.limit + 1] : []),
        )
        .toArray();
      const more = rows.length > query.limit;
      return {
        entries: rows.slice(0, query.limit).map(unpack),
        nextCursor: more ? rows[query.limit - 1].seq : null,
        retention,
      };
    }
    if (query.before) {
      clauses.push("hour<?");
      args.push(query.before);
    }
    const groups = this.ctx.storage.sql
      .exec<{ hour: string; count: number }>(
        "SELECT hour,count(*) AS count FROM semantic_records" +
          where() +
          " GROUP BY hour ORDER BY hour DESC LIMIT ?",
        ...args,
        query.limit + 1,
      )
      .toArray();
    return {
      hours: groups.slice(0, query.limit).map((group) => ({
        hour: group.hour,
        count: group.count,
        latest: unpack(
          this.ctx.storage.sql
            .exec<SemanticRow>(
              "SELECT * FROM semantic_records" +
                where() +
                (clauses.length ? " AND" : " WHERE") +
                " hour=? ORDER BY observed_at DESC,seq DESC LIMIT 1",
              ...args,
              group.hour,
            )
            .one(),
        ),
      })),
      nextCursor:
        groups.length > query.limit ? groups[query.limit - 1].hour : null,
      retention,
    };
  }
  async summarize(
    batch: SummaryBatch,
    hash: string,
    credentialId: string | null,
    contentHashes: Record<string, string>,
  ) {
    await scheduleEarlier(this.ctx, Date.now() + 1000);
    const result = this.ctx.storage.transactionSync(() => {
      if (!this.authorized(credentialId))
        return { error: "unauthorized" } as const;
      const storage = this.ctx.storage;
      const sql = storage.sql;
      const manager = storage.kv.get<ManagerState>("manager");
      if (manager && manager.id !== batch.managerId)
        return { error: "writer_conflict" } as const;
      const receipt = sql
        .exec<{ digest: string }>(
          "SELECT digest FROM summary_receipts WHERE sequence=?",
          batch.sequence,
        )
        .toArray()[0];
      if (receipt)
        return receipt.digest === hash
          ? ({
              accepted: true,
              duplicate: true,
              sequence: batch.sequence,
            } as const)
          : ({ error: "sequence_conflict" } as const);
      if (manager && batch.sequence <= manager.sequence)
        return { error: "stale_sequence" } as const;
      const current = storage.kv.get<MachineView>("current");
      const facts = storage.kv.get<Record<string, Facts>>("fact-keys") ?? {};
      const accepted: Record<string, Facts> = {};
      const now = new Date().toISOString();
      for (const entry of batch.updates) {
        if (
          Date.parse(entry.observedAt) > Date.parse(now) + 30000 ||
          Date.parse(entry.observedAt) <
            Date.parse(now) - RETENTION_DAYS * 86400000
        )
          return {
            error: "observation_outside_retention",
            entry: taskKey(entry),
          } as const;
        const key = paneKey(entry);
        const known: Facts = {};
        for (const ref of entry.basis) {
          const record = sql
            .exec<{ payload: string }>(
              "SELECT payload FROM fact_evidence WHERE pane_key=? AND hash=? AND task_id=?",
              key,
              ref,
              entry.taskId,
            )
            .toArray()[0];
          if (!record)
            return { error: "basis_changed", entry: taskKey(entry) } as const;
          known[ref] = JSON.parse(record.payload);
        }
        if (
          [
            ...entry.summary.evidenceRefs,
            ...entry.summary.outcomes.flatMap((o) => o.evidenceRefs),
          ].some((ref) => !Object.hasOwn(known, ref))
        )
          return { error: "unknown_evidence", entry: taskKey(entry) } as const;
        accepted[taskKey(entry)] = known;
      }
      for (const entry of batch.checks) {
        const space = current?.report.spaces.find(
          (s) => s.id === entry.spaceId && !s.availability,
        );
        const pane = space?.tabs
          .flatMap((t) => t.panes)
          .find((p) => p.id === entry.paneId);
        const previous = this.latest(entry.spaceId, entry.paneId, entry.taskId);
        if (
          !current ||
          Date.parse(now) - Date.parse(current.report.capturedAt) > 90000 ||
          !pane ||
          pane.task.id !== entry.taskId ||
          canonical(Object.keys(facts[paneKey(entry)] ?? {}).sort()) !==
            canonical([...entry.basis].sort())
        )
          return { error: "basis_changed", entry: taskKey(entry) } as const;
        if (
          !previous ||
          canonical([...previous.basis].sort()) !==
            canonical([...entry.basis].sort())
        )
          return { error: "summary_required", entry: taskKey(entry) } as const;
        if (
          Date.parse(now) - Date.parse(entry.observedAt) > 300000 ||
          Date.parse(entry.observedAt) > Date.parse(now) + 30000 ||
          entry.observedAt < previous.checkedAt
        )
          return { error: "stale_observation", entry: taskKey(entry) } as const;
      }
      if (
        sql.exec<{ n: number }>("SELECT count(*) n FROM summary_outbox").one()
          .n +
          batch.updates.length >
        1000
      )
        return { error: "archive_backpressure" } as const;
      for (const entry of batch.updates) {
        const key = taskKey(entry);
        const previous = this.latest(entry.spaceId, entry.paneId, entry.taskId);
        const changed =
          !previous || semanticContent(previous) !== semanticContent(entry);
        const source = {
          managerId: batch.managerId,
          protocolVersion: batch.protocolVersion,
        };
        const hour = `${entry.observedAt.slice(0, 13)}:00:00.000Z`;
        const value: PaneSummary = {
          ...entry,
          updatedAt: changed ? entry.observedAt : previous.updatedAt,
          checkedAt: entry.observedAt,
          receivedAt: now,
          sequence: batch.sequence,
          evidence: Object.values(accepted[key]),
          hour,
          contentHash: contentHashes[key],
          source,
        };
        this.storeLatest(value);
        if (changed) {
          const eventId = `${batch.machineId}:${batch.managerId}:${batch.sequence}:${key}`;
          sql.exec(
            "INSERT INTO semantic_records(event_id,hour,space_id,pane_id,task_id,sequence,observed_at,received_at,content_hash,source,payload) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            eventId,
            hour,
            entry.spaceId,
            entry.paneId,
            entry.taskId,
            batch.sequence,
            entry.observedAt,
            now,
            contentHashes[key],
            JSON.stringify(source),
            JSON.stringify(value),
          );
          sql.exec(
            "INSERT INTO summary_outbox VALUES(?,?,?,?,?,?,?)",
            eventId,
            batch.machineId,
            entry.spaceId,
            entry.paneId,
            entry.taskId,
            now,
            JSON.stringify(value),
          );
        }
      }
      for (const entry of batch.checks) {
        const previous = this.latest(entry.spaceId, entry.paneId, entry.taskId);
        if (previous)
          this.storeLatest({ ...previous, checkedAt: entry.observedAt });
      }
      storage.kv.put("manager", {
        id: batch.managerId,
        sequence: batch.sequence,
        lastSeen: now,
      });
      sql.exec(
        "INSERT INTO summary_receipts VALUES(?,?)",
        batch.sequence,
        hash,
      );
      sql.exec(
        "DELETE FROM summary_receipts WHERE sequence<?",
        batch.sequence - 128,
      );
      this.prune(now);
      return {
        accepted: true,
        duplicate: false,
        sequence: batch.sequence,
      } as const;
    });
    if ("error" in result) return result;
    try {
      await this.flushSummaries();
    } catch {
      /* Persistent outbox retries independently. */
    }
    return {
      ...result,
      archivePending: this.ctx.storage.sql
        .exec<{ n: number }>("SELECT count(*) n FROM summary_outbox")
        .one().n,
    };
  }

  private async flushSummaries() {
    const rows = this.ctx.storage.sql
      .exec<{
        event_id: string;
        machine_id: string;
        space_id: string;
        pane_id: string;
        task_id: string;
        received_at: string;
        payload: string;
      }>("SELECT * FROM summary_outbox ORDER BY received_at, event_id LIMIT 20")
      .toArray();
    if (!rows.length) return;
    await this.env.DB.batch(
      rows.map((r) =>
        this.env.DB.prepare(
          "INSERT OR IGNORE INTO pane_summaries(event_id,machine_id,space_id,pane_id,task_id,received_at,payload) VALUES (?,?,?,?,?,?,?)",
        ).bind(
          r.event_id,
          r.machine_id,
          r.space_id,
          r.pane_id,
          r.task_id,
          r.received_at,
          r.payload,
        ),
      ),
    );
    this.ctx.storage.transactionSync(() => {
      for (const row of rows)
        this.ctx.storage.sql.exec(
          "DELETE FROM summary_outbox WHERE event_id = ?",
          row.event_id,
        );
    });
  }

  async alarm() {
    this.live.sweep();
    try {
      await this.flushSummaries();
    } finally {
      if (
        this.ctx.storage.sql
          .exec<{ n: number }>("SELECT count(*) n FROM summary_outbox")
          .one().n
      )
        await scheduleEarlier(this.ctx, Date.now() + 30000);
      await this.live.schedule();
    }
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
