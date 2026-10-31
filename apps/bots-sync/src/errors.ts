import { randomUUID } from "node:crypto";
import { z } from "zod";
export class CacheError extends Error {
  readonly status: number;
  constructor(status: number, message: string, options?: ErrorOptions) {
    super(message, options);
    this.status = status;
  }
}
export const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
export function context(request: Request) {
  const trace = request.headers.get("x-bots-sync-trace");
  const botId = request.headers.get("x-bots-sync-bot");
  return {
    trace: trace && /^tr_[A-Za-z0-9_-]{1,128}$/.test(trace) ? trace : `tr_cache_${randomUUID()}`,
    ...(botId && /^b_[A-Za-z0-9_-]{1,128}$/.test(botId) ? { botId } : {}),
  };
}
export function failure(error: unknown, request: Request): Response {
  const status =
    error instanceof CacheError
      ? error.status
      : error instanceof z.ZodError || error instanceof SyntaxError
        ? 400
        : 403;
  const code =
    error instanceof Error && /^sync_[a-z_]+$/.test(error.message)
      ? error.message
      : "sync_cache_invalid";
  const fields = context(request);
  const failure = {
    id: `f_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
    kind:
      status >= 500
        ? code === "sync_cache_registry_unreachable" || code === "sync_relay_registry_unreachable"
          ? "internal"
          : "storage_failed"
        : "auth_failed",
    layer: "runtime",
  };
  // Keep the original local cause on CacheError; only bounded codes/identity cross the log/wire.
  console.error(
    JSON.stringify({
      level: "error",
      layer: "runtime",
      evt: "runtime.sync.fail",
      ...fields,
      err: { kind: failure.kind, failure: failure.id, origin: true },
      detail: { reason: "upstream", providerCode: code.slice(0, 40) },
    }),
  );
  return json({ error: { code, failure }, trace: fields.trace }, status);
}
