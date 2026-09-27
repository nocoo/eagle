import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { resolveAiConfig } from "@nocoo/next-ai/server";
import { APICallError, generateText } from "ai";
import {
  type DailyReport,
  type DailySettings,
  dailyCutoff,
  dailyPrompt,
  dueDate,
  parseDailyReport,
  REPORT_TIMEZONE,
  TEMPLATE_VERSION,
} from "../shared/daily.ts";
import { digest } from "../shared/summaries.ts";
import { withAiKey } from "./ai-secret.ts";
import { containsCredential } from "./auth.ts";

export function aiConfig(settings: DailySettings, key: string) {
  const config = resolveAiConfig({ ...settings, apiKey: key });
  const url = new URL(config.baseURL);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !url.hostname.includes(".") ||
    /^[\d.]+$/.test(url.hostname) ||
    url.hostname.includes(":") ||
    /(^|\.)(localhost|local|internal|lan)$/.test(url.hostname)
  )
    throw new Error("Public HTTPS AI endpoint required");
  return config;
}
export function aiReady(settings: DailySettings, env: Env) {
  if (!settings.provider || !env.AI_API_KEY) return false;
  try {
    aiConfig(settings, env.AI_API_KEY);
    return true;
  } catch {
    return false;
  }
}
export async function complete(
  settings: DailySettings,
  env: Env,
  prompt: string,
  signal?: AbortSignal,
) {
  const config = aiConfig(settings, env.AI_API_KEY ?? "");
  const transport: typeof fetch = async (input, init) => {
    const response = await fetch(input, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400)
      throw new Error("AI redirects are not allowed");
    return response;
  };
  // next-ai's published factory lacks transport injection and sends x-api-key with Bearer.
  // Reuse its resolver/registry; use the SDK factories for strict redirects and single-header auth.
  const model =
    config.sdkType === "openai"
      ? createOpenAI({
          baseURL: config.baseURL,
          apiKey: config.apiKey,
          fetch: transport,
        }).chat(config.model)
      : createAnthropic({
          baseURL: config.baseURL,
          fetch: transport,
          ...(config.authType === "bearer"
            ? { authToken: config.apiKey }
            : { apiKey: config.apiKey }),
        })(config.model);
  const result = await generateText({
    model,
    prompt,
    maxOutputTokens: 6000,
    maxRetries: 0,
    abortSignal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(90000)])
      : AbortSignal.timeout(90000),
  });
  if (result.finishReason === "length")
    throw Object.assign(new Error("AI output exceeded token budget"), {
      name: "AIOutputTruncatedError",
    });
  if (!result.text.trim()) throw new Error("Empty AI response");
  if (containsCredential(result.text, env))
    throw new Error("Unsafe AI response");
  return result.text;
}
export async function testAi(settings: DailySettings, env: Env) {
  if (!aiReady(settings, env))
    return { success: false, error: "尚未配置完整 AI 连接与服务端密钥。" };
  try {
    await complete(
      settings,
      env,
      "连接测试。请只用中文回复：连接成功。",
      AbortSignal.timeout(20000),
    );
    return {
      success: true,
      model: settings.model,
      provider: settings.provider,
    };
  } catch {
    return {
      success: false,
      error: "连接失败，请检查模型、地址和服务端密钥。",
    };
  }
}

export async function completeReport(
  settings: DailySettings,
  env: Env,
  prompt: string,
  ids: Set<string>[],
  signal: AbortSignal,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    signal.throwIfAborted();
    try {
      const text = await complete(
        settings,
        env,
        prompt +
          (attempt
            ? "\n上次调用或校验失败。严格遵守格式、字数和引用规则，每项使用更短句子。"
            : ""),
        signal,
      );
      try {
        return parseDailyReport(text, ids);
      } catch {
        throw Object.assign(new Error("Invalid daily report"), {
          name: "DailyOutputError",
        });
      }
    } catch (error) {
      if (
        attempt === 1 ||
        signal.aborted ||
        (APICallError.isInstance(error) &&
          [401, 403].includes(error.statusCode ?? 0))
      )
        throw error;
    }
  }
  throw new Error("No daily report");
}

