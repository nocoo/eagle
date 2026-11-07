// The three observation routes (SG-002 protocol §2–§6). They live in the daemon's own
// HTTP surface and add only what the contract froze: a dedicated credential, loopback
// Host/Origin checks, typed errors and the three read operations.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { Log } from "../log/log.ts";
import { type BotSource, compareFleet } from "./changes.ts";
import { readObservationCredential, sourceIdOf } from "./credential.ts";
import { BaselineError, type BotPosition, decodeBaseline, encodeBaseline } from "./cursor.ts";
import { BASELINE_BODY_BYTES, RESPONSE_BYTES } from "./schema.ts";
import { inspectStore, readHistoryPage, readSnapshotFacts } from "./store.ts";

export const OBSERVATION_PREFIX = "/v1/observe/";
const PROTOCOL_VERSION = 1;
const SNAPSHOT_BOTS = 200;
const SCOPES_PER_PAGE = 500;
const HISTORY_LIMIT = { default: 50, max: 200 } as const;
const CHANGES_LIMIT = { default: 100, max: 500 } as const;

export type ObservationBot = {
  readonly id: string;
  readonly title: string;
  readonly updatedAt?: string;
};

export type ObservationOptions = {
  /** The daemon root that owns the credential, the identity and the Bots. */
  readonly root: string;
  readonly version: string;
  /** The actual bound endpoint, so a relay at another port cannot pass the Host check. */
  readonly endpoint: () => string;
  readonly sessionPath: (botId: string) => string;
  readonly bots: () => readonly ObservationBot[];
  /** A digest of the catalog file bytes, as the baseline records it. */
  readonly catalogRevision: () => Promise<string>;
  readonly log: Log;
};

type Reply = { readonly status: number; readonly body: unknown };

const error = (status: number, code: string, detail: string, extra?: object): Reply => ({
  status,
  body: { protocolVersion: PROTOCOL_VERSION, error: { code, detail }, ...extra },
});

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(encoded)),
    "cache-control": "no-store",
  });
  response.end(encoded);
};

const sourceOf = (
  root: string,
  epoch: string,
): { id: string; epoch: string; capturedAt: number } => ({
  id: sourceIdOf(root),
  epoch,
  capturedAt: Date.now(),
});

const limitOf = (
  raw: string | null,
  bounds: { readonly default: number; readonly max: number },
  operation: string,
): number | Reply => {
  if (raw === null) return bounds.default;
  if (!/^[0-9]+$/.test(raw))
    return error(422, "limit_invalid", `${operation} limit must be an integer`);
  const value = Number(raw);
  if (value < 1 || value > bounds.max) {
    return error(
      422,
      "limit_invalid",
      `${operation} limit must be an integer between 1 and ${bounds.max}`,
    );
  }
  return value;
};

const readBody = async (request: IncomingMessage): Promise<string | undefined> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > BASELINE_BODY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
};

export type ObservationRoutes = {
  /** True for the three frozen routes; every other path keeps its existing behavior. */
  owns(path: string): boolean;
  /** True when this bearer is the observation credential, so another route can refuse it. */
  recognizes(bearer: string): Promise<boolean>;
  handle(request: IncomingMessage, response: ServerResponse): Promise<void>;
};

