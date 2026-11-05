import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import WebSocket from "ws";
import {
  AgentMessageSchema,
  BridgeMessageSchema,
  type LiveTopology,
  type Subscription,
  TopologySchema,
} from "../contracts/src/realtime.ts";
import {
  parseTerminalScreen,
  restyleRedactedText,
  type TerminalRun,
} from "../contracts/src/terminal.ts";
import {
  type AgentConfig,
  checkUrl,
  normalizeSnapshot,
  redact,
  type Snapshot,
} from "./collector.ts";
import { submitTerminalInput } from "./terminal-input.ts";

export function redactScreen(value: string, secrets: string[]) {
  // A viewport can contain only a PEM body. Conservatively hide base64 line runs,
  // including narrow terminal wraps, even when neither boundary is visible.
  const text = redact(value, secrets).replace(
    /(?:^[ \t]*[A-Za-z0-9+/]{16,}={0,2}[ \t]*(?:\r?\n|$)){2,}/gm,
    "[REDACTED KEY]\n",
  );
  const positions: number[] = [];
  const assignments: [number, number][] = [];
  let compact = "";
  let identifierStart = 0;
  let wordBreak = false;
  for (let offset = 0; offset < text.length; offset++) {
    if (/\s/.test(text[offset])) {
      let wrapped = false;
      let bareCarriageReturn = false;
      while (offset < text.length && /\s/.test(text[offset])) {
        wrapped ||= text[offset] === "\n";
        bareCarriageReturn ||=
          text[offset] === "\r" && text[offset + 1] !== "\n";
        offset++;
      }
      wordBreak = !wrapped || bareCarriageReturn;
      offset--;
      continue;
    }
    const character = text[offset];
    if (/\w/.test(character)) {
      if (wordBreak) identifierStart = compact.length;
    } else {
      if (/[=:]/.test(character) && identifierStart < compact.length)
        assignments.push([identifierStart, compact.length]);
      identifierStart = compact.length + 1;
    }
    wordBreak = false;
    positions.push(offset);
    compact += character;
  }
  const masked = new Set<number>();
  const mask = (start: number, length: number) => {
    for (let i = start; i < start + length; i++) masked.add(positions[i]);
  };
  // Match across rendered wraps; also suppress recognizable credential fragments at viewport edges.
  for (const secret of secrets.filter(Boolean)) {
    const size = Math.min(8, secret.length);
    for (let i = 0; i <= secret.length - size; i++) {
      const part = secret.slice(i, i + size);
      for (
        let at = compact.indexOf(part);
        at >= 0;
        at = compact.indexOf(part, at + 1)
      )
        mask(at, size);
    }
  }
  for (const match of compact.matchAll(
    /(?:eag1\.[A-Za-z0-9_.-]+|sk-[\w-]{16,}|gh[pousr]_[\w]{20,}|github_pat_[\w]{20,})/gi,
  ))
    mask(match.index, match[0].length);
  let assignmentEnd = 0;
  for (const [start, end] of assignments) {
    if (start < assignmentEnd) continue;
    const key = compact.slice(start, end);
    const sensitive = key.search(/TOKEN|SECRET|PASSWORD|API_KEY|CREDENTIAL/i);
    if (sensitive < 0) continue;
    const value = compact
      .slice(end + 1)
      .match(/^(?:"[^"]*(?:"|$)|'[^']*(?:'|$)|[^,;"']+)/)?.[0];
    if (!value) continue;
    assignmentEnd = end + 1 + value.length;
    mask(start + sensitive, assignmentEnd - start - sensitive);
  }
  const safe =
    masked.size === 0
      ? text
      : text
          .split("")
          .map((c, i) => (masked.has(i) ? "*" : c))
          .join("");
  return safe.replace(/\*{8,}/g, "[REDACTED]");
}

export function terminalScreen(
  value: string,
  secrets: string[],
): {
  text: string;
  runs?: TerminalRun[];
} {
  const parsed = parseTerminalScreen(value);
  const redacted = redactScreen(parsed.text, secrets);
  const text = redacted.slice(-32000);
  // Rebuild runs from already redacted characters, copying only style metadata.
  // The schema also enforces that joined runs equal the safe plain text.
  const styled = restyleRedactedText(parsed.runs, redacted);
  let skip = Math.max(0, redacted.length - 32000);
  const runs = styled.flatMap((run) => {
    const cut = Math.min(skip, run.text.length);
    skip -= cut;
    return cut === run.text.length
      ? []
      : [{ ...run, text: run.text.slice(cut) }];
  });
  // Keep the newest visible styles first; simplify older styling rather than
  // dropping all colors because one screen exceeds the run/byte budget.
  let keep = Math.min(runs.length, 512);
  while (keep > 0) {
    const bounded =
      keep === runs.length
        ? runs
        : [
            {
              text: runs
                .slice(0, runs.length - keep + 1)
                .map((run) => run.text)
                .join(""),
            },
            ...runs.slice(runs.length - keep + 1),
          ];
    if (!bounded.some((run) => Object.keys(run).length > 1)) break;
    if (new TextEncoder().encode(JSON.stringify(bounded)).length <= 64000)
      return { text, runs: bounded };
    keep = Math.floor(keep / 2);
  }
  return { text };
}

export function socketRequest(
  path: string,
  method: string,
  params: object,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Cancelled"));
      return;
    }
    const socket = createConnection(path);
    const id = randomUUID();
    let bytes = "",
      settled = false;
    const finish = (error?: Error, result?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.destroy();
      if (error) reject(error);
      else if (result) resolve(result);
      else reject(new Error("Missing response"));
    };
    const abort = () => finish(new Error("Cancelled"));
    const timer = setTimeout(() => finish(new Error("Herdr timeout")), 5000);
    signal.addEventListener("abort", abort, { once: true });
    socket.setEncoding("utf8");
    socket.on("error", () => finish(new Error("Herdr unavailable")));
    socket.on("end", () => finish(new Error("Herdr disconnected")));
    socket.on("connect", () => {
      if (!signal.aborted)
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      bytes += chunk;
      if (bytes.length > 4 * 1024 * 1024) {
        finish(new Error("Herdr response too large"));
        return;
      }
      const end = bytes.indexOf("\n");
      if (end < 0) return;
      try {
        const response = JSON.parse(bytes.slice(0, end));
        if (response.id !== id || response.error || !response.result)
          throw new Error();
        finish(undefined, response.result);
      } catch {
        finish(new Error("Invalid Herdr response"));
      }
    });
  });
}
type Watch = {
  subscription: Subscription;
  abort: AbortController;
  force: boolean;
  path?: string;
  topology?: LiveTopology;
  screens: Map<string, string>;
  frameSequence: number;
  queue: Promise<void>;
};
export class LiveBridge {
  private styledFrames = false;
  private watches = new Map<string, Watch>();
  private secrets: string[];
  private send: (
    message: import("zod").infer<typeof AgentMessageSchema>,
  ) => void;
  private resolve: (session: string, signal: AbortSignal) => Promise<string>;
  constructor(
    secrets: string[],
    send: (message: import("zod").infer<typeof AgentMessageSchema>) => void,
    resolve: (session: string, signal: AbortSignal) => Promise<string>,
  ) {
    this.secrets = secrets;
    this.send = send;
    this.resolve = resolve;
  }
  receive(value: unknown) {
    const parsed = BridgeMessageSchema.safeParse(value);
    if (!parsed.success) throw new Error("Invalid relay message");
    const message = parsed.data;
    if (message.type === "subscriptions") {
      this.styledFrames = message.format === "styled-text-v1";
      const wanted = new Map(message.spaces.map((s) => [s.spaceId, s]));
      for (const [key, watch] of this.watches)
        if (
          wanted.get(key)?.subscriptionId !== watch.subscription.subscriptionId
        ) {
          watch.abort.abort();
          this.watches.delete(key);
        }
      for (const subscription of message.spaces) {
        const previous = this.watches.get(subscription.spaceId);
        if (previous) {
          previous.force = true;
          continue;
        }
        const watch: Watch = {
          subscription,
          abort: new AbortController(),
          force: true,
          screens: new Map(),
          frameSequence: 0,
          queue: Promise.resolve(),
        };
        this.watches.set(subscription.spaceId, watch);
        void this.watch(watch);
      }
    } else if (message.type === "input") {
      const watch = this.watches.get(message.spaceId);
      const ack = (status: "submitted" | "rejected" | "unknown") =>
        this.send({
          type: "ack",
          clientId: message.clientId,
          seq: message.seq,
          status,
        });
      if (
        !watch ||
        watch.subscription.subscriptionId !== message.subscriptionId
      ) {
        ack("rejected");
        return;
      }
      watch.queue = watch.queue.then(async () => {
        try {
          if (
            !watch.path ||
            watch.abort.signal.aborted ||
            redact(message.text, this.secrets) !== message.text
          ) {
            ack("rejected");
            return;
          }
          const result = await socketRequest(
            watch.path,
            "session.snapshot",
            {},
            watch.abort.signal,
          );
          const raw = result.snapshot as Snapshot;
          const pane = raw.panes.find(
            (p) =>
              p.pane_id === message.paneId &&
              p.terminal_id === message.terminalId &&
              `${message.spaceId.slice(0, message.spaceId.indexOf(":"))}:${p.workspace_id}` ===
                message.spaceId,
          );
          if (!pane || watch.abort.signal.aborted) {
            ack("rejected");
            return;
          }
          const rect = raw.layouts
            .find((l) => l.tab_id === pane.tab_id)
            ?.panes.find((p) => p.pane_id === pane.pane_id)?.rect;
          if (!rect) {
            ack("rejected");
            return;
          }
          const status = await submitTerminalInput(
            watch.path,
            message,
            { width: rect.width, height: Math.max(1, rect.height - 1) },
            watch.abort.signal,
            async () => {
              const latest = (
                await socketRequest(
                  watch.path ?? "",
                  "session.snapshot",
                  {},
                  watch.abort.signal,
                )
              ).snapshot as Snapshot;
              return latest.panes.some(
                (p) =>
                  p.pane_id === pane.pane_id &&
                  p.terminal_id === message.terminalId &&
                  p.workspace_id === pane.workspace_id &&
                  p.tab_id === pane.tab_id,
              );
            },
          );
          watch.force = true;
          ack(status);
        } catch {
          ack("rejected");
        }
      });
    }
  }
  private async watch(watch: Watch) {
    const { spaceId } = watch.subscription;
    const session = spaceId.slice(0, spaceId.indexOf(":"));
    const signal = watch.abort.signal;
    try {
      watch.path = await this.resolve(session, signal);
      while (!signal.aborted) {
        const result = await socketRequest(
          watch.path,
          "session.snapshot",
          {},
          signal,
        );
        const raw = result.snapshot as Omit<Snapshot, "panes"> & {
          panes: (Snapshot["panes"][number] & { revision: number })[];
        };
        const space = normalizeSnapshot(raw, session, this.secrets).find(
          (s) => s.id === spaceId,
        );
        if (!space) throw new Error("Space unavailable");
        const topology = TopologySchema.parse({
          type: "topology",
          ...watch.subscription,
          tabs: space.tabs.map((t) => ({
            id: t.id,
            name: redactScreen(t.name, this.secrets).slice(0, 240),
            panes: t.panes.map((p) => ({
              id: p.id,
              terminalId: raw.panes.find((r) => r.pane_id === p.id)
                ?.terminal_id,
              title: redactScreen(p.title, this.secrets).slice(0, 240),
              rect: p.rect,
            })),
          })),
        });
        const force =
          watch.force ||
          JSON.stringify(topology) !== JSON.stringify(watch.topology);
        watch.force = false;
        if (signal.aborted) return;
        if (force) {
          this.send(topology);
          watch.topology = topology;
        }
        const panes = topology.tabs.flatMap((t) => t.panes);
        const pending: {
          pane: (typeof panes)[number];
          screen: ReturnType<typeof terminalScreen>;
          tab: string;
        }[] = [];
        // Herdr 0.9.1 screen revisions can be zero. Compare content after bounded reads.
        for (let i = 0; i < panes.length; i += 4)
          await Promise.all(
            panes.slice(i, i + 4).map(async (p) => {
              const result = await socketRequest(
                watch.path ?? "",
                "pane.read",
                {
                  pane_id: p.id,
                  source: "visible",
                  format: "ansi",
                  strip_ansi: false,
                },
                signal,
              );
              const read = result.read as {
                text: string;
                pane_id: string;
                workspace_id: string;
                tab_id: string;
              };
              const original = raw.panes.find((r) => r.pane_id === p.id);
              if (
                read.pane_id !== p.id ||
                read.workspace_id !== original?.workspace_id ||
                read.tab_id !== original?.tab_id
              )
                return;
              pending.push({
                pane: p,
                screen: terminalScreen(read.text, this.secrets),
                tab: read.tab_id,
              });
            }),
          );
        const after = (
          await socketRequest(watch.path, "session.snapshot", {}, signal)
        ).snapshot as Snapshot;
        if (signal.aborted) return;
        for (const { pane: p, screen, tab } of pending) {
          const current = after.panes.find(
            (r) =>
              r.pane_id === p.id &&
              r.terminal_id === p.terminalId &&
              r.tab_id === tab &&
              `${session}:${r.workspace_id}` === spaceId,
          );
          if (!current) {
            watch.force = true;
            continue;
          }
          const fingerprint = JSON.stringify(screen);
          if (!force && watch.screens.get(p.terminalId) === fingerprint)
            continue;
          this.send(
            AgentMessageSchema.parse({
              type: "frame",
              ...watch.subscription,
              paneId: p.id,
              terminalId: p.terminalId,
              revision: ++watch.frameSequence,
              ...(this.styledFrames ? screen : { text: screen.text }),
              observedAt: new Date().toISOString(),
            }),
          );
          watch.screens.set(p.terminalId, fingerprint);
        }
        for (const key of watch.screens.keys())
          if (!panes.some((p) => p.terminalId === key))
            watch.screens.delete(key);
        await delay(350, undefined, { signal });
      }
    } catch {
      if (!signal.aborted)
        this.send({ type: "unavailable", ...watch.subscription });
    } finally {
      watch.abort.abort();
      if (this.watches.get(spaceId) === watch) this.watches.delete(spaceId);
    }
  }
  close() {
    for (const watch of this.watches.values()) watch.abort.abort();
    this.watches.clear();
  }
}

