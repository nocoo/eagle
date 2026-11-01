// The daemon's HTTP surface and its upgrade (docs/bots/PROTOCOL.md "HTTP endpoints"):
// ready checks and the catalog, with the bearer token checked before anything else runs.
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { DirectoryError } from "../core/BotDirectory.ts";
import type { BotRegistry } from "../core/BotRegistry.ts";
import type { ConversationService } from "../core/ConversationService.ts";
import {
  BOT_SHAPES,
  BOT_TINTS,
  type BotShape,
  type BotTint,
  ClassifiedFailure,
  isThinkingLevel,
} from "../core/domain.ts";
import { declareEvent } from "../log/events.ts";
import type { Log } from "../log/log.ts";
import type { ServerEvent } from "../protocol/frames.ts";
import { MAX_HTTP_BODY_BYTES, MAX_LABEL_CHARS, MAX_TITLE_CHARS } from "../protocol/limits.ts";
import { PROTOCOL_VERSION } from "../protocol/version.ts";
import { parseBearer, tokenMatches } from "./auth.ts";
import { type Client, ClientError, type ClientScope, type ClientStore } from "./clients.ts";
import { serverFailure } from "./failures.ts";
import type { GatewayApi, GatewayInput } from "./gateway.ts";
import type { ProviderApi } from "./providers.ts";
import { attachConnection, CLOSE, MAX_CONNECTIONS, refuseUpgrade } from "./socket.ts";

const Events = {
  authFail: declareEvent("transport.auth.fail"),
  openReject: declareEvent("transport.conn.open.reject"),
} as const;

export type ServerOptions = {
  /** Host configuration identity, not a credential or authorization decision. */
  readonly deviceSocket?: string;
  readonly token: string;
  /** Named CLI credentials beside the token; the token itself is always `admin`. */
  readonly clients: ClientStore;
  readonly log: Log;
  readonly registry: BotRegistry;
  readonly service: ConversationService;
  readonly version: string;
  readonly instance: string;
  readonly capabilities: Readonly<Record<string, boolean>>;
  /** The model ids the configured gateway offers, for a per-bot picker. */
  readonly models?: () => Promise<readonly string[]>;
  /** The configured gateway's provider, so a per-bot model id keeps it. */
  readonly gatewayProvider?: () => string;
  /** Usage statistics for the Settings page; `days` is the requested window. */
  readonly usage?: (days: number) => Promise<unknown>;
  /** Third-party provider keys (search today, others later). */
  readonly providers?: ProviderApi;
  /** Model gateway settings, when the daemon was configured with a store. */
  readonly settings?: GatewayApi;
  /** The machine's own instructions, read from disk for the App's read-only preview. */
  readonly machinePrompt?: () => { readonly path: string; readonly text: string } | undefined;
  /** A bot's triggers: read-only detail for the app, and the person's one switch. */
  readonly triggers?: TriggerApi;
  /** The read side of bot-to-bot exchanges; absent in a build without a peer store. */
  readonly peers?: PeerApi;
  /** The inbound side: one webhook delivery, authenticated by its own trigger token. */
  readonly ingress?: TriggerIngress;
  readonly pid?: number;
  /** 0 asks the kernel for a free port, which is what tests do. */
  readonly port: number;
};

export type Daemon = {
  readonly server: Server;
  readonly port: number;
  /** Every catalog change reaches every connection as an absolute `bots` event. */
  broadcastCatalog(): void;
  close(): Promise<void>;
};

/** The only path that upgrades (PROTOCOL.md, "Transport"). */
export const SOCKET_PATH = "/v1/socket";

/** How long a shutdown waits for clients to acknowledge the close frame. */
const SHUTDOWN_GRACE_MS = 500;

const onceClosed = (socket: WebSocket): Promise<void> =>
  new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    socket.once("close", () => resolve());
  });

const json = (response: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  response.end(text);
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAX_HTTP_BODY_BYTES) throw new Error("body too large");
    chunks.push(buffer);
  }
  if (bytes === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};

/** A delivery's raw body: bytes, not JSON, with the delivery cap instead of the API's. */
const readDelivery = async (request: IncomingMessage): Promise<Buffer | undefined> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > MAX_DELIVERY_BYTES) return undefined;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
};

