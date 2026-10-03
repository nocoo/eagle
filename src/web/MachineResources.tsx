import { Badge, LayerCard, Meter } from "@nocoo/basalt";
import { Cpu, Fan, Globe, HardDrive, MemoryStick, Monitor } from "lucide-react";
import type { ReactNode } from "react";
import type { MachineView } from "../shared/schema.ts";
import { age } from "./api.ts";
import { CardHelp } from "./CardHelp.tsx";
import { useTimezone } from "./Timezone.tsx";

const number = (value: number) =>
  new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
const gib = (value: number) => number(value / 1024 ** 3);
const rate = (value: number) =>
  value >= 1024 ** 2
    ? `${number(value / 1024 ** 2)} MiB/s`
    : value >= 1024
      ? `${number(value / 1024)} KiB/s`
      : `${number(value)} B/s`;
const states = { connected: "已连接", disconnected: "未连接", unknown: "未知" };

function ResourceCard({
  metric,
  icon,
  label,
  detail,
  value,
  meter,
  meterLabel,
  children,
  help,
  helpLabel,
  stale = false,
  className = "",
}: {
  metric: string;
  icon: ReactNode;
  label: string;
  detail?: ReactNode;
  value: ReactNode;
  meter?: number | null;
  meterLabel?: string;
  children: ReactNode;
  help: ReactNode;
  helpLabel?: string;
  stale?: boolean;
  className?: string;
}) {
  return (
    <LayerCard
      className={`resource-metric-card ${className}`}
      data-metric={metric}
    >
      <div className="resource-metric-heading">
        <span>
          {icon}
          {label}
        </span>
        <CardHelp label={helpLabel ?? `${label}说明`}>{help}</CardHelp>
      </div>
      <div className="resource-metric-value">{value}</div>
      <div className="resource-metric-detail">{detail}</div>
      {meter !== null && meter !== undefined && (
        <Meter
          value={meter}
          hideValue
          aria-label={meterLabel ?? `${label}占用`}
        />
      )}
      <div className="resource-metric-footer">{children}</div>
      {stale && (
        <Badge variant="secondary" className="self-start">
          历史采样 · 等待更新
        </Badge>
      )}
    </LayerCard>
  );
}