export const createObservationRoutes = (options: ObservationOptions): ObservationRoutes => {
  const reply = (response: ServerResponse, value: Reply): void => {
    // A reader that hung up cancels only its read; nothing is written into a dead socket.
    if (response.writableEnded || response.destroyed) return;
    const body = JSON.stringify(value.body);
    if (Buffer.byteLength(body) <= RESPONSE_BYTES) {
      json(response, value.status, value.body);
      return;
    }
    json(response, 422, {
      protocolVersion: PROTOCOL_VERSION,
      error: { code: "limit_invalid", detail: "request fewer entries per page" },
    });
  };

  const guard = async (request: IncomingMessage): Promise<Reply | undefined> => {
    const host = request.headers.host;
    if (host !== options.endpoint()) {
      return error(403, "host_refused", "this endpoint does not own the daemon root");
    }
    if (request.headers.origin !== undefined) {
      return error(403, "origin_refused", "a service does not send an Origin header");
    }
    const credential = await readObservationCredential(options.root).catch(() => undefined);
    const bearer = /^Bearer (\S+)$/.exec((request.headers.authorization ?? "").trim())?.[1];
    if (credential === undefined) {
      return error(401, "unauthenticated", "observation credential missing or wrong");
    }
    if (bearer === undefined) {
      return error(401, "unauthenticated", "observation credential missing or wrong");
    }
    if (bearer !== credential.token) {
      return error(403, "credential_kind", "this credential is not valid on this route");
    }
    return undefined;
  };

  const snapshot = async (request: IncomingMessage): Promise<Reply> => {
    const credential = await readObservationCredential(options.root);
    if (credential === undefined) {
      return error(401, "unauthenticated", "observation credential missing or wrong");
    }
    const catalog = await options.catalogRevision();
    const firstPass = catalog;
    const bots = options.bots();
    const delivered = bots.slice(0, SNAPSHOT_BOTS);
    const entries = await Promise.all(
      delivered.map(async (bot) => {
        const path = options.sessionPath(bot.id);
        const state = await inspectStore(path);
        if (state.state !== "available") {
          return { bot, state, facts: undefined };
        }
        return { bot, state, facts: await readSnapshotFacts(path) };
      }),
    );
    const secondPass = await options.catalogRevision();
    const positions: Record<string, BotPosition> = {};
    const body = {
      protocolVersion: PROTOCOL_VERSION,
      kind: "snapshot",
      source: sourceOf(options.root, credential.storeId),
      catalog: { revision: catalog, bots: bots.length },
      consistent: firstPass === secondPass,
      bots: entries.map((entry) => {
        if (entry.state.state !== "available" || entry.facts === undefined) {
          return {
            botId: entry.bot.id,
            title: entry.bot.title,
            activity: "unknown",
            store: {
              state: entry.state.state,
              ...(entry.state.schemaVersion === undefined
                ? {}
                : { schemaVersion: entry.state.schemaVersion }),
            },
            ...(entry.bot.updatedAt === undefined ? {} : { updatedAt: entry.bot.updatedAt }),
          };
        }
        positions[entry.bot.id] = {
          incarnation: entry.state.incarnation ?? "",
          generation: entry.facts.generation,
          state: "available",
          activity: entry.facts.activity,
        };
        return {
          botId: entry.bot.id,
          title: entry.bot.title,
          activity: entry.facts.activity,
          store: {
            state: "available",
            schemaVersion: entry.state.schemaVersion,
            incarnation: entry.state.incarnation,
          },
          coverage: {
            scopes: entry.facts.scopes.length,
            entries: entry.facts.entries,
            newestEntryId: entry.facts.newestEntryId,
            generation: entry.facts.generation,
          },
          ...(entry.bot.updatedAt === undefined ? {} : { updatedAt: entry.bot.updatedAt }),
        };
      }),
      botsTotal: bots.length,
      truncated: bots.length > SNAPSHOT_BOTS,
      cursor: encodeBaseline({
        id: sourceIdOf(options.root),
        epoch: credential.storeId,
        catalog: secondPass,
        positions,
      }),
      lag: 0,
    };
    void request;
    return { status: 200, body };
  };

  const history = async (url: URL): Promise<Reply> => {
    const credential = await readObservationCredential(options.root);
    if (credential === undefined) {
      return error(401, "unauthenticated", "observation credential missing or wrong");
    }
    const allowed = new Set([
      "botId",
      "scope",
      "scopeAfter",
      "before",
      "limit",
      "incarnation",
      "newest",
    ]);
    for (const key of url.searchParams.keys()) {
      if (!allowed.has(key)) return error(422, "query_invalid", "unknown query parameter");
    }
    const botId = url.searchParams.get("botId");
    if (botId === null) return error(422, "query_invalid", "botId is required");
    const bot = options.bots().find((candidate) => candidate.id === botId);
    if (bot === undefined) return error(404, "unknown_bot", "no such bot");
    const limit = limitOf(url.searchParams.get("limit"), HISTORY_LIMIT, "history");
    if (typeof limit !== "number") return limit;
    const path = options.sessionPath(bot.id);
    const state = await inspectStore(path);
    if (state.state !== "available") {
      return error(503, "provider_unavailable", "the bot store cannot be read now", {
        store: { state: state.state },
      });
    }
    const scopeId = url.searchParams.get("scope") ?? "root";
    const before = url.searchParams.get("before");
    const incarnation = url.searchParams.get("incarnation");
    const newest = url.searchParams.get("newest");
    if (before !== null && (incarnation === null || newest === null)) {
      return error(422, "query_invalid", "before needs the page's incarnation and newest");
    }
    const page = await readHistoryPage(path, {
      scopeId,
      limit,
      before,
      maxBytes: RESPONSE_BYTES - 32 * 1024,
    });
    const resolved =
      scopeId === "root" ? page.scopes.find((scope) => scope.kind === "root")?.id : scopeId;
    if (resolved === undefined || !page.scopes.some((scope) => scope.id === resolved)) {
      return error(404, "unknown_scope", "no such conversation scope for this bot");
    }
    if (incarnation !== null && incarnation !== state.incarnation) {
      return error(
        409,
        "stale_page",
        "the store changed between pages; restart from the newest page",
      );
    }
    if (newest !== null && page.boundary.newestEntryId !== null) {
      const current = Number(page.boundary.newestEntryId.replace(/^e_/, ""));
      const pinned = Number(newest.replace(/^e_/, ""));
      if (Number.isFinite(current) && Number.isFinite(pinned) && current < pinned) {
        return error(
          409,
          "stale_page",
          "the store changed between pages; restart from the newest page",
        );
      }
    }
    // Scope enumeration is bounded and continued, so no scope becomes unreachable.
    const scopeAfter = url.searchParams.get("scopeAfter");
    const startAt =
      scopeAfter === null ? 0 : page.scopes.findIndex((scope) => scope.id === scopeAfter) + 1;
    const fromIndex = startAt <= 0 && scopeAfter !== null ? page.scopes.length : startAt;
    const listed = page.scopes.slice(fromIndex, fromIndex + SCOPES_PER_PAGE);
    const moreScopes = fromIndex + SCOPES_PER_PAGE < page.scopes.length;
    return {
      status: 200,
      body: {
        protocolVersion: PROTOCOL_VERSION,
        kind: "history",
        source: sourceOf(options.root, credential.storeId),
        botId: bot.id,
        incarnation: state.incarnation,
        scope: {
          id: resolved,
          kind: page.scopes.find((scope) => scope.id === resolved)?.kind ?? "child",
        },
        scopes: listed,
        scopesNext: moreScopes ? { afterScopeId: listed.at(-1)?.id ?? null } : null,
        boundary: page.boundary,
        messages: page.messages,
        omitted: page.omitted,
        ...(page.next === undefined ? {} : { next: page.next }),
        coverage: moreScopes ? { ...page.coverage, scopes: "truncated" } : page.coverage,
      },
    };
  };

  const changes = async (request: IncomingMessage): Promise<Reply> => {
    const credential = await readObservationCredential(options.root);
    if (credential === undefined) {
      return error(401, "unauthenticated", "observation credential missing or wrong");
    }
    const raw = await readBody(request);
    if (raw === undefined) return error(413, "body_refused", "the baseline body is too large");
    let parsed: { cursor?: unknown; limit?: unknown };
    try {
      parsed = JSON.parse(raw) as { cursor?: unknown; limit?: unknown };
    } catch {
      return error(422, "query_invalid", "the body must be JSON");
    }
    if (typeof parsed.cursor !== "string") {
      return error(422, "query_invalid", "cursor is required");
    }
    const limit = parsed.limit === undefined ? CHANGES_LIMIT.default : parsed.limit;
    if (
      typeof limit !== "number" ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > CHANGES_LIMIT.max
    ) {
      return error(
        422,
        "limit_invalid",
        `changes limit must be an integer between 1 and ${CHANGES_LIMIT.max}`,
      );
    }
    let baseline: ReturnType<typeof decodeBaseline>;
    try {
      baseline = decodeBaseline(parsed.cursor);
    } catch (cause) {
      if (cause instanceof BaselineError) {
        return error(409, cause.reason, "the baseline does not describe this source");
      }
      throw cause;
    }
    if (baseline.id !== sourceIdOf(options.root)) {
      return error(409, "cursor_invalid", "baseline is bound to another source");
    }
    if (baseline.epoch !== credential.storeId) {
      return error(409, "cursor_reset", "the source epoch changed; read a new baseline");
    }
    const sources: BotSource[] = options.bots().map((bot) => ({
      botId: bot.id,
      sessionPath: options.sessionPath(bot.id),
    }));
    const comparison = await compareFleet({
      baseline,
      sources,
      catalog: await options.catalogRevision(),
      limit,
    });
    const replaced = comparison.changes.filter((change) => change.kind === "storage_replaced");
    if (replaced.length > 0) {
      return error(409, "cursor_reset", "a bot store was replaced; read a new baseline");
    }
    return {
      status: 200,
      body: {
        protocolVersion: PROTOCOL_VERSION,
        kind: "changes",
        source: sourceOf(options.root, credential.storeId),
        changes: comparison.changes,
        next: {
          cursor: encodeBaseline({
            id: sourceIdOf(options.root),
            epoch: credential.storeId,
            catalog: await options.catalogRevision(),
            positions: comparison.next,
          }),
        },
        coverage: {
          complete: !comparison.pageLimitReached,
          reasons: comparison.pageLimitReached ? ["page_limit"] : [],
        },
      },
    };
  };

  return {
    async recognizes(bearer) {
      const credential = await readObservationCredential(options.root).catch(() => undefined);
      return credential !== undefined && credential.token === bearer;
    },
    owns: (path) =>
      path === `${OBSERVATION_PREFIX}snapshot` ||
      path === `${OBSERVATION_PREFIX}history` ||
      path === `${OBSERVATION_PREFIX}changes`,
    async handle(request, response) {
      const path = (request.url ?? "/").split("?")[0] ?? "/";
      const method = request.method ?? "GET";
      if (method !== "GET" && !(path === `${OBSERVATION_PREFIX}changes` && method === "POST")) {
        reply(response, error(405, "query_invalid", "this route accepts GET, or POST for changes"));
        return;
      }
      const refused = await guard(request);
      if (refused !== undefined) {
        reply(response, refused);
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const result =
        path === `${OBSERVATION_PREFIX}snapshot`
          ? await snapshot(request)
          : path === `${OBSERVATION_PREFIX}history`
            ? await history(url)
            : await changes(request);
      reply(response, result);
    },
  };
};

/** The catalog digest a baseline records: the file's bytes, not a timestamp. */
export const catalogDigest = (body: string): string =>
  createHash("sha256").update(body).digest("hex").slice(0, 16);

export const sessionPathOf = (botDir: string): string => join(botDir, "session.sqlite");
