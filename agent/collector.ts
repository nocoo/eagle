import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { promisify, stripVTControlCharacters } from "node:util";
import { z } from "zod";
import {
  type Evidence,
  EvidenceSchema,
  type Pane,
  type Report,
  ReportSchema,
  type Space,
} from "../src/shared/schema.ts";
import { collectTelemetry } from "./machine.ts";
import { AGENT_VERSION } from "./version.ts";

const exec = promisify(execFile);

export function redact(text: string, secrets: string[] = []) {
  let clean = stripVTControlCharacters(text)
    .replace(
      /-----BEGIN [\w ]*PRIVATE KEY-----[\s\S]*?(?:-----END [\w ]*PRIVATE KEY-----|$)/g,
      "[REDACTED KEY]",
    )
    .replace(
      /(?:^[ \t]*[A-Za-z0-9+/]+={0,2}[ \t]*\r?\n)+[ \t]*-----END [\w ]*PRIVATE KEY-----/gm,
      "[REDACTED KEY]",
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(
      /\beag1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL)[A-Z_]*)\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /\b(?:sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,})\b/g,
      "[REDACTED]",
    );
  for (const secret of secrets)
    if (secret) clean = clean.replaceAll(secret, "[REDACTED]");
  return clean;
}
type Rect = { x: number; y: number; width: number; height: number };
type RawPane = {
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  terminal_id?: string;
  agent?: string;
  agent_status?: string;
  terminal_title_stripped?: string;
  title?: string;
  cwd?: string;
  foreground_cwd?: string;
  agent_session?: { value: string; kind: string; agent?: string };
};
export type Snapshot = {
  workspaces: { workspace_id: string; label: string }[];
  tabs: { workspace_id: string; tab_id: string; label: string }[];
  panes: RawPane[];
  layouts: {
    tab_id: string;
    area: Rect;
    panes: { pane_id: string; rect: Rect }[];
  }[];
};
export function normalizeSnapshot(
  snapshot: Snapshot,
  session: string,
  secrets: string[] = [],
): Space[] {
  if (
    !Array.isArray(snapshot.workspaces) ||
    !Array.isArray(snapshot.tabs) ||
    !Array.isArray(snapshot.panes) ||
    !Array.isArray(snapshot.layouts)
  )
    throw new Error("Unsupported Herdr snapshot");
  return snapshot.workspaces.map((w) => ({
    id: `${session}:${w.workspace_id}`,
    name: w.label || w.workspace_id,
    session,
    objective: "",
    tabs: snapshot.tabs
      .filter((t) => t.workspace_id === w.workspace_id)
      .map((t) => {
        const layout = snapshot.layouts.find((l) => l.tab_id === t.tab_id);
        const rawPanes = snapshot.panes.filter((p) => p.tab_id === t.tab_id);
        return {
          id: t.tab_id,
          name: t.label || t.tab_id,
          panes: rawPanes.map((p, index) => {
            const rect = layout?.panes.find(
              (r) => r.pane_id === p.pane_id,
            )?.rect;
            const area = layout?.area;
            const title = redact(
              p.title ||
                p.terminal_title_stripped ||
                `${p.agent || "终端"} · ${w.label}`,
              secrets,
            ).slice(0, 240);
            return {
              id: p.pane_id,
              title,
              agent: p.agent || "",
              hint: ["working", "idle", "done", "blocked"].includes(
                p.agent_status ?? "",
              )
                ? (p.agent_status as Pane["hint"])
                : "unknown",
              task: {
                id: createHash("sha256")
                  .update(
                    `${session}:${p.pane_id}:${p.agent || "shell"}:${p.agent_session?.agent && p.agent_session.agent !== p.agent ? (p.terminal_id ?? "") : (p.agent_session?.value ?? p.terminal_id ?? "")}`,
                  )
                  .digest("hex")
                  .slice(0, 32),
                title,
                requiresDeployment: true,
              },
              rect:
                rect && area?.width && area?.height
                  ? {
                      x: (rect.x - area.x) / area.width,
                      y: (rect.y - area.y) / area.height,
                      width: rect.width / area.width,
                      height: rect.height / area.height,
                    }
                  : {
                      x: index / rawPanes.length,
                      y: 0,
                      width: 1 / rawPanes.length,
                      height: 1,
                    },
              evidence: [],
            };
          }),
        };
      }),
  }));
}
export function transcriptContext(
  text: string,
): { turnId: string; startedAt: string } | undefined {
  let current: { turnId: string; startedAt: string } | undefined;
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line);
      const turnId = event.payload?.turn_id;
      if (
        typeof turnId === "string" &&
        typeof event.timestamp === "string" &&
        ["event_msg", "turn_context"].includes(event.type) &&
        current?.turnId !== turnId
      ) {
        current = { turnId, startedAt: event.timestamp };
      }
    } catch {
      /* Bounded tail can start mid-line. */
    }
  }
  return current;
}

