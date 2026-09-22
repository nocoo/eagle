import { Badge, Button, LayerCard } from "@nocoo/basalt";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";
import { useEffect, useState } from "react";
import type { MachineView, Pane, Space } from "../shared/schema.ts";
import {
  PHASE_LABEL,
  type SemanticHour,
  type SemanticRecord,
  summaryFreshness,
} from "../shared/summaries.ts";
import { api } from "./api.ts";
import { useTimezone } from "./Timezone.tsx";

const FRESH_LABEL = {
  current: "语义在线",
  stale: "待重新核对",
  disconnected: "Manager 断连",
  superseded: "上一任务总结",
};
export function PaneSummaryView({
  machine,
  space,
  pane,
  at,
}: {
  machine: MachineView;
  space: Space;
  pane: Pane;
  at?: string;
}) {
  const { time } = useTimezone();
  const latest = machine.summaries?.find(
    (s) => s.spaceId === space.id && s.paneId === pane.id,
  );
  const query = new URLSearchParams({
    machine: machine.id,
    space: space.id,
    pane: pane.id,
    limit: "12",
  }).toString();
  const freshness = latest
    ? summaryFreshness(
        latest,
        pane,
        machine.manager?.lastSeen,
        at ?? new Date().toISOString(),
        machine.report.capturedAt,
        space.availability,
      )
    : null;
  return (
    <section aria-label="Pane 实时总结" className="space-y-5">
      <SectionRule title="实时语义总结" hint="Manager 持续解读 · 事实证据优先">
        <LayerCard className="space-y-4">
          {latest && freshness ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={freshness === "current" ? "teal" : "orange"}>
                  {FRESH_LABEL[freshness]}
                </Badge>
                <Badge variant="purple">
                  {PHASE_LABEL[latest.summary.phase]}
                </Badge>
              </div>
              <h3 className="text-base font-semibold leading-relaxed">
                {latest.summary.task}
              </h3>
              <p className="text-sm leading-relaxed">
                {latest.summary.progress}
              </p>
              {latest.summary.outcomes.length > 0 && (
                <ul className="space-y-2">
                  {latest.summary.outcomes.map((outcome, index) => (
                    <li
                      key={`${outcome.kind}-${index}`}
                      className="rounded-lg border border-basalt-border p-3 text-sm"
                    >
                      <Badge variant="outline">
                        {outcome.kind === "result" ? "成果描述" : "未独立验证"}{" "}
                        · {outcome.kind}
                      </Badge>
                      <p className="mt-2 leading-relaxed">{outcome.text}</p>
                    </li>
                  ))}
                </ul>
              )}
              {latest.summary.blocker && (
                <div className="rounded-lg border border-basalt-border p-3">
                  <Badge variant="orange">真实阻塞 · Manager 判断</Badge>
                  <p className="mt-2 text-sm">{latest.summary.blocker}</p>
                </div>
              )}
              <div className="border-t border-basalt-border pt-3">
                <p className="text-xs text-basalt-muted-foreground">下一步</p>
                <p className="mt-1 text-sm">{latest.summary.nextStep}</p>
              </div>
              <p className="text-xs leading-relaxed text-basalt-muted-foreground">
                判断依据：{latest.summary.rationale}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-basalt-muted-foreground">
                <span>语义更新 {time(latest.updatedAt)}</span>
                <span>最近核对 {time(latest.checkedAt)}</span>
              </div>
              <p className="break-all text-xs text-basalt-muted-foreground">
                任务 {latest.taskId} · 序列 {latest.sequence} ·{" "}
                {latest.basis.length} 项事实依据
              </p>
            </>
          ) : (
            <>
              <Badge variant="outline">等待 Manager</Badge>
              <p className="text-sm text-basalt-muted-foreground">
                daemon 已提供事实快照；这一个 Pane 尚未收到语义总结。
              </p>
            </>
          )}
        </LayerCard>
      </SectionRule>
      <HourTimeline query={query} />
    </section>
  );
}

