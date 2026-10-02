import type { MachineTelemetry } from "./schema.ts";

export const RESOURCE_RETENTION_SECONDS = 86400;
export const MAX_RESOURCE_SAMPLES = 2880;
export type ResourceSample = {
  observedAt: string;
  intervalSeconds: number | null;
  cpu: number | null;
  memory: number | null;
  load: [number, number, number] | null;
};
export type ResourceHistory = {
  retentionSeconds: number;
  samples: ResourceSample[];
};
export function resourceSample(telemetry: MachineTelemetry): ResourceSample {
  const resource = telemetry.resources;
  return {
    observedAt: telemetry.observedAt,
    intervalSeconds: telemetry.sampleIntervalSeconds ?? null,
    cpu: resource?.cpuUsagePercent ?? null,
    memory: resource
      ? Math.round(
          (1 - resource.memory.freeBytes / resource.memory.totalBytes) * 1000,
        ) / 10
      : null,
    load: resource?.loadAverage ?? null,
  };
}
export function resourcePoints(samples: ResourceSample[], now: string) {
  const points: {
    at: number;
    cpu: number | null;
    memory: number | null;
    load1: number | null;
    load5: number | null;
    load15: number | null;
  }[] = [];
  const gap = (at: number) => ({
    at,
    cpu: null,
    memory: null,
    load1: null,
    load5: null,
    load15: null,
  });
  for (const [index, sample] of samples.entries()) {
    const at = Date.parse(sample.observedAt);
    const previous = samples[index - 1];
    if (
      previous &&
      at - Date.parse(previous.observedAt) >
        (previous.intervalSeconds ?? 30) * 2000
    )
      points.push(
        gap(
          Date.parse(previous.observedAt) +
            (previous.intervalSeconds ?? 30) * 1000,
        ),
      );
    points.push({
      at,
      cpu: sample.cpu,
      memory: sample.memory,
      load1: sample.load?.[0] ?? null,
      load5: sample.load?.[1] ?? null,
      load15: sample.load?.[2] ?? null,
    });
  }
  const last = samples.at(-1);
  if (
    last &&
    Date.parse(now) - Date.parse(last.observedAt) >
      (last.intervalSeconds ?? 30) * 2000
  )
    points.push(gap(Date.parse(now)));
  return points;
}