export async function realtimeWatch(config: AgentConfig, signal: AbortSignal) {
  const url = new URL("/api/v1/realtime-agent", checkUrl(config.url));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  let retry = 1000;
  while (!signal.aborted) {
    let authFailure = false;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${config.token}`,
          "X-Eagle-Machine": config.machineId,
          "X-Eagle-Realtime-Format": "styled-text-v1",
        },
        handshakeTimeout: 10000,
        maxPayload: 262144,
        followRedirects: false,
      });
      const bridge = new LiveBridge(
        [config.token],
        (message) => {
          if (ws.readyState !== WebSocket.OPEN) return;
          if (ws.bufferedAmount > 524288) {
            bridge.close();
            ws.terminate();
            return;
          }
          ws.send(JSON.stringify(message));
        },
        async (session, watchSignal) => {
          const { stdout } = await promisify(execFile)(
            "herdr",
            ["session", "list", "--json"],
            { timeout: 8000, maxBuffer: 1048576, signal: watchSignal },
          );
          const found = JSON.parse(stdout).sessions.find(
            (s: { name: string; running: boolean }) =>
              s.name === session && s.running,
          );
          if (!found?.socket_path) throw new Error("Session unavailable");
          return found.socket_path;
        },
      );
      let lastMessage = Date.now();
      const heartbeat = setInterval(() => {
        if (Date.now() - lastMessage > 30000) {
          bridge.close();
          ws.terminate();
        } else if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "ping" }));
      }, 10000);
      const stop = () => {
        bridge.close();
        ws.terminate();
      };
      signal.addEventListener("abort", stop, { once: true });
      ws.on("open", () => {
        ws.send(JSON.stringify({ type: "ping" }));
        retry = 1000;
        console.log(JSON.stringify({ event: "realtime_connected" }));
      });
      ws.on("message", (data) => {
        lastMessage = Date.now();
        try {
          bridge.receive(JSON.parse(String(data)));
        } catch {
          bridge.close();
          ws.terminate();
        }
      });
      ws.on("unexpected-response", (_request, response) => {
        bridge.close();
        authFailure = [401, 403].includes(response.statusCode ?? 0);
        response.destroy();
        ws.terminate();
      });
      ws.on("error", () => {});
      ws.on("close", () => {
        clearInterval(heartbeat);
        signal.removeEventListener("abort", stop);
        bridge.close();
        resolve();
      });
    });
    if (authFailure)
      throw new Error(
        "Realtime authentication rejected; fix secure configuration",
      );
    if (!signal.aborted) {
      await delay(retry, undefined, { signal }).catch(() => {});
      retry = Math.min(retry * 2, 30000);
    }
  }
}