export function transcriptEvidence(text: string, taskId: string): Evidence[] {
  let summary: Evidence | undefined;
  let process: Evidence | undefined;
  for (const line of text.split("\n")) {
    try {
      const e = JSON.parse(line);
      const p = e.payload;
      if (!p || !e.timestamp || Number.isNaN(Date.parse(e.timestamp))) continue;
      const observedAt = new Date(e.timestamp).toISOString();
      if (
        e.type === "response_item" &&
        ["function_call", "custom_tool_call"].includes(p.type)
      ) {
        summary = undefined;
        process = {
          kind: "process",
          status: "running",
          summary: "Agent 正在调用工具执行任务",
          source: "codex:tool-event (不含参数)",
          observedAt,
          taskId,
        };
      }

      if (
        e.type === "event_msg" &&
        ["task_started", "task_complete", "task_interrupted"].includes(p.type)
      ) {
        process = {
          kind: "process",
          status: p.type === "task_started" ? "running" : "unknown",
          summary:
            p.type === "task_started"
              ? "Agent 回合正在执行；尚未出现回合结束事件"
              : "Agent 回合已结束，任务结果仍需核对",
          source: "codex:turn-event",
          observedAt,
          taskId,
        };
        if (p.type === "task_started") summary = undefined;
      }
      if (
        e.type === "response_item" &&
        p.role === "assistant" &&
        ["final", "final_answer"].includes(p.phase)
      ) {
        if (process)
          process = {
            ...process,
            status: "unknown",
            observedAt,
            summary: "Agent 已给出最终回复，交付结论待交叉核对",
          };
        const content = (p.content ?? [])
          .filter((c: { text?: string }) => typeof c.text === "string")
          .map((c: { text: string }) => c.text)
          .join("\n");
        if (content)
          summary = {
            kind: "summary",
            status: "unknown",
            summary: content.slice(0, 2000),
            source: "codex:final-message",
            observedAt,
            taskId,
          };
      }
    } catch {
      /* A bounded tail may begin in the middle of a JSON line. */
    }
  }
  return [process, summary].filter((e): e is Evidence => !!e);
}
async function tail(path: string) {
  const f = await open(path, "r");
  try {
    const stat = await f.stat();
    const size = Math.min(stat.size, 524288);
    const bytes = Buffer.alloc(size);
    await f.read(bytes, 0, size, stat.size - size);
    return bytes.toString("utf8");
  } finally {
    await f.close();
  }
}
async function command(file: string, args: string[], cwd?: string) {
  return (
    await exec(file, args, { cwd, timeout: 8000, maxBuffer: 4 * 1024 * 1024 })
  ).stdout.trim();
}
async function herdr(args: string[], session?: string) {
  return command("herdr", [
    ...(session ? ["--session", session] : []),
    ...args,
  ]);
}
const ManagerSchema = z.record(
  z.string(),
  z.strictObject({
    task: z.strictObject({
      id: z.string(),
      title: z.string().max(500),
      requiresDeployment: z.boolean(),
    }),
    evidence: z.array(EvidenceSchema).max(20),
  }),
);
export type AgentConfig = {
  manager?: Partial<
    import("zod").infer<typeof import("./manager.ts").ManagerConfigSchema>
  >;
  url: string;
  token: string;
  machineId: string;
  machineName: string;
  evidenceFile?: string;
  intervalSeconds?: number;
  slowIntervalSeconds?: number;
  codexDir?: string;
  spoolDir?: string;
  watchPorts?: { name: string; port: number; host?: string }[];
};

