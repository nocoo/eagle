import { LayerCard } from "@nocoo/basalt";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import type { ReactNode } from "react";
import type { MachineView } from "../../../../packages/contracts/src/schema.ts";
import { age } from "./api.ts";
import { CardHelp } from "./CardHelp.tsx";
import { useTimezone } from "./Timezone.tsx";

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
  const offline = age(machine.lastSeen, now) > 90;
  return (
    <section className="environment-resources" aria-label="环境资源">
      <SectionRule
        className="board-rule"
        title={
          <>
            <span className="section-index">02</span> 环境资源
          </>
        }
        hint={offline ? "机器离线 · 显示最后采样" : "按实际采样时间"}
      />
      {children}
      <LayerCard className="resource-current">
        <div className="resource-chart-heading">
          <strong>当前采样</strong>
          <CardHelp label="资源采样说明">
            <p>
              {telemetry?.sampleIntervalSeconds
                ? `${telemetry.sampleIntervalSeconds} 秒采样`
                : "采样周期未知"}
              {telemetry
                ? ` · 最后采样 ${time(telemetry.observedAt)} · ${zone}`
                : " · 尚未上报"}
            </p>
            <p>
              只显示最近一次上报的数值，不做留存，不补零。内存为总量减空闲量，可能包含缓存。
            </p>
          </CardHelp>
        </div>
      </LayerCard>
    </section>
  );
}
