import { Badge, Button, Label, LayerCard } from "@nocoo/basalt";
import { DatePicker } from "@nocoo/basalt/components/date-picker";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";
import { CalendarDays, ChevronDown, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { DailyJobView, DailyReport } from "../shared/daily.ts";
import { api } from "./api.ts";
import { useTimezone } from "./Timezone.tsx";

function ReportCard({ report }: { report: DailyReport }) {
  const { time } = useTimezone();
  const [expanded, setExpanded] = useState(false);
  return (
    <LayerCard
      role="article"
      aria-label={`${report.machineName} ${report.date} 日报`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
          <Badge variant="purple">AI 日报</Badge>
          <span className="font-medium">{report.machineName}</span>
          <time dateTime={report.date}>{report.date}</time>
        </div>
        <Button
          size="sm"
          variant="outline"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
        >
          <ChevronDown size={14} className={expanded ? "rotate-180" : ""} />
          {expanded ? "收起报告" : "展开报告"}
        </Button>
      </div>
      <p className="mt-2 text-sm leading-relaxed break-words">
        {report.content.overview}
      </p>
      <p className="mt-2 text-xs text-basalt-muted-foreground">
        北京时间 00:00–23:59 · {report.snapshots} 次采集 ·{" "}
        {report.semanticRecords} 条语义记录
      </p>
      {expanded && (
        <div className="mt-3 space-y-3">
          <ol className="divide-y divide-basalt-border" aria-label="逐小时汇报">
            {report.content.hours.map((entry) => {
              const coverage = report.coverage[entry.hour];
              return (
                <li
                  key={entry.hour}
                  className="daily-hour flex items-start gap-3 py-1.5 text-sm"
                >
                  <span className="shrink-0 font-mono text-xs leading-6 text-basalt-muted-foreground">
                    {String(entry.hour).padStart(2, "0")}:00
                  </span>
                  <div className="min-w-0 flex-1 break-words leading-6">
                    {entry.summary}
                    {coverage &&
                      (coverage.omittedRecords > 0 ||
                        coverage.excerptedRecords > 0) && (
                        <span
                          className="ml-2 text-xs text-basalt-muted-foreground"
                          title={`模型采用 ${coverage.retainedRecords}/${coverage.inputRecords} 条材料，${coverage.excerptedRecords} 条摘录`}
                        >
                          抽样
                        </span>
                      )}
                    {entry.evidenceIds.length > 0 && (
                      <span className="ml-2 text-xs text-basalt-muted-foreground">
                        {entry.evidenceIds.join(" · ")}
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
          {report.content.nextSteps.length > 0 && (
            <section>
              <h3 className="text-sm font-medium">下一步</h3>
              <ul className="mt-1 list-inside list-disc text-sm leading-6">
                {report.content.nextSteps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </section>
          )}
          <p className="text-xs text-basalt-muted-foreground">
            数据截止北京时间
            23:59，不含最后一分钟及生成开始后收到的上报。无采集数据不代表没有活动。
            <br />
            {report.model} · 生成于 {time(report.generatedAt)}
          </p>
        </div>
      )}
    </LayerCard>
  );
}

const errors: Record<string, string> = {
  timeout: "模型响应超时",
  invalid_output: "格式或长度校验失败",
  archive_unavailable: "保存失败，重试会复用已生成报告",
  generation_failed: "模型调用失败",
  storage_unavailable: "存储暂不可用",
  interrupted: "生成被中断",
  input_expired: "原始输入已超过 48 小时保留期",
};

export function DailyHistory({ machine }: { machine: string }) {
  const [entries, setEntries] = useState<
    { seq: number; report: DailyReport }[]
  >([]);
  const [jobs, setJobs] = useState<DailyJobView[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [date, setDate] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const active = useRef<AbortController | null>(null);
  const load = useCallback(
    async (before?: string) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setLoading(true);
      setError("");
      const query = new URLSearchParams({ limit: "12" });
      if (machine) query.set("machine", machine);
      if (date) query.set("date", date);
      if (before) query.set("before", before);
      try {
        const result = await api<{
          entries: typeof entries;
          jobs: DailyJobView[];
          nextCursor: string | null;
        }>(`/api/v1/daily-reports?${query}`, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setEntries((old) =>
            before
              ? [...old, ...(result.entries ?? [])]
              : (result.entries ?? []),
          );
          setCursor(result.nextCursor);
          setJobs(result.jobs ?? []);
        }
      } catch {
        if (!controller.signal.aborted)
          setError("日报读取失败，保留已显示的报告。");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [machine, date],
  );
  useEffect(() => {
    setEntries([]);
    setJobs([]);
    void load();
    return () => active.current?.abort();
  }, [load]);
  const run = async (selection: { machine?: string; date?: string }) => {
    setBusy(true);
    setError("");
    try {
      const result = await api<{
        skipped?: string;
        results: { error?: string; skipped?: string }[];
      }>("/api/v1/daily-reports/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(selection),
        signal: AbortSignal.timeout(780000),
      });
      await load();
      if (result.skipped)
        setError(
          result.skipped === "disabled"
            ? "自动报告已暂停，请在设置中启用。"
            : "请先在设置中配置 AI。",
        );
      else if (result.results.some((r) => r.error))
        setError("部分日报生成失败，可查看状态后重试。");
      else if (result.results.some((r) => r.skipped === "input_expired"))
        setError(errors.input_expired);
      else if (result.results.every((r) => r.skipped === "no_data"))
        setError("所选日期无采集数据。");
    } catch {
      setError("生成请求失败，请刷新状态后重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SectionRule title="日报" hint="每台机器每天一份 · 北京时间">
      <div className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <Label htmlFor="report-date">日期（北京时间）</Label>
            <div className="mt-1 flex items-center gap-1">
              <div className="relative w-40">
                <DatePicker
                  id="report-date"
                  aria-label="报告日期"
                  value={date}
                  onChange={setDate}
                  locale="zh-CN"
                  timeZone="Asia/Shanghai"
                  labels={{
                    calendar: "选择报告日期",
                    placeholder: "选择日期",
                    previousMonth: "上个月",
                    nextMonth: "下个月",
                    keyboardInstructions:
                      "方向键移动日期，PageUp / PageDown 切换月份，Enter 选择日期。",
                  }}
                  className="h-9 w-full pl-9 pr-2"
                />
                <CalendarDays
                  size={16}
                  aria-hidden="true"
                  className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-basalt-muted-foreground"
                />
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label="清除时间筛选"
                disabled={!date}
                onClick={() => setDate("")}
              >
                清除
              </Button>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run({
                  ...(machine ? { machine } : {}),
                  ...(date ? { date } : {}),
                })
              }
            >
              {busy ? "生成中" : "生成日报"}
            </Button>
            <Button
              aria-label="刷新日报"
              size="sm"
              variant="outline"
              disabled={loading}
              onClick={() => void load()}
            >
              <RefreshCw size={14} className={loading ? "eagle-spin" : ""} />
            </Button>
          </div>
        </div>
        {jobs.length > 0 && (
          <LayerCard role="region" aria-label="报告生成状态">
            <ul className="max-h-48 divide-y divide-basalt-border overflow-y-auto">
              {jobs.map((job) => (
                <li
                  key={`${job.machineId}:${job.date}`}
                  className="flex flex-wrap items-center gap-2 py-1 text-xs"
                >
                  <span>
                    {job.machineName} · {job.date}
                  </span>
                  <Badge variant={job.status === "failed" ? "warning" : "info"}>
                    {job.status === "complete"
                      ? "已生成"
                      : job.status === "running"
                        ? "生成中"
                        : "需要重试"}
                  </Badge>
                  {job.error && <span>{errors[job.error] ?? "生成失败"}</span>}
                  {job.status === "failed" && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        void run({ machine: job.machineId, date: job.date })
                      }
                    >
                      重试日报
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </LayerCard>
        )}
        {error && (
          <p role="alert" className="text-sm text-basalt-destructive">
            {error}
          </p>
        )}
        {loading && !entries.length && (
          <LayerCard>
            <div role="status" aria-label="正在加载日报" className="space-y-3">
              <SkeletonLine />
              <SkeletonLine />
            </div>
          </LayerCard>
        )}
        {!loading && !entries.length && !error && (
          <LayerCard>
            <p className="text-sm">暂无日报</p>
            <p className="mt-1 text-xs text-basalt-muted-foreground">
              配置 AI 后，每天北京时间 23:59
              自动生成；按小时汇报，无数据时跳过。
            </p>
          </LayerCard>
        )}
        {entries.map(({ seq, report }) => (
          <ReportCard key={seq} report={report} />
        ))}
        {cursor && (
          <Button
            variant="outline"
            disabled={loading}
            onClick={() => void load(cursor)}
          >
            加载更多日报
          </Button>
        )}
      </div>
    </SectionRule>
  );
}