export function applyManager(
  pane: Pane,
  managed: { task: Pane["task"]; evidence: Evidence[] },
): boolean {
  if (managed.task.id !== pane.task.id) return false;
  pane.task.title = managed.task.title;
  pane.evidence.push(
    ...managed.evidence.map((e) => ({
      ...e,
      status: "unknown" as const,
      source: `manager:legacy:${e.source}`.slice(0, 240),
    })),
  );
  return true;
}
export function preserveStopped(
  current: Space[],
  previous: Space[],
  stopped: string[],
): Space[] {
  return [
    ...current,
    ...previous
      .filter((s) => stopped.includes(s.session))
      .map((s) => ({ ...s, availability: "unavailable" as const })),
  ];
}
export function conversationTaskId(
  text: string,
  sessionId: string,
): string | undefined {
  let lastUser: string | undefined;
  for (const line of text.split("\n")) {
    try {
      const e = JSON.parse(line);
      if (
        (e.type === "user" && !e.synthetic_reason) ||
        (e.type === "message" && e.message?.role === "user")
      )
        lastUser = JSON.stringify(
          e.type === "user" ? e.content : e.message.content,
        );
    } catch {
      /* Bounded tail can begin mid-line. */
    }
  }
  return lastUser
    ? createHash("sha256")
        .update(`${sessionId}:${lastUser}`)
        .digest("hex")
        .slice(0, 32)
    : undefined;
}

export function conversationEvidence(
  text: string,
  agent: "grok" | "pi",
  taskId: string,
  modifiedAt: string,
): Evidence[] {
  let final: Evidence | undefined;
  for (const line of text.split("\n")) {
    try {
      const event = JSON.parse(line);
      const message = event.type === "message" ? event.message : event;
      if (
        (event.type === "user" && !event.synthetic_reason) ||
        (event.type === "message" && message.role === "user")
      )
        final = undefined;
      if (!(event.type === "assistant" || message?.role === "assistant"))
        continue;
      if (
        message.tool_calls?.length ||
        (message.stopReason && message.stopReason !== "stop")
      )
        continue;
      if (
        Array.isArray(message.content) &&
        message.content.some(
          (c: { type: string }) =>
            c.type === "toolCall" || c.type === "tool_use",
        )
      )
        continue;
      const content =
        typeof message.content === "string"
          ? message.content
          : Array.isArray(message.content)
            ? message.content
                .filter((c: { type: string }) => c.type === "text")
                .map((c: { text: string }) => c.text)
                .join("\n")
            : "";
      if (!content.trim()) continue;
      const timestamp = Date.parse(event.timestamp ?? message.timestamp);
      final = {
        kind: "summary",
        status: "unknown",
        summary: content.slice(-2000),
        source: `${agent}:final-message`,
        taskId,
        observedAt: Number.isFinite(timestamp)
          ? new Date(timestamp).toISOString()
          : modifiedAt,
      };
    } catch {
      /* A bounded native transcript can begin mid-line. */
    }
  }
  return final ? [final] : [];
}