/** Only the documented string fields cross; anything else is a malformed request. */
const gatewayInput = (body: unknown): GatewayInput | undefined => {
  if (body === undefined) return {};
  if (typeof body !== "object" || body === null) return undefined;
  const raw = body as Record<string, unknown>;
  const input: {
    baseUrl?: string;
    apiKey?: string;
    model?: string;
    provider?: string;
    thinkingLevel?: string;
    toolGroups?: readonly string[];
    corePrompt?: string;
  } = {};
  for (const key of [
    "baseUrl",
    "apiKey",
    "model",
    "provider",
    "thinkingLevel",
    "corePrompt",
  ] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") return undefined;
    input[key] = value;
  }
  const groups = raw.toolGroups;
  if (groups !== undefined) {
    if (!Array.isArray(groups) || groups.some((name) => typeof name !== "string")) return undefined;
    input.toolGroups = groups as string[];
  }
  return input;
};

const groupTitle = (body: unknown): string | undefined => {
  if (!isObject(body)) return undefined;
  const value = body.title;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
};

const groupOrder = (body: unknown): readonly string[] | undefined => {
  if (!isObject(body)) return undefined;
  const ids = body.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) return undefined;
  return ids as string[];
};

const title = (body: unknown): string | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const value = (body as { title?: unknown }).title;
  return typeof value === "string" ? value.trim() : undefined;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Name, label and face are all editable; a label of `""` clears it. */
const updateChanges = (
  body: unknown,
):
  | {
      readonly title?: string;
      readonly label?: string | null;
      readonly appearance?: { shape: BotShape; tint: BotTint };
    }
  | undefined => {
  if (!isObject(body)) return undefined;
  const allowed = new Set(["title", "label", "appearance", "groupId", "model", "thinkingLevel"]);
  if (Object.keys(body).some((key) => !allowed.has(key))) return undefined;
  const changes: {
    title?: string;
    label?: string | null;
    appearance?: { shape: BotShape; tint: BotTint };
  } = {};
  let any = false;
  if (body.title !== undefined) {
    if (typeof body.title !== "string") return undefined;
    const title = body.title.trim();
    if (title.length === 0 || title.length > MAX_TITLE_CHARS) return undefined;
    changes.title = title;
    any = true;
  }
  if (body.label !== undefined) {
    if (typeof body.label !== "string") return undefined;
    const label = body.label.trim();
    if (label.length > MAX_LABEL_CHARS) return undefined;
    changes.label = label.length === 0 ? null : label;
    any = true;
  }
  if (body.appearance !== undefined) {
    const appearance = body.appearance;
    if (!isObject(appearance)) return undefined;
    if (
      typeof appearance.shape !== "string" ||
      !(BOT_SHAPES as readonly string[]).includes(appearance.shape) ||
      typeof appearance.tint !== "string" ||
      !(BOT_TINTS as readonly string[]).includes(appearance.tint)
    ) {
      return undefined;
    }
    changes.appearance = {
      shape: appearance.shape as BotShape,
      tint: appearance.tint as BotTint,
    };
    any = true;
  }
  return any ? changes : undefined;
};

/** `{ model, thinkingLevel }` in a bot patch: the bot's own agent choice. */
const agentChange = (
  body: unknown,
): { readonly modelId?: string; readonly thinkingLevel?: string } | undefined => {
  if (!isObject(body)) return undefined;
  const change: { modelId?: string; thinkingLevel?: string } = {};
  if (body.model !== undefined) {
    if (typeof body.model !== "string") return undefined;
    const modelId = body.model.trim();
    if (modelId.length === 0) return undefined;
    change.modelId = modelId;
  }
  if (body.thinkingLevel !== undefined) {
    const level = body.thinkingLevel;
    if (!isThinkingLevel(level)) return undefined;
    change.thinkingLevel = level;
  }
  return change.modelId === undefined && change.thinkingLevel === undefined ? undefined : change;
};

/** `{ groupId }` in a bot patch: a string files it, `null` clears it, absent changes nothing. */
const groupChange = (body: unknown): { readonly value: string | null } | undefined => {
  if (!isObject(body) || body.groupId === undefined) return undefined;
  if (body.groupId === null) return { value: null };
  if (typeof body.groupId !== "string") return undefined;
  const trimmed = body.groupId.trim();
  return { value: trimmed.length === 0 ? null : trimmed };
};