function RecordDetail({ entry }: { entry: SemanticRecord }) {
  const { time, zone } = useTimezone();
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <Badge variant="outline">
          {PHASE_LABEL[entry.value.summary.phase]}
        </Badge>
        <time dateTime={entry.value.observedAt}>
          {`${time(entry.value.observedAt)} ${zone}`}
        </time>
      </div>
      <p className="font-medium">{entry.value.summary.task}</p>
      <p className="text-basalt-muted-foreground">
        {entry.value.summary.progress}
      </p>
      <p className="text-xs text-basalt-muted-foreground">
        下一步：{entry.value.summary.nextStep}
      </p>
      <p className="break-all text-xs text-basalt-muted-foreground">
        {entry.source?.managerId} · seq {entry.value.sequence} ·{" "}
        {entry.contentHash?.slice(0, 12)} · {entry.value.taskId}
      </p>
    </div>
  );
}
function HourRecords({
  query,
  hour,
  count,
  initial,
}: {
  query: string;
  hour: string;
  count: number;
  initial: SemanticRecord;
}) {
  const [entries, setEntries] = useState<SemanticRecord[]>([initial]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<{ entries: SemanticRecord[]; nextCursor: number | null }>(
      `/api/v1/semantic-hours?${query}&hour=${encodeURIComponent(hour)}&mode=all`,
      { signal: controller.signal },
    )
      .then((result) => {
        setEntries((previous) =>
          [
            ...new Map(
              [...previous, ...result.entries].map((e) => [e.seq, e]),
            ).values(),
          ].sort((a, b) => b.seq - a.seq),
        );
        setCursor(result.nextCursor);
        setError("");
      })
      .catch(() => {
        if (!controller.signal.aborted) setError("读取失败，稍后重试");
      });
    return () => controller.abort();
  }, [query, hour, count]);
  async function older() {
    if (!cursor || busy) return;
    setBusy(true);
    try {
      const result = await api<{
        entries: SemanticRecord[];
        nextCursor: number | null;
      }>(
        `/api/v1/semantic-hours?${query}&hour=${encodeURIComponent(hour)}&before=${cursor}`,
      );
      setEntries((previous) => [
        ...new Map(
          [...previous, ...result.entries].map((e) => [e.seq, e]),
        ).values(),
      ]);
      setCursor(result.nextCursor);
    } catch {
      setError("读取失败，稍后重试");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="mt-4 space-y-4 border-t border-basalt-border pt-4">
      {!entries.length && !error && <SkeletonLine className="h-12 w-full" />}
      {entries.map((entry) => (
        <RecordDetail key={entry.seq} entry={entry} />
      ))}
      {error && <p role="status">{error}</p>}
      {cursor && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void older()}
        >
          更多本小时记录
        </Button>
      )}
    </div>
  );
}
function HourTimeline({ query }: { query: string }) {
  const { time, zone } = useTimezone();
  const [hours, setHours] = useState<SemanticHour[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let active = false;
    async function refresh() {
      if (active) return;
      active = true;
      try {
        const result = await api<{
          hours: SemanticHour[];
          nextCursor: string | null;
        }>(`/api/v1/semantic-hours?${query}`, { signal: controller.signal });
        setHours((previous) =>
          [
            ...new Map(
              [...previous, ...(result.hours ?? [])].map((h) => [h.hour, h]),
            ).values(),
          ].sort((a, b) => b.hour.localeCompare(a.hour)),
        );
        setCursor((previous) => previous ?? result.nextCursor);
        setError("");
      } catch {
        if (!controller.signal.aborted)
          setError("小时记录暂时不可用，保留已加载内容");
      } finally {
        active = false;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void refresh();
    return () => {
      controller.abort();
    };
  }, [query]);
  async function older() {
    if (!cursor || more) return;
    setMore(true);
    try {
      const result = await api<{
        hours: SemanticHour[];
        nextCursor: string | null;
      }>(
        `/api/v1/semantic-hours?${query}&before=${encodeURIComponent(cursor)}`,
      );
      setHours((previous) => [
        ...new Map(
          [...previous, ...result.hours].map((h) => [h.hour, h]),
        ).values(),
      ]);
      setCursor(result.nextCursor);
      setError("");
    } catch {
      setError("小时记录暂时不可用，保留已加载内容");
    } finally {
      setMore(false);
    }
  }
  return (
    <SectionRule
      title={`小时时间线 · ${zone}`}
      hint="DO 独立语义流 · 每小时可有多条 · 心跳不记历史"
    >
      {loading && !hours.length && (
        <div role="status" aria-label="正在读取摘要历史">
          <SkeletonLine className="h-16 w-full" />
        </div>
      )}
      <ol className="space-y-3">
        {hours.map((bucket) => (
          <li key={bucket.hour}>
            <LayerCard>
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <time className="text-xs font-medium" dateTime={bucket.hour}>
                  {time(bucket.hour, {
                    year: "numeric",
                    month: "2-digit",
                    day: "2-digit",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}{" "}
                  {zone}
                </time>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={!!expanded[bucket.hour]}
                  onClick={() =>
                    setExpanded((previous) => ({
                      ...previous,
                      [bucket.hour]: !previous[bucket.hour],
                    }))
                  }
                >
                  {expanded[bucket.hour] ? "收起" : "展开"} · {bucket.count} 条
                </Button>
              </div>
              {!expanded[bucket.hour] && <RecordDetail entry={bucket.latest} />}
              {expanded[bucket.hour] && (
                <HourRecords
                  query={query}
                  hour={bucket.hour}
                  count={bucket.count}
                  initial={bucket.latest}
                />
              )}
            </LayerCard>
          </li>
        ))}
      </ol>
      {!loading && !hours.length && !error && (
        <p className="text-sm text-basalt-muted-foreground">
          尚无摘要变化记录。
        </p>
      )}
      {error && (
        <p role="status" className="text-sm text-basalt-muted-foreground">
          {error}
        </p>
      )}
      {cursor && (
        <Button
          variant="ghost"
          size="sm"
          disabled={more}
          onClick={() => void older()}
        >
          {more ? "读取中…" : "更早的小时"}
        </Button>
      )}
      <p className="mt-3 text-xs text-basalt-muted-foreground">
        DO 保留最近 30 天、最多 10,000 条；已归档记录仍可在 D1 历史查询。
      </p>
    </SectionRule>
  );
}