export async function collect(config: AgentConfig): Promise<Report> {
  const capturedAt = new Date().toISOString();
  const warnings: string[] = [];
  let spaces: Space[] = [];
  const cachePath = join(
    dirname(config.spoolDir ?? join(homedir(), ".config/eagle/spool")),
    "latest-report.json",
  );
  let previous: Report | undefined;
  try {
    const cached = ReportSchema.parse(
      JSON.parse(await readFile(cachePath, "utf8")),
    );
    if (cached.machine.id === config.machineId) previous = cached;
  } catch {
    /* First collection has no cache. */
  }

  const telemetry = await collectTelemetry(
    config.watchPorts,
    config.slowIntervalSeconds,
    previous?.machine.telemetry,
  );
  if (!telemetry.resources)
    warnings.push("机器资源采集失败，端口检查结果仍保留");
  else if (!telemetry.resources.disk) warnings.push("主目录磁盘信息不可读");

  const sessions: { name: string; running: boolean }[] = JSON.parse(
    await herdr(["session", "list", "--json"]),
  ).sessions;
  if (!sessions.some((s) => s.running) && !previous)
    throw new Error("No running Herdr sessions; preserving previous inventory");
  const manager = config.evidenceFile
    ? ManagerSchema.parse(
        JSON.parse(await readFile(config.evidenceFile, "utf8")),
      )
    : {};
  // ponytail: optional Codex v5/v1 adapter. Unsupported local DB schemas remain unknown; manager evidence is portable.
  let state: DatabaseSync | undefined;
  let goals: DatabaseSync | undefined;
  const codexDir = config.codexDir ?? join(homedir(), ".codex");
  try {
    state = new DatabaseSync(join(codexDir, "state_5.sqlite"), {
      readOnly: true,
    });
  } catch {
    warnings.push("Codex 会话数据库不可读；使用终端证据");
  }
  try {
    goals = new DatabaseSync(join(codexDir, "goals_1.sqlite"), {
      readOnly: true,
    });
  } catch {
    warnings.push("Codex Goal 数据库不可读；等待管理 Agent 补充");
  }
  try {
    for (const session of sessions.filter((s) => s.running)) {
      // Any session failure aborts the whole snapshot, so a partial inventory never closes Spaces.
      const raw = JSON.parse(await herdr(["api", "snapshot"], session.name))
        .result.snapshot as Snapshot;
      const normalized = normalizeSnapshot(raw, session.name, [config.token]);
      for (const space of normalized) {
        for (const pane of space.tabs.flatMap((t) => t.panes)) {
          const original = raw.panes.find((p) => p.pane_id === pane.id);
          const managed = manager[`${session.name}:${pane.id}`];
          const sessionId =
            original?.agent_session?.kind === "id" &&
            (!original.agent_session.agent ||
              original.agent_session.agent === pane.agent)
              ? original.agent_session.value
              : undefined;
          if (pane.agent === "codex" && sessionId) {
            try {
              const thread = state
                ?.prepare(
                  "SELECT title, rollout_path FROM threads WHERE id = ?",
                )
                .get(sessionId) as
                | { title: string; rollout_path: string }
                | undefined;
              let currentContext: ReturnType<typeof transcriptContext>;
              if (thread) {
                const transcript = await tail(thread.rollout_path);
                currentContext = transcriptContext(transcript);
                if (currentContext)
                  pane.task.id = createHash("sha256")
                    .update(`${sessionId}:${currentContext.turnId}`)
                    .digest("hex")
                    .slice(0, 32);
                pane.task.title = thread.title.slice(0, 500);
                pane.evidence.push(
                  ...transcriptEvidence(transcript, pane.task.id),
                );
              }
              const goal = goals
                ?.prepare(
                  "SELECT objective, status, updated_at_ms FROM thread_goals WHERE thread_id = ?",
                )
                .get(sessionId) as
                | { objective: string; status: string; updated_at_ms: number }
                | undefined;
              if (
                goal &&
                currentContext &&
                goal.updated_at_ms >= Date.parse(currentContext.startedAt)
              )
                pane.evidence.push({
                  kind: "goal",
                  status:
                    goal.status === "active"
                      ? "running"
                      : goal.status === "complete"
                        ? "success"
                        : "waiting",
                  summary: goal.objective.slice(0, 2000),
                  source: "codex:thread-goal",
                  observedAt: new Date(goal.updated_at_ms).toISOString(),
                  taskId: pane.task.id,
                });
            } catch {
              warnings.push(`${space.name}/${pane.id}：原生会话证据不可读`);
            }
          }
          if (pane.agent === "grok" || pane.agent === "pi") {
            try {
              const identity =
                original?.agent_session?.agent &&
                original.agent_session.agent !== pane.agent
                  ? undefined
                  : original?.agent_session?.value;
              const cwd = original?.cwd;
              const path =
                pane.agent === "pi"
                  ? identity
                  : identity && cwd
                    ? join(
                        homedir(),
                        ".grok/sessions",
                        encodeURIComponent(cwd),
                        identity,
                        "chat_history.jsonl",
                      )
                    : undefined;
              if (path && identity) {
                const transcript = await tail(path);
                const taskId = conversationTaskId(transcript, identity);
                if (taskId) pane.task.id = taskId;
                pane.evidence.push(
                  ...conversationEvidence(
                    transcript,
                    pane.agent,
                    pane.task.id,
                    (await stat(path)).mtime.toISOString(),
                  ),
                );
              }
            } catch {
              /* Portable manager evidence remains available when native history is absent. */
            }
          }
          if (managed && !applyManager(pane, managed))
            warnings.push(
              `${space.name}/${pane.id}：管理证据属于旧任务，已忽略`,
            );
          if (!pane.evidence.some((e) => e.kind === "summary")) {
            try {
              const terminal = await herdr(
                ["pane", "read", pane.id, "--source", "visible"],
                session.name,
              );
              const lines = terminal
                .split("\n")
                .map((l) => l.trim())
                .filter((l) => l && !/^[─━╭╰│┃█\s]+$/.test(l));
              pane.evidence.push({
                kind: "summary",
                status: "unknown",
                summary: lines.slice(-12).join("\n").slice(0, 1500),
                source: "herdr:visible (当前画面，非最终结论)",
                observedAt: capturedAt,
                taskId: pane.task.id,
              });
            } catch {
              warnings.push(`${space.name}/${pane.id}：终端证据缺失`);
            }
          }
          const cwd = original?.foreground_cwd || original?.cwd;
          if (cwd) {
            try {
              const revision = await command("git", ["rev-parse", "HEAD"], cwd);
              const dirty = await command(
                "git",
                ["status", "--porcelain", "--untracked-files=normal"],
                cwd,
              );
              const branch = await command(
                "git",
                ["branch", "--show-current"],
                cwd,
              );
              pane.evidence.push({
                kind: "git",
                status: dirty ? "unknown" : "success",
                revision,
                summary: `${branch || "detached"} · ${revision.slice(0, 8)} · ${dirty ? `${dirty.split("\n").length} 项未提交变更` : "工作树干净"}`,
                source: "git:HEAD+status",
                observedAt: capturedAt,
                taskId: pane.task.id,
              });
            } catch {
              /* Shells outside a repository have no Git evidence. */
            }
          }
          try {
            const info = JSON.parse(
              await herdr(
                ["pane", "process-info", "--pane", pane.id],
                session.name,
              ),
            ).result.process_info;
            const names = (info.foreground_processes ?? [])
              .map((p: { name: string }) => p.name)
              .join(", ");
            // Presence of an agent harness is deliberately not evidence that a task is running.
            if (!pane.evidence.some((e) => e.kind === "process"))
              pane.evidence.push({
                kind: "process",
                status: "unknown",
                summary: names
                  ? `前台进程：${names}；进程存在不等于任务执行中`
                  : "没有前台任务进程",
                source: "herdr:process-info (仅进程名)",
                observedAt: capturedAt,
                taskId: pane.task.id,
              });
          } catch {
            warnings.push(`${space.name}/${pane.id}：进程证据缺失`);
          }
        }
        space.objective =
          space.tabs.flatMap((t) => t.panes).find((p) => p.agent === "codex")
            ?.task.title ??
          space.tabs[0]?.panes[0]?.task.title ??
          "";
      }
      spaces.push(...normalized);
    }
  } finally {
    state?.close();
    goals?.close();
  }
  const stopped = sessions.filter((s) => !s.running).map((s) => s.name);
  spaces = preserveStopped(spaces, previous?.spaces ?? [], stopped);
  for (const session of stopped)
    warnings.push(`${session}：Session 已停止，保留最近已知拓扑`);
  const value = {
    schemaVersion: 1,
    reportId: randomUUID(),
    capturedAt,
    machine: {
      id: config.machineId,
      name: config.machineName,
      platform: platform(),
      collectorVersion: AGENT_VERSION,
      telemetry,
    },
    spaces,
    warnings: warnings.slice(0, 100),
  };
  // Scrub every string, including task titles and manager evidence, before disk spool or transport.
  function scrub(v: unknown): unknown {
    if (typeof v === "string")
      return redact(v, [config.token]).slice(0, v.length);
    if (Array.isArray(v)) return v.map(scrub);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, scrub(x)]),
      );
    return v;
  }
  const report = ReportSchema.parse(scrub(value));
  await mkdir(dirname(cachePath), { recursive: true, mode: 0o700 });
  await writeFile(
    `${cachePath}.${report.reportId}.tmp`,
    JSON.stringify(report),
    { mode: 0o600 },
  );
  await rename(`${cachePath}.${report.reportId}.tmp`, cachePath);
  return report;
}
export function checkUrl(value: string) {
  const url = new URL(value);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("Use a plain Eagle origin");
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    )
  )
    throw new Error("HTTPS is required outside loopback");
  return url.origin;
}
export class UploadRejectedError extends Error {
  status: number;
  constructor(status: number) {
    super(`Upload rejected (${status}); report retained`);
    this.status = status;
  }
}
export async function sendReport(
  url: string,
  token: string,
  report: Report,
  transport: typeof fetch = fetch,
  delayMs = 1000,
) {
  const origin = checkUrl(url);
  const payload = JSON.stringify(ReportSchema.parse(report));
  for (let attempt = 0; attempt < 3; attempt++) {
    let response: Response;
    try {
      response = await transport(`${origin}/api/v1/reports`, {
        method: "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: payload,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      if (attempt === 2)
        throw new Error("Upload network failure; report retained for retry");
      await new Promise((r) => setTimeout(r, delayMs * 2 ** attempt));
      continue;
    }
    if (response.ok) {
      try {
        return z
          .object({
            accepted: z.literal(true),
            duplicate: z.boolean(),
            seq: z.number().int().positive(),
          })
          .parse(await response.json());
      } catch {
        throw new Error(
          "Invalid upload acknowledgement; report retained for retry",
        );
      }
    }
    if (response.status < 500 && response.status !== 429)
      throw new UploadRejectedError(response.status);
    if (attempt === 2)
      throw new Error(
        `Upload unavailable (${response.status}); report retained`,
      );
    await new Promise((r) => setTimeout(r, delayMs * 2 ** attempt));
  }
}