/** The optional label and face a create request may carry. */
const extras = (
  body: unknown,
): { label?: string; appearance?: { shape: BotShape; tint: BotTint } } | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const raw = body as { label?: unknown; appearance?: unknown };
  const result: { label?: string; appearance?: { shape: BotShape; tint: BotTint } } = {};
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string") return undefined;
    const label = raw.label.trim();
    if (label.length > MAX_LABEL_CHARS) return undefined;
    if (label.length > 0) result.label = label;
  }
  if (raw.appearance !== undefined) {
    const appearance = raw.appearance;
    if (typeof appearance !== "object" || appearance === null) return undefined;
    const face = appearance as { shape?: unknown; tint?: unknown };
    if (
      typeof face.shape !== "string" ||
      !(BOT_SHAPES as readonly string[]).includes(face.shape) ||
      typeof face.tint !== "string" ||
      !(BOT_TINTS as readonly string[]).includes(face.tint)
    ) {
      return undefined;
    }
    result.appearance = { shape: face.shape as BotShape, tint: face.tint as BotTint };
  }
  return result;
};

/** The app's only trigger surface: read detail, and switch one on or off. */
/** What the app reads about an exchange between bots (docs/bots/TRIGGERS.md §10). */
export type PeerApi = {
  readonly list: (botId: string) => Promise<readonly Record<string, unknown>[]>;
  /** Undefined when the exchange does not exist or this bot is not in it. */
  readonly detail: (
    botId: string,
    exchangeId: string,
  ) => Promise<Record<string, unknown> | undefined>;
};

export type TriggerApi = {
  readonly list: (botId: string) => Promise<readonly Record<string, unknown>[]>;
  /** Returns the updated entry, or undefined when the trigger is not this bot's. */
  readonly setEnabled: (
    botId: string,
    triggerId: string,
    enabled: boolean,
    trace: string,
  ) => Promise<Record<string, unknown> | undefined>;
};

/** What a delivery asked for, and what the daemon did with it. */
export type IngressOutcome =
  | { readonly kind: "queued"; readonly queued: number; readonly dropped: number }
  | { readonly kind: "unknown" }
  | { readonly kind: "disabled" }
  | { readonly kind: "queue_full" }
  | { readonly kind: "invalid"; readonly message: string };

export type TriggerIngress = {
  readonly deliver: (input: {
    readonly botId: string;
    readonly triggerId: string;
    /** The trigger's own bearer, compared in constant time by the implementation. */
    readonly token: string;
    readonly body: Buffer;
    readonly contentType: string | undefined;
    readonly idempotencyKey: string | undefined;
  }) => Promise<IngressOutcome>;
};

/** PROTOCOL.md, "Limits": a delivery is small; a bigger body is refused, not buffered. */
export const MAX_DELIVERY_BYTES = 64 * 1024;

const SCOPE_RANK: Readonly<Record<ClientScope, number>> = { read: 0, write: 1, admin: 2 };

/** Who presented the bearer: the App's own token, or one named CLI credential. */
type Actor =
  | { readonly kind: "root" }
  | {
      readonly kind: "client";
      readonly client: Client;
      readonly scopes: ReadonlySet<ClientScope>;
    };

/**
 * Which scope a route needs (PROTOCOL.md, "CLI clients and scopes"): `read` covers every
 * GET, `write` the catalog and conversation mutations, and `admin` the destructive, the
 * global and the credential routes. Every other mutation is a write.
 */
const requiredScope = (path: string, method: string): ClientScope => {
  if (method === "GET" || method === "HEAD") {
    // The credential list names every client, so it is one of the admin routes.
    return path === "/v1/clients" ? "admin" : "read";
  }
  if (path.startsWith("/v1/clients")) return "admin";
  if (path === "/v1/settings" || path === "/v1/settings/test") return "admin";
  // A provider probe spends a stored key, so it sits with the provider writes.
  if (path.startsWith("/v1/providers")) return "admin";
  if (method === "DELETE") return "admin";
  return "write";
};

