import { Badge, Button, LayerCard } from "@nocoo/basalt";
import {
  ANIMATION_PROPS,
  AXIS_CONFIG,
  GRID_PROPS,
  getChartColor,
} from "@nocoo/basalt/charts/config";
import { ChartShell } from "@nocoo/basalt/charts/frame";
import { ChartLegend } from "@nocoo/basalt/charts/legend";
import { ChartTooltipContent } from "@nocoo/basalt/charts/tooltip";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import {
  CartesianGrid,
  Dot,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { resourcePoints } from "../shared/resources.ts";
import type { MachineView } from "../shared/schema.ts";
import { age } from "./api.ts";
import { CardHelp } from "./CardHelp.tsx";
import { useTimezone } from "./Timezone.tsx";
import { useResourceHistory } from "./useResourceHistory.ts";

const labels = { connected: "已连接", disconnected: "未连接", unknown: "未知" };
const sources = {
  "macos-reachability": "macOS 网络路径",
  "macos-vpn": "macOS VPN 服务",
  "network-manager": "NetworkManager",
  unsupported: "系统未提供证据",
};
const series = [
  { key: "cpu", label: "CPU %", color: getChartColor(0) },
  { key: "memory", label: "内存 %", color: getChartColor(1) },
  { key: "load1", label: "Load 1m", color: getChartColor(2) },
  { key: "load5", label: "Load 5m", color: getChartColor(3) },
  { key: "load15", label: "Load 15m", color: getChartColor(4) },
];
export function EnvironmentResources({
  machine,
  now,
  children,
}: {
  machine: MachineView;
  now: string;
  children: ReactNode;
}) {
  const { time, zone } = useTimezone();
  const telemetry = machine.report.machine.telemetry;
  const history = useResourceHistory(machine.id, telemetry?.observedAt);
  const samples =
    history.data?.samples.filter(
      (sample) => Date.parse(sample.observedAt) >= Date.parse(now) - 86400000,
    ) ?? [];
  const points = resourcePoints(samples, now);
  const offline = age(machine.lastSeen, now) > 90;
  const staleMachine = offline || age(machine.report.capturedAt, now) > 300;
  const temperature = telemetry?.temperature;
  const slowSeconds = telemetry?.slowIntervalSeconds;
  const last = samples.at(-1);
  return (
    <section className="environment-resources" aria-label="环境资源">
      <SectionRule
        className="board-rule"
        title={
          <>
            <span className="section-index">02</span> 环境资源
          </>
        }
        hint={offline ? "机器离线 · 保留历史" : "按实际采样时间"}
      />
      {children}
      <LayerCard className="environment-status">
        <div className="resource-chart-heading mb-2">
          <strong>环境状态</strong>
          <CardHelp label="环境状态说明">
            网络表示系统路径，不验证公网；VPN
            仅据系统管理状态，未识别的隧道保持未知。
          </CardHelp>
        </div>
        <dl className="environment-status-grid">
          {(["network", "vpn"] as const).map((key) => {
            const reading = telemetry?.[key];
            const stale =
              offline || (!!reading && age(reading.observedAt, now) > 90);
            const name = key === "vpn" ? "VPN" : "网络";
            return (
              <div key={key}>
                <dt>
                  {stale ? "上次" : ""}
                  {name}
                </dt>
                <dd>
                  <Badge
                    variant={
                      stale
                        ? "secondary"
                        : reading?.state === "connected"
                          ? "success"
                          : "secondary"
                    }
                  >
                    {name} {labels[reading?.state ?? "unknown"]}
                  </Badge>
                </dd>
                <dd>{reading ? sources[reading.source] : "尚未上报"}</dd>
                <dd>
                  {reading ? (
                    <time dateTime={reading.observedAt}>
                      {time(reading.observedAt)}
                    </time>
                  ) : (
                    "时间未知"
                  )}
                </dd>
              </div>
            );
          })}
          <div>
            <dt>CPU 温度 · °C</dt>
            <dd>
              {temperature?.status === "available"
                ? `${temperature.celsius.toFixed(1)} °C`
                : "不可用"}
            </dd>
            <dd>
              {temperature?.source === "linux-cpu-thermal"
                ? "Linux CPU 传感器"
                : "无稳定的无特权读数"}
            </dd>
            <dd>
              {temperature ? (
                <time dateTime={temperature.observedAt}>
                  {time(temperature.observedAt)}
                </time>
              ) : (
                "时间未知"
              )}
            </dd>
            {(staleMachine ||
              (!!temperature &&
                age(temperature.observedAt, now) >
                  (slowSeconds ?? 300) + 90)) && <dd>历史采样 · 等待更新</dd>}
          </div>
        </dl>
      </LayerCard>
      <LayerCard className="resource-history">
        <div className="resource-chart-heading">
          <strong>资源时间序列</strong>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              aria-label="刷新资源历史"
              disabled={history.loading}
              onClick={history.refresh}
            >
              <RefreshCw size={14} />
            </Button>
            <CardHelp label="资源时间序列说明">
              <p>
                CPU / 内存 · 左轴 0–100%；Load 1/5/15 分钟 ·
                右轴虚线（不是百分比）
              </p>
              <p>
                {telemetry?.sampleIntervalSeconds
                  ? `${telemetry.sampleIntervalSeconds} 秒采样`
                  : "采样周期未知"}
                {" · 保留 24 小时 / 最多 2880 点 · "}
                {zone}
              </p>
              <p>
                缺失与超过两个采样周期的空档断线，不补零。内存为总量减空闲量，可能包含缓存，不代表内存压力。
              </p>
              <p>
                磁盘不入图；磁盘 / 温度
                {slowSeconds ? `每 ${slowSeconds} 秒` : "周期未知"}
                读取，卡片保留原采样时间。
              </p>
            </CardHelp>
          </div>
        </div>
        {history.error && (
          <p role="alert" className="resource-note">
            {history.error}
          </p>
        )}
        {!history.data ? (
          <p className="resource-note">
            {history.loading ? "正在读取资源历史…" : "资源历史不可用"}
          </p>
        ) : !samples.length ? (
          <p className="resource-note">尚无资源历史 · 等待采样</p>
        ) : (
          <ChartShell
            ariaLabel="CPU、内存与负载历史"
            size="h-56 w-full"
            legend={<ChartLegend items={series} />}
            summary={`最后采样 ${last ? time(last.observedAt) : "未知"} · ${zone}`}
          >
            <LineChart
              data={points}
              margin={{ top: 20, right: 4, bottom: 0, left: 0 }}
            >
              <CartesianGrid {...GRID_PROPS} />
              <XAxis
                {...AXIS_CONFIG}
                dataKey="at"
                type="number"
                domain={["dataMin", "dataMax"]}
                minTickGap={35}
                tickFormatter={(at: number) =>
                  time(new Date(at).toISOString(), {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                }
              />
              <YAxis
                {...AXIS_CONFIG}
                yAxisId="percent"
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                allowDataOverflow
                width={46}
                tickFormatter={(value: number) => `${value}%`}
              />
              <YAxis
                {...AXIS_CONFIG}
                yAxisId="load"
                orientation="right"
                domain={[0, "auto"]}
                width={42}
                label={{
                  value: "Load",
                  position: "top",
                  fill: "hsl(var(--basalt-muted-foreground))",
                  fontSize: 11,
                }}
              />
              <Tooltip
                content={({ active, payload, label }) => (
                  <ChartTooltipContent
                    active={active}
                    label={
                      typeof label === "number"
                        ? time(new Date(label).toISOString())
                        : ""
                    }
                    payload={payload?.map((item) => ({
                      name: String(item.name),
                      value:
                        item.value == null
                          ? "—"
                          : `${Number(item.value).toFixed(1)}${item.dataKey === "cpu" || item.dataKey === "memory" ? "%" : ""}`,
                      color: item.color,
                    }))}
                  />
                )}
              />
              {series.map((item, index) => (
                <Line
                  key={item.key}
                  {...ANIMATION_PROPS}
                  className={
                    index < 2
                      ? `resource-${item.key}`
                      : `resource-load-${[1, 5, 15][index - 2]}`
                  }
                  yAxisId={index < 2 ? "percent" : "load"}
                  type="linear"
                  dataKey={item.key}
                  name={item.label}
                  stroke={item.color}
                  strokeWidth={2}
                  strokeDasharray={index < 2 ? undefined : "6 4"}
                  dot={({ index, points: linePoints, value, cx, cy }) =>
                    value != null &&
                    linePoints[index - 1]?.value == null &&
                    linePoints[index + 1]?.value == null ? (
                      <Dot
                        className={`resource-${item.key}-sample`}
                        cx={cx}
                        cy={cy}
                        r={3}
                        fill={item.color}
                        stroke={item.color}
                      />
                    ) : null
                  }
                  connectNulls={false}
                />
              ))}
            </LineChart>
          </ChartShell>
        )}
      </LayerCard>
    </section>
  );
}
