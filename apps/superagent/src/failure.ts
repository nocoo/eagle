import { type FailureCode, ServiceError } from "./domain.ts";

export function modelFailure(detail: unknown): FailureCode {
  const text = typeof detail === "string" ? detail : JSON.stringify(detail ?? "");
  if (/\b(401|403)\b|unauthori[sz]ed|invalid.api.key/i.test(text)) return "model_authentication";
  if (/timed?\s*out|timeout/i.test(text)) return "model_timeout";
  return "model_error";
}

export async function confirmedWithin<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ServiceError("cancellation_unconfirmed")), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