export const startServer = async (options: ServerOptions): Promise<Daemon> => {
  const { log, registry, service, token } = options;
  let connections = 0;
  /** Upgrades accepted but not completed: a refused upgrade must not hold a slot. */
  let pending = 0;
  let closing = false;
  let shutdown: Promise<void> | undefined;
  const sockets = new Set<WebSocket>();
  /** One frame writer per live connection, for the daemon-wide catalog event. */
  const writers = new Map<WebSocket, (event: ServerEvent) => void>();
  const instance = options.instance ?? `i_${process.pid}`;
  let sequence = 0;

  const authenticate = async (header: string | undefined): Promise<Actor | undefined> => {
    const presented = parseBearer(header);
    if (presented === undefined) return undefined;
    // The App's own token comes first and keeps every right, exactly as it always did.
    if (tokenMatches(token, presented)) return { kind: "root" };
    // A credential store that cannot answer refuses the request: authentication errors
    // fail closed, and neither the route nor the upgrade may see a half-checked caller.
    const credential = await options.clients.authenticate(presented).catch(() => undefined);
    return credential === undefined
      ? undefined
      : { kind: "client", client: credential.client, scopes: credential.scopes };
  };

  // The scopes are additive: `write` includes `read`, `admin` includes both.
  const allows = (actor: Actor, scope: ClientScope): boolean =>
    actor.kind === "root" ||
    [...actor.scopes].some((held) => SCOPE_RANK[held] >= SCOPE_RANK[scope]);

  const server = createServer((request, response) => {
    void route(request, response);
  });
  const wss = new WebSocketServer({ noServer: true });

  const broadcastCatalog = (): void => {
    const bots = registry.summaries();
    // A transported catalog carries the sidebar groups; a registry without them (a stub in
    // a transport test) still announces its bots.
    const groups = typeof registry.groups === "function" ? registry.groups() : undefined;
    for (const writer of writers.values()) {
      writer(groups === undefined ? { type: "bots", bots } : { type: "bots", bots, groups });
    }
  };

  const route = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const path = (request.url ?? "/").split("?")[0] ?? "/";
    if (closing) {
      // PROTOCOL.md, "Close codes": the daemon is going away, so no new work is accepted.
      json(response, 503, {
        error: { kind: "internal", message: "the daemon is shutting down" },
      });
      return;
    }
    if (path === "/v1/health") {
      json(response, 200, {
        version: options.version,
        protocolVersion: PROTOCOL_VERSION,
        instance,
        pid: options.pid ?? process.pid,
        bots: registry.summaries().length,
        deviceAccess:
          options.deviceSocket === undefined
            ? null
            : {
                version: 1,
                binding: createHash("sha256").update(options.deviceSocket).digest("hex"),
              },
      });
      return;
    }
    const ingressMatch = /^\/v1\/triggers\/([A-Za-z0-9_-]+)\/(t_[A-Za-z0-9_-]{10})$/.exec(path);
    if (ingressMatch !== null && request.method === "POST") {
      const [, botId, triggerId] = ingressMatch as unknown as [string, string, string];
      if (options.ingress === undefined) {
        json(response, 404, { error: { kind: "unknown_bot", message: "no trigger ingress" } });
        return;
      }
      // A browser never posts here: an Origin header means a page, not a service.
      if (request.headers.origin !== undefined) {
        json(response, 403, { error: { kind: "auth_failed", message: "origin is not accepted" } });
        return;
      }
      const body = await readDelivery(request);
      if (body === undefined) {
        json(response, 413, { error: { kind: "limit_exceeded", message: "delivery too large" } });
        return;
      }
      const outcome = await options.ingress.deliver({
        botId,
        triggerId,
        token: parseBearer(request.headers.authorization) ?? "",
        body,
        contentType: request.headers["content-type"],
        idempotencyKey:
          typeof request.headers["idempotency-key"] === "string"
            ? request.headers["idempotency-key"]
            : undefined,
      });
      switch (outcome.kind) {
        case "queued":
          json(response, 202, { queued: outcome.queued, dropped: outcome.dropped });
          return;
        case "disabled":
          json(response, 409, { reason: "disabled" });
          return;
        case "queue_full":
          json(response, 429, { reason: "queue_full" });
          return;
        case "invalid":
          json(response, 422, { reason: outcome.message });
          return;
        case "unknown":
          // One answer for unknown bot, unknown trigger and wrong token: no oracle.
          json(response, 404, { error: { kind: "unknown_bot", message: "no such trigger" } });
          return;
      }
    }
    const actor = await authenticate(request.headers.authorization);
    if (actor === undefined) {
      log.emit("warn", "transport", Events.authFail, {
        trace: `tr_http_${process.pid}`,
        failure: serverFailure("auth_failed", "transport"),
        detail: { reason: "invalid" },
      });
      json(response, 401, {
        error: { kind: "auth_failed", message: "a bearer token is required" },
      });
      return;
    }
    const needed = requiredScope(path, request.method ?? "GET");
    if (!allows(actor, needed)) {
      // A missing scope mutates nothing: the refusal happens before any route runs.
      json(response, 403, {
        error: { kind: "auth_scope", message: `this credential needs the ${needed} scope` },
      });
      return;
    }
    try {
      if (path === "/v1/clients" && request.method === "GET") {
        json(response, 200, { clients: options.clients.list() });
        return;
      }
      if (path === "/v1/clients" && request.method === "POST") {
        const created = await options.clients.create(await readBody(request));
        json(response, 201, { client: created.client, token: created.token });
        return;
      }
      if (path === "/v1/clients/me" && request.method === "GET") {
        json(response, 200, { client: actor.kind === "client" ? actor.client : null });
        return;
      }
      const rotateMatch = /^\/v1\/clients\/(c_[A-Za-z0-9-]+)\/rotate$/.exec(path);
      if (rotateMatch !== null && request.method === "POST") {
        const rotated = await options.clients.rotate(rotateMatch[1] as string);
        json(response, 200, { client: rotated.client, token: rotated.token });
        return;
      }
      const revokeMatch = /^\/v1\/clients\/(c_[A-Za-z0-9-]+)\/revoke$/.exec(path);
      if (revokeMatch !== null && request.method === "POST") {
        json(response, 200, { client: await options.clients.revoke(revokeMatch[1] as string) });
        return;
      }
      const clientMatch = /^\/v1\/clients\/(c_[A-Za-z0-9-]+)$/.exec(path);
      if (clientMatch !== null && request.method === "DELETE") {
        await options.clients.remove(clientMatch[1] as string);
        response.writeHead(204).end();
        return;
      }
      if (path === "/v1/settings" && request.method === "GET") {
        json(response, 200, {
          settings: options.settings?.public() ?? {
            configured: false,
            provider: "magpie",
            baseUrl: "",
            model: "",
            hasApiKey: false,
          },
          machinePrompt: options.machinePrompt?.() ?? null,
        });
        return;
      }
      if (path === "/v1/settings" && request.method === "PUT") {
        if (options.settings === undefined) {
          json(response, 404, { error: { kind: "unknown_bot", message: "no such endpoint" } });
          return;
        }
        const input = gatewayInput(await readBody(request));
        if (input === undefined) {
          json(response, 400, {
            error: { kind: "invalid_command", message: "settings must be strings" },
          });
          return;
        }
        const saved = await options.settings.save(input);
        if (saved.error !== undefined) {
          json(response, 400, {
            error: { kind: "invalid_command", message: saved.error },
          });
          return;
        }
        broadcastCatalog();
        json(response, 200, {
          settings: saved.settings,
          machinePrompt: options.machinePrompt?.() ?? null,
        });
        return;
      }
      if (path === "/v1/settings/test" && request.method === "POST") {
        if (options.settings === undefined) {
          json(response, 404, { error: { kind: "unknown_bot", message: "no such endpoint" } });
          return;
        }
        const input = gatewayInput(await readBody(request));
        if (input === undefined) {
          json(response, 400, {
            error: { kind: "invalid_command", message: "settings must be strings" },
          });
          return;
        }
        json(response, 200, { result: await options.settings.test(input) });
        return;
      }
      if (path === "/v1/providers" && request.method === "GET") {
        json(response, 200, { providers: options.providers?.public() ?? [] });
        return;
      }
      const providerMatch = /^\/v1\/providers\/([A-Za-z0-9_-]+)(?:\/(test))?$/.exec(path);
      if (providerMatch !== null) {
        const id = providerMatch[1] as string;
        const probe = providerMatch[2] === "test";
        if (options.providers === undefined) {
          json(response, 404, { error: { kind: "unknown_bot", message: "no such endpoint" } });
          return;
        }
        if (probe && request.method === "POST") {
          json(response, 200, { result: await options.providers.test(id) });
          return;
        }
        if (!probe && request.method === "PUT") {
          const body = await readBody(request);
          if (
            !isObject(body) ||
            Object.keys(body).some((key) => !["apiKey", "enabled"].includes(key))
          ) {
            json(response, 400, {
              error: {
                kind: "invalid_command",
                message: "send an apiKey, an enabled flag, or both",
              },
            });
            return;
          }
          const input: { apiKey?: string; enabled?: boolean } = {};
          if (body.apiKey !== undefined) {
            if (typeof body.apiKey !== "string") {
              json(response, 400, {
                error: { kind: "invalid_command", message: "apiKey must be a string" },
              });
              return;
            }
            input.apiKey = body.apiKey;
          }
          if (body.enabled !== undefined) {
            if (typeof body.enabled !== "boolean") {
              json(response, 400, {
                error: { kind: "invalid_command", message: "enabled must be a boolean" },
              });
              return;
            }
            input.enabled = body.enabled;
          }
          const saved = await options.providers.save(id, input);
          if (saved.error !== undefined) {
            json(response, 400, { error: { kind: "invalid_command", message: saved.error } });
            return;
          }
          json(response, 200, { provider: saved.provider });
          return;
        }
      }
      if (path === "/v1/usage" && request.method === "GET") {
        const requested = Number(new URL(request.url ?? "/", "http://x").searchParams.get("days"));
        const days = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 90) : 30;
        json(response, 200, {
          usage: options.usage === undefined ? undefined : await options.usage(days),
        });
        return;
      }
      if (path === "/v1/models" && request.method === "GET") {
        json(response, 200, { models: options.models === undefined ? [] : await options.models() });
        return;
      }
      if (path === "/v1/bots" && request.method === "GET") {
        json(response, 200, {
          bots: registry.summaries(),
          ...(typeof registry.groups === "function" ? { groups: registry.groups() } : {}),
        });
        return;
      }
      if (path === "/v1/bots" && request.method === "POST") {
        const body = await readBody(request);
        const name = title(body);
        if (name === undefined || name.length === 0 || name.length > MAX_TITLE_CHARS) {
          json(response, 400, {
            error: { kind: "invalid_command", message: "a title is required" },
          });
          return;
        }
        const face = extras(body);
        if (face === undefined) {
          json(response, 400, {
            error: {
              kind: "invalid_command",
              message: `a label is at most ${MAX_LABEL_CHARS} characters and a face is one of the documented shapes and tints`,
            },
          });
          return;
        }
        const bot = await registry.create(name, `tr_http_${++sequence}`, face);
        broadcastCatalog();
        json(response, 201, { bot });
        return;
      }
      if (path === "/v1/groups" && request.method === "POST") {
        const title = groupTitle(await readBody(request));
        if (title === undefined) {
          json(response, 400, {
            error: { kind: "invalid_command", message: "a group title is required" },
          });
          return;
        }
        const group = await registry.createGroup(title, `tr_http_${++sequence}`);
        broadcastCatalog();
        json(response, 201, { group });
        return;
      }
      if (path === "/v1/groups/order" && request.method === "PUT") {
        const ids = await groupOrder(await readBody(request));
        if (ids === undefined) {
          json(response, 400, {
            error: { kind: "invalid_command", message: "send the group ids in display order" },
          });
          return;
        }
        const groups = await registry.reorderGroups(ids, `tr_http_${++sequence}`);
        broadcastCatalog();
        json(response, 200, { groups });
        return;
      }
      if (path === "/v1/triggers" && request.method === "GET") {
        const botId = new URL(request.url ?? "/", "http://127.0.0.1").searchParams.get("botId");
        if (botId === null || botId.length === 0) {
          json(response, 400, {
            error: { kind: "invalid_command", message: "botId is required" },
          });
          return;
        }
        if (options.triggers === undefined) {
          json(response, 404, { error: { kind: "unknown_bot", message: "no trigger storage" } });
          return;
        }
        json(response, 200, { triggers: await options.triggers.list(botId) });
        return;
      }
      const exchangesMatch = /^\/v1\/bots\/([A-Za-z0-9_-]+)\/exchanges$/.exec(path);
      if (exchangesMatch !== null && request.method === "GET") {
        const botId = exchangesMatch[1] as string;
        if (options.peers === undefined) {
          json(response, 404, { error: { kind: "unknown_bot", message: "no peer storage" } });
          return;
        }
        json(response, 200, { exchanges: await options.peers.list(botId) });
        return;
      }
      const exchangeMatch = /^\/v1\/bots\/([A-Za-z0-9_-]+)\/exchanges\/(x_[0-9a-f]{12})$/.exec(
        path,
      );
      if (exchangeMatch !== null && request.method === "GET") {
        const [, botId, exchangeId] = exchangeMatch as unknown as [string, string, string];
        if (options.peers === undefined) {
          json(response, 404, { error: { kind: "unknown_bot", message: "no peer storage" } });
          return;
        }
        const exchange = await options.peers.detail(botId, exchangeId);
        if (exchange === undefined) {
          json(response, 404, { error: { kind: "unknown_bot", message: "no such exchange" } });
          return;
        }
        json(response, 200, { exchange });
        return;
      }
      const triggerMatch = /^\/v1\/triggers\/([A-Za-z0-9_-]+)\/(t_[A-Za-z0-9_-]{10})$/.exec(path);
      if (triggerMatch !== null && request.method === "PATCH") {
        const [, botId, triggerId] = triggerMatch as unknown as [string, string, string];
        const body = await readBody(request);
        const enabled = isObject(body) ? body.enabled : undefined;
        if (typeof enabled !== "boolean" || Object.keys(body as object).length !== 1) {
          json(response, 400, {
            error: { kind: "invalid_command", message: "send only { enabled: true|false }" },
          });
          return;
        }
        if (options.triggers === undefined) {
          json(response, 404, { error: { kind: "unknown_bot", message: "no trigger storage" } });
          return;
        }
        const trigger = await options.triggers.setEnabled(
          botId,
          triggerId,
          enabled,
          `tr_http_${++sequence}`,
        );
        if (trigger === undefined) {
          json(response, 404, { error: { kind: "unknown_bot", message: "no such trigger" } });
          return;
        }
        json(response, 200, { trigger });
        return;
      }
      const taskMatch = /^\/v1\/bots\/([A-Za-z0-9_-]+)\/tasks\/(t_\d+)\/(retry|abort)$/.exec(path);
      if (taskMatch !== null && request.method === "POST") {
        const [, botId, taskId, action] = taskMatch as unknown as [string, string, string, string];
        const trace = `tr_http_${++sequence}`;
        if (action === "retry") await registry.retryTask(botId, taskId, trace);
        else await registry.abortTask(botId, taskId, trace);
        response.writeHead(204).end();
        return;
      }
      const groupMatch = /^\/v1\/groups\/([A-Za-z0-9_-]+)$/.exec(path);
      if (groupMatch !== null) {
        const groupId = groupMatch[1] as string;
        if (request.method === "PATCH") {
          const title = groupTitle(await readBody(request));
          if (title === undefined) {
            json(response, 400, {
              error: { kind: "invalid_command", message: "a group title is required" },
            });
            return;
          }
          const group = await registry.renameGroup(groupId, title, `tr_http_${++sequence}`);
          broadcastCatalog();
          json(response, 200, { group });
          return;
        }
        if (request.method === "DELETE") {
          await registry.deleteGroup(groupId, `tr_http_${++sequence}`);
          broadcastCatalog();
          response.writeHead(204).end();
          return;
        }
      }
      const match = /^\/v1\/bots\/([A-Za-z0-9_-]+)$/.exec(path);
      if (match !== null) {
        const id = match[1] as string;
        if (request.method === "PATCH") {
          const body = await readBody(request);
          const changes = updateChanges(body);
          const group = groupChange(body);
          const agent = agentChange(body);
          if (changes === undefined && group === undefined && agent === undefined) {
            json(response, 400, {
              error: {
                kind: "invalid_command",
                message:
                  "send a title, a label (max 24 characters), a face (one of the documented shapes and tints) or a groupId",
              },
            });
            return;
          }
          const trace = `tr_http_${++sequence}`;
          let bot = changes === undefined ? undefined : await registry.update(id, changes, trace);
          if (group !== undefined) bot = await registry.moveBot(id, group.value, trace);
          if (agent !== undefined) {
            const model =
              agent.modelId === undefined || options.gatewayProvider === undefined
                ? undefined
                : { provider: options.gatewayProvider(), modelId: agent.modelId };
            bot = await registry.setAgent(
              id,
              {
                ...(model === undefined ? {} : { model }),
                ...(agent.thinkingLevel === undefined
                  ? {}
                  : { thinkingLevel: agent.thinkingLevel }),
              },
              trace,
            );
          }
          broadcastCatalog();
          json(response, 200, { bot });
          return;
        }
        if (request.method === "DELETE") {
          await registry.remove(id, `tr_http_${++sequence}`);
          broadcastCatalog();
          response.writeHead(204).end();
          return;
        }
      }
      json(response, 404, { error: { kind: "unknown_bot", message: "no such endpoint" } });
    } catch (error) {
      if (error instanceof ClientError) {
        // An unknown id is a 404 like any other; a live credential is refused with its own
        // kind so the App can offer "revoke first" instead of a generic refusal.
        const status =
          error.reason === "unknown_client" ? 404 : error.reason === "client_active" ? 409 : 400;
        const kind =
          error.reason === "unknown_client"
            ? "unknown_bot"
            : error.reason === "client_active"
              ? "client_active"
              : "invalid_command";
        json(response, status, { error: { kind, message: error.message } });
        return;
      }
      if (error instanceof DirectoryError) {
        const status =
          error.reason === "group_not_empty"
            ? 409
            : error.reason === "group_not_found" || error.reason === "unknown_bot"
              ? 404
              : error.reason === "invalid_groups" ||
                  error.reason === "limit_exceeded" ||
                  error.reason === "duplicate_bot"
                ? 400
                : 500;
        const kind =
          error.reason === "group_not_empty"
            ? "invalid_command"
            : error.reason === "group_not_found" || error.reason === "unknown_bot"
              ? "unknown_bot"
              : error.reason === "invalid_groups" ||
                  error.reason === "limit_exceeded" ||
                  error.reason === "duplicate_bot"
                ? "invalid_command"
                : "storage_failed";
        json(response, status, { error: { kind, message: error.message } });
        return;
      }
      const classified = error instanceof ClassifiedFailure ? error : undefined;
      const kind = classified?.failure.kind ?? "storage_failed";
      const status =
        kind === "unknown_bot"
          ? 404
          : kind === "internal"
            ? 409
            : kind === "limit_exceeded" || kind === "invalid_command"
              ? 400
              : 500;
      json(response, status, {
        error: { kind, message: classified?.message ?? "the request failed" },
      });
    }
  };

  const upgrade = async (request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> => {
    if (closing) {
      refuseUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    if ((request.url ?? "").split("?")[0] !== SOCKET_PATH) {
      // One socket endpoint, one protocol (PROTOCOL.md, "Transport"): anything else is a
      // client pointed at the wrong path, not a second protocol.
      refuseUpgrade(socket, 404, "Not Found");
      return;
    }
    const actor = await authenticate(request.headers.authorization);
    if (actor === undefined) {
      log.emit("warn", "transport", Events.authFail, {
        trace: `tr_http_${process.pid}`,
        failure: serverFailure("auth_failed", "transport"),
        detail: { reason: "invalid" },
      });
      refuseUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (connections + pending >= MAX_CONNECTIONS) {
      log.emit("warn", "transport", Events.openReject, {
        trace: `tr_http_${process.pid}`,
        failure: serverFailure("limit_exceeded", "transport"),
        detail: { reason: "queue_overflow" },
      });
      refuseUpgrade(socket, 503, "Service Unavailable");
      return;
    }
    pending += 1;
    // A handshake ws refuses (bad headers, wrong method) aborts the socket without ever
    // calling back, so the slot has to be released from the socket's own close event.
    let upgraded = false;
    socket.once("close", () => {
      if (!upgraded) pending = Math.max(0, pending - 1);
    });
    wss.handleUpgrade(request, socket, head, (ws) => {
      upgraded = true;
      pending = Math.max(0, pending - 1);
      connections += 1;
      const connId = `c_${++sequence}`;
      const write = attachConnection(ws, {
        log,
        service,
        registry,
        connId,
        server: { version: options.version, instance, pid: options.pid ?? process.pid },
        capabilities: options.capabilities,
        canWrite: allows(actor, "write"),
        ...(actor.kind === "client" ? { label: actor.client.name } : {}),
        register: (socket) => {
          sockets.add(socket);
        },
        unregister: (socket) => {
          sockets.delete(socket);
          writers.delete(socket);
          connections = Math.max(0, connections - 1);
        },
      });
      writers.set(ws, write);
    });
  };

  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    void upgrade(request, socket, head);
  });

  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const stop = async (): Promise<void> => {
    closing = true;
    const open = [...sockets];
    // Tell every client the daemon is going away (4001/4010 in PROTOCOL.md) instead of
    // dropping the TCP connection: a terminate reads as a crash and skips the backoff.
    for (const socket of open) {
      if (socket.readyState === WebSocket.OPEN) socket.close(CLOSE.shutdown, "shutdown");
    }
    await Promise.race([
      Promise.all(open.map((socket) => onceClosed(socket))),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_GRACE_MS);
        timer.unref?.();
      }),
    ]);
    for (const socket of sockets) socket.terminate();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return {
    server,
    port,
    broadcastCatalog,
    close: () => {
      shutdown ??= stop();
      return shutdown;
    },
  };
};
