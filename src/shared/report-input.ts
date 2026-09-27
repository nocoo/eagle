import type { Report } from "./schema.ts";
import { canonical } from "./summaries.ts";

export const utcHour = (at: string | number) =>
  new Date(
    Math.floor(new Date(at).getTime() / 3600000) * 3600000,
  ).toISOString();
export type InputRecord = {
  id: string;
  kind: string;
  observations: string[];
  value: string;
};

export function projectHour(records: InputRecord[]) {
  const groups = new Map<string, InputRecord[]>();
  const terminalIds = new Set<string>();
  for (const record of records) {
    if (record.kind !== "evidence") continue;
    const value = JSON.parse(record.value);
    if (!value.source?.startsWith("herdr:visible")) continue;
    const key = JSON.stringify([
      value.spaceId,
      value.tabId,
      value.paneId,
      value.taskId,
      value.source,
      value.status,
    ]);
    const group = groups.get(key) ?? [];
    group.push(record);
    groups.set(key, group);
    terminalIds.add(record.id);
  }
  const retained = new Set<string>();
  for (const group of groups.values()) {
    const first = group.toSorted((a, b) =>
      (a.observations[0] ?? "").localeCompare(b.observations[0] ?? ""),
    )[0];
    const last = group.toSorted((a, b) =>
      (b.observations.at(-1) ?? "").localeCompare(a.observations.at(-1) ?? ""),
    )[0];
    retained.add(first.id);
    retained.add(last.id);
  }
  return {
    records: records.filter(
      (record) => !terminalIds.has(record.id) || retained.has(record.id),
    ),
    terminalSampling: {
      method: "first_and_latest_per_task",
      sourceRecords: terminalIds.size,
      retainedRecords: retained.size,
    },
  };
}

/** Coalesce identical observations, preserving every timestamp and all closed tasks. */
export function compactHour(
  reports: Iterable<Report>,
  semantics: { value: unknown; [key: string]: unknown }[],
) {
  const records: InputRecord[] = [];
  let snapshots = 0;
  const times: string[] = [];
  const seen = new Map<string, InputRecord>();
  const add = (kind: string, at: string, value: unknown) => {
    const key = `${kind}:${canonical(value)}`;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.observations.includes(at)) existing.observations.push(at);
    } else {
      const record = {
        id: `F${records.length + 1}`,
        kind,
        observations: [at],
        value: canonical(value),
      };
      records.push(record);
      seen.set(key, record);
    }
  };
  for (const report of reports) {
    snapshots++;
    times.push(report.capturedAt);
    const { telemetry, ...machine } = report.machine;
    add("inventory", report.capturedAt, {
      machine,
      warnings: report.warnings,
      spaces: report.spaces.map(({ tabs, ...space }) => ({
        ...space,
        tabs: tabs.map(({ panes, ...tab }) => ({
          ...tab,
          panes: panes.map((p) => p.id),
        })),
      })),
    });
    if (telemetry) add("resources", telemetry.observedAt, telemetry);
    for (const space of report.spaces)
      for (const tab of space.tabs)
        for (const { evidence, ...pane } of tab.panes) {
          const identity = {
            spaceId: space.id,
            spaceName: space.name,
            tabId: tab.id,
            paneId: pane.id,
          };
          add("pane", report.capturedAt, { ...identity, ...pane });
          for (const { observedAt, ...fact } of evidence)
            add("evidence", observedAt, { ...identity, ...fact });
        }
  }
  for (const value of semantics) {
    const observedAt =
      value.value &&
      typeof value.value === "object" &&
      "observedAt" in value.value
        ? String(value.value.observedAt)
        : "";
    if (observedAt) times.push(observedAt);
    records.push({
      id: `S${records.length + 1}`,
      kind: "semantic",
      observations: observedAt ? [observedAt] : [],
      value: canonical(value),
    });
  }
  times.sort();
  return {
    records,
    snapshots,
    semanticRecords: semantics.length,
    firstObservedAt: times[0] ?? null,
    lastObservedAt: times.at(-1) ?? null,
  };
}