export async function generateDay(
  env: Env,
  machineId: string,
  date: string,
  settings: DailySettings,
  manual: boolean,
  budgetMs = 4 * 60000,
) {
  const signal = AbortSignal.timeout(budgetMs);
  const object = env.MACHINES.getByName(machineId);
  const claim = await object.claimDay(date, manual);
  if ("skipped" in claim) return { machineId, date, ...claim };
  let stage = "input";
  try {
    let result = claim.pending;
    if (!result) {
      const hours = [];
      for (let hour = 0; hour < 24; hour++) {
        signal.throwIfAborted();
        hours.push(await object.dayHourInput(date, hour, claim.lease));
      }
      const [factCount, , semanticCount] = claim.version.split(":").map(Number);
      if (
        hours.reduce((n, h) => n + h.coverage.snapshots, 0) !== factCount ||
        hours.reduce((n, h) => n + h.coverage.semanticRecords, 0) !==
          semanticCount
      )
        throw Object.assign(
          new Error("Daily input expired during preparation"),
          { name: "DailyInputExpiredError" },
        );
      const inputHash = await digest({ date, version: claim.version, hours });
      stage = "model";
      if (!(await object.dailyStage(date, claim.lease, stage)))
        return { machineId, date, skipped: "lease_lost" };
      const content = await completeReport(
        settings,
        env,
        dailyPrompt(machineId, date, hours),
        hours.map((h) => new Set(h.records.map((r) => r.id))),
        signal,
      );
      stage = "validation";
      result = {
        machineId,
        machineName: (await object.current())?.name || machineId,
        date,
        timezone: REPORT_TIMEZONE,
        cutoff: dailyCutoff(date),
        dataReceivedBy: claim.dataReceivedBy,
        generatedAt: new Date().toISOString(),
        templateVersion: TEMPLATE_VERSION,
        provider: settings.provider,
        model: aiConfig(settings, env.AI_API_KEY ?? "").model,
        inputHash,
        snapshots: hours.reduce((n, h) => n + h.coverage.snapshots, 0),
        semanticRecords: hours.reduce(
          (n, h) => n + h.coverage.semanticRecords,
          0,
        ),
        coverage: hours.map((h) => h.coverage),
        content,
      } satisfies DailyReport;
      const skipped = await object.cacheDay(date, claim.lease, result);
      if (skipped) {
        await object.finishDay(date, claim.lease, skipped);
        return { machineId, date, skipped };
      }
    }
    stage = "archive";
    await env.DB.prepare(`INSERT INTO machine_daily_reports(machine_id,date,generated_at,input_hash,payload) VALUES(?,?,?,?,?)
      ON CONFLICT(machine_id,date) DO UPDATE SET generated_at=excluded.generated_at,input_hash=excluded.input_hash,payload=excluded.payload
      WHERE excluded.generated_at>=machine_daily_reports.generated_at`)
      .bind(
        machineId,
        date,
        result.generatedAt,
        result.inputHash,
        JSON.stringify(result),
      )
      .run();
    if (!(await object.finishDay(date, claim.lease)))
      return { machineId, date, skipped: "lease_lost" };
    return { machineId, date, generated: true };
  } catch (error) {
    const name = error instanceof Error ? error.name : "unknown";
    const category =
      stage === "archive"
        ? "archive_unavailable"
        : signal.aborted || name === "TimeoutError" || name === "AbortError"
          ? "timeout"
          : name === "DailyInputExpiredError"
            ? "input_expired"
            : name === "DailyOutputError" || name === "AIOutputTruncatedError"
              ? "invalid_output"
              : "generation_failed";
    await object.finishDay(date, claim.lease, category);
    console.error(
      JSON.stringify({
        event: "daily_report_failed",
        machineId,
        date,
        stage,
        category,
      }),
    );
    return { machineId, date, error: "generation_failed", stage, category };
  }
}

export async function runDaily(
  env: Env,
  machineIds: string[],
  at = Date.now(),
  selection?: { machine?: string; date?: string },
) {
  const settings = await env.DIRECTORY.getByName("fleet").settings();
  env = await withAiKey(env, settings);
  if (!aiReady(settings, env))
    return { skipped: "ai_not_configured", results: [] };
  if (!settings.enabled) return { skipped: "disabled", results: [] };
  const date = selection?.date ?? dueDate(at);
  const queues = await Promise.all(
    machineIds
      .filter((id) => !selection?.machine || selection.machine === id)
      .map(async (machineId) => ({
        machineId,
        dates: [
          ...new Set([
            date,
            ...(selection?.date
              ? []
              : await env.MACHINES.getByName(machineId).pendingDailyArchives()),
          ]),
        ],
      })),
  );
  const jobs = queues.flatMap(({ machineId, dates }) =>
    dates.map((date) => ({ machineId, date })),
  );
  const results: Awaited<ReturnType<typeof generateDay>>[] = [];
  const deadline = Date.now() + 12 * 60000;
  await Promise.all(
    Array.from({ length: 2 }, async () => {
      while (jobs.length) {
        const remaining = deadline - Date.now() - 5000;
        if (remaining < 10000) break;
        const job = jobs.shift();
        if (!job) break;
        try {
          results.push(
            await generateDay(
              env,
              job.machineId,
              job.date,
              settings,
              !!selection,
              Math.min(remaining, 4 * 60000),
            ),
          );
        } catch {
          results.push({
            ...job,
            error: "generation_failed",
            stage: "storage",
            category: "storage_unavailable",
          });
        }
      }
    }),
  );
  return { deferred: jobs.length > 0, results };
}