export function MachineResources({
  machine,
  now,
  snapshot = false,
}: {
  machine: MachineView;
  now: string;
  snapshot?: boolean;
}) {
  const { time } = useTimezone();
  const telemetry = machine.report.machine.telemetry;
  const resources = telemetry?.resources;
  const hardware = telemetry?.hardware;
  const traffic = telemetry?.traffic;
  const temperature = telemetry?.temperature;
  const stale =
    age(machine.lastSeen, now) > 90 ||
    age(machine.report.capturedAt, now) > 300 ||
    (!!telemetry && age(telemetry.observedAt, now) > 90);
  const hardwareStale =
    stale || (!!hardware && age(hardware.observedAt, now) > 90);
  const networkStale =
    stale ||
    (!!telemetry?.network && age(telemetry.network.observedAt, now) > 90);
  const vpnStale =
    stale || (!!telemetry?.vpn && age(telemetry.vpn.observedAt, now) > 90);
  const memory =
    hardware?.memory ??
    (resources
      ? {
          totalBytes: resources.memory.totalBytes,
          usedBytes: resources.memory.totalBytes - resources.memory.freeBytes,
        }
      : null);
  const memoryUsage = memory
    ? Math.round((memory.usedBytes / memory.totalBytes) * 100)
    : null;
  const diskUsage = resources?.disk
    ? Math.round(
        (1 - resources.disk.availableBytes / resources.disk.totalBytes) * 100,
      )
    : null;
  const fans = hardware?.fans;
  const fastest = fans?.length ? Math.max(...fans.map((fan) => fan.rpm)) : null;
  const fanPercent =
    fans?.length && fans.every((fan) => fan.maxRpm !== null)
      ? Math.round(
          Math.max(...fans.map((fan) => (fan.rpm / (fan.maxRpm ?? 1)) * 100)),
        )
      : null;
  const stamp = (at: string | undefined) =>
    at ? <time dateTime={at}>{time(at)}</time> : "时间未知";
  if (!telemetry)
    return (
      <section aria-label="机器资源" className="machine-resources">
        <p className="text-xs text-basalt-muted-foreground">尚未上报机器资源</p>
      </section>
    );
  return (
    <section
      aria-label="机器资源"
      className={`machine-resources resource-panel ${snapshot ? "resource-panel-snapshot" : ""}`}
    >
      <div className="resource-machine-meta">
        {resources && (
          <>
            <Badge variant="secondary">
              {resources.cpuModel || "CPU 未知"}
            </Badge>
            <Badge variant="secondary">
              {gib(resources.memory.totalBytes)} GiB
            </Badge>
          </>
        )}
        <Badge variant="secondary">
          {machine.report.machine.platform === "darwin"
            ? "macOS"
            : machine.report.machine.platform}
        </Badge>
        {resources && (
          <span>
            运行时间 {Math.floor(resources.uptimeSeconds / 86400)} 天{" "}
            {Math.floor(resources.uptimeSeconds / 3600) % 24} 小时
          </span>
        )}
        {stale ? (
          <Badge variant="secondary">历史快照 · 等待更新</Badge>
        ) : (
          !snapshot && <span>实时采样</span>
        )}
      </div>
      <div className="resource-metric-grid">
        <ResourceCard
          metric="cpu"
          icon={<Cpu size={14} />}
          label="CPU"
          value={
            <>
              {resources?.cpuUsagePercent ?? "未知"}
              {resources?.cpuUsagePercent != null && <small>%</small>}
            </>
          }
          detail={
            <Badge variant="secondary">
              {temperature?.status === "available"
                ? `${number(temperature.celsius)}°C`
                : "温度不可用"}
            </Badge>
          }
          meter={resources?.cpuUsagePercent}
          meterLabel="CPU 占用"
          stale={
            stale ||
            (!!temperature &&
              age(temperature.observedAt, now) >
                (temperature.source === "macmon"
                  ? 90
                  : (telemetry.slowIntervalSeconds ?? 300) + 90))
          }
          help={
            <>
              <p>
                CPU 使用率来自独立短采样；负载为 1/5/15 分钟平均值，不是百分比。
              </p>
              <p>
                温度来源：{temperature?.source ?? "尚未上报"} ·{" "}
                {stamp(temperature?.observedAt)}。macmon
                为传感器平均读数；读取失败不显示零度。
              </p>
            </>
          }
        >
          <span>
            负载{" "}
            {resources?.loadAverage
              ?.map((value) => value.toFixed(1))
              .join(" / ") ?? "未知"}
          </span>
          <span>{resources?.cpuCores ?? "未知"} 核</span>
        </ResourceCard>
        <ResourceCard
          metric="gpu"
          icon={<Monitor size={14} />}
          label="GPU"
          value={
            <>
              {hardware?.gpuUsagePercent ?? "未知"}
              {hardware?.gpuUsagePercent != null && <small>%</small>}
            </>
          }
          detail={
            <Badge variant="secondary">
              {hardware?.gpuTemperatureCelsius != null
                ? `${number(hardware.gpuTemperatureCelsius)}°C`
                : "温度不可用"}
            </Badge>
          }
          meter={hardware?.gpuUsagePercent}
          meterLabel="GPU 占用"
          stale={hardwareStale}
          help={
            <>
              <p>GPU 活跃时间比例与平均温度来自 macmon，不是算力评分。</p>
              <p>
                {stamp(hardware?.observedAt)}；需 Apple Silicon 与服务 PATH 中的
                macmon，无需提权。
              </p>
            </>
          }
        >
          <span>{hardware ? "GPU 活跃比例" : "尚未上报 · 需 macmon"}</span>
        </ResourceCard>
        <ResourceCard
          metric="memory"
          icon={<MemoryStick size={14} />}
          label="内存"
          value={
            <>
              {memoryUsage ?? "未知"}
              {memoryUsage !== null && <small>%</small>}
            </>
          }
          detail={
            hardware?.swapUsedBytes != null
              ? `Swap ${gib(hardware.swapUsedBytes)} GiB`
              : "Swap 未知"
          }
          meter={memoryUsage}
          meterLabel="内存占用"
          stale={hardware?.memory ? hardwareStale : stale}
          help={
            <>
              <p>
                {hardware?.memory
                  ? "已用内存来自 macmon，与系统 total-free 口径不同。"
                  : "已用量为总内存减去系统空闲内存，缓存可能计入。"}
                占用率与 Swap 都不等同于内存压力。
              </p>
              <p>
                {stamp(
                  hardware?.memory ? hardware.observedAt : telemetry.observedAt,
                )}
              </p>
            </>
          }
        >
          <span>
            {memory
              ? `${gib(memory.usedBytes)} / ${gib(memory.totalBytes)} GiB`
              : "未知"}
          </span>
          <span>占用 {memoryUsage ?? "未知"}%</span>
        </ResourceCard>
        <ResourceCard
          metric="disk"
          icon={<HardDrive size={14} />}
          label="磁盘"
          value={
            <>
              {resources?.disk ? gib(resources.disk.availableBytes) : "未知"}
              {resources?.disk && <small> GiB</small>}
            </>
          }
          detail={
            resources?.disk
              ? `可用 · 总计 ${gib(resources.disk.totalBytes)} GiB`
              : "磁盘信息不可读"
          }
          meter={diskUsage}
          meterLabel="磁盘占用"
          stale={
            stale ||
            age(telemetry.diskObservedAt ?? telemetry.observedAt, now) >
              (telemetry.slowIntervalSeconds ?? 30) + 90
          }
          help={
            <>
              <p>
                采集器用户主目录所在文件系统，非全部磁盘。占用条为总量减可用量。
              </p>
              <p>
                {telemetry.slowIntervalSeconds ?? 30} 秒采样 ·{" "}
                {stamp(telemetry.diskObservedAt ?? telemetry.observedAt)}
              </p>
            </>
          }
        >
          <span>
            {resources?.disk
              ? `已用 ${gib(resources.disk.totalBytes - resources.disk.availableBytes)} GiB · ${diskUsage}%`
              : "未知"}
          </span>
        </ResourceCard>
        <ResourceCard
          metric="network"
          className="environment-status"
          icon={<Globe size={14} />}
          label="网络"
          value={
            traffic
              ? rate(
                  traffic.downloadBytesPerSecond + traffic.uploadBytesPerSecond,
                )
              : "未知"
          }
          detail={
            traffic ? (
              <>
                <span>↓ {rate(traffic.downloadBytesPerSecond)}</span>
                <span>↑ {rate(traffic.uploadBytesPerSecond)}</span>
              </>
            ) : (
              "流量尚未上报"
            )
          }
          stale={
            stale ||
            (!!traffic && age(traffic.observedAt, now) > 90) ||
            (!!telemetry.network &&
              age(telemetry.network.observedAt, now) > 90) ||
            (!!telemetry.vpn && age(telemetry.vpn.observedAt, now) > 90)
          }
          helpLabel="环境状态说明"
          help={
            <>
              <p>
                网络表示系统路径，不验证公网；VPN
                仅据系统管理状态，未识别的隧道保持未知。
              </p>
              <p>
                速率为物理网卡约 500ms 字节差分之和，包含局域网流量；排除回环与
                VPN 隧道，避免重复计算。不推断 Wi-Fi 类型或带宽利用率。
              </p>
              <p>
                网络 {stamp(telemetry.network?.observedAt)} · VPN{" "}
                {stamp(telemetry.vpn?.observedAt)} · 流量{" "}
                {stamp(traffic?.observedAt)}
              </p>
            </>
          }
        >
          <Badge
            variant={
              telemetry.network?.state === "connected" && !networkStale
                ? "success"
                : "secondary"
            }
          >
            {networkStale ? "上次网络" : "网络"}{" "}
            {states[telemetry.network?.state ?? "unknown"]}
          </Badge>
          <Badge variant="secondary">
            {vpnStale ? "上次VPN" : "VPN"}{" "}
            {states[telemetry.vpn?.state ?? "unknown"]}
          </Badge>
        </ResourceCard>
        <ResourceCard
          metric="fan"
          icon={<Fan size={14} />}
          label="风扇"
          value={
            <>
              {fastest === null
                ? fans?.length === 0
                  ? "无风扇读数"
                  : "未知"
                : number(fastest)}
              {fastest !== null && <small>RPM</small>}
            </>
          }
          detail={
            fanPercent !== null
              ? `最高转速比例 ${fanPercent}%`
              : "最高转速比例未知"
          }
          meter={fanPercent}
          meterLabel="风扇转速比例"
          stale={hardwareStale}
          help={
            <>
              <p>
                仅展示传感器转速，不控制风扇，不推断控制模式。主值为最快风扇，比例为各风扇实际/最大转速中的最大值，不代表散热负载。
              </p>
              <p>
                {fans
                  ?.map(
                    (fan, index) =>
                      `风扇 ${index + 1}：${number(fan.rpm)} / ${fan.maxRpm === null ? "未知" : number(fan.maxRpm)} RPM`,
                  )
                  .join("；") ?? "需 macmon；读取失败保持未知"}
              </p>
              <p>{stamp(hardware?.observedAt)}</p>
            </>
          }
        >
          <span>
            {fans?.length ? `${fans.length} 只风扇 · 只读监测` : "只读监测"}
          </span>
        </ResourceCard>
      </div>
      <div className="resource-ports">
        <span>关注端口 · TCP</span>
        <CardHelp label="关注端口说明">
          只验证本机 TCP 连接，不代表应用业务健康。
        </CardHelp>
        {!telemetry.ports.length && <span>未配置关注端口</span>}
        {telemetry.ports.map((port) => {
          const old = stale || age(port.checkedAt, now) > 90;
          const label = {
            open: "可连接",
            closed: "未监听",
            timeout: "连接超时",
            error: "检查失败",
          }[port.status];
          return (
            <Badge
              key={`${port.host}:${port.port}`}
              variant={
                old
                  ? "secondary"
                  : port.status === "open"
                    ? "success"
                    : "warning"
              }
              title={`${port.host}:${port.port} · ${time(port.checkedAt)} · 仅 TCP 连通性`}
            >
              {port.name} · {port.port}
              <span>{old ? `上次${label}` : label}</span>
              {!old && port.latencyMs !== null && (
                <span className="tabular-nums">{port.latencyMs} ms</span>
              )}
            </Badge>
          );
        })}
      </div>
    </section>
  );
}
