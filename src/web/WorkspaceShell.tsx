import { Button, SheetClose } from "@nocoo/basalt";
import {
  ArrowLeft,
  ArrowUpRight,
  Layers3,
  RefreshCw,
  TerminalSquare,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { assessPane } from "../shared/assessment.ts";
import type { MachineView, Space } from "../shared/schema.ts";
import { useCurrentTaskSnapshot } from "./CurrentTaskSnapshot.ts";
import { MachineResources, machineConnection, Status } from "./Dashboard.tsx";
import { useTimezone } from "./Timezone.tsx";
import { WorkspaceNavigation } from "./WorkspaceNavigation.tsx";

function WorkspaceSnapshot({
  machine,
  space,
  selectedPane,
  onPane,
  onAuthError,
}: {
  machine: MachineView;
  space: Space;
  selectedPane?: string;
  onPane: (id: string) => void;
  onAuthError: () => void;
}) {
  const current = useCurrentTaskSnapshot(machine, space, true, onAuthError);
  const { time, zone } = useTimezone();
  const view = current.space;
  const connection = machineConnection(
    current.machine,
    current.readAt ?? new Date().toISOString(),
  );
  const cards =
    view?.tabs.flatMap((tab) => tab.panes.map((pane) => ({ tab, pane }))) ?? [];
  return (
    <section
      className="workspace-snapshot"
      aria-label="工作区快照"
      aria-busy={current.busy}
      data-read-at={current.readAt}
    >
      <div className="workspace-snapshot-heading">
        <div>
          <span className="workspace-eyebrow">WORKSPACE SNAPSHOT</span>
          <h2>
            任务快照 <span>{cards.length}</span>
          </h2>
        </div>
        <Button
          size="icon"
          variant="outline"
          disabled={current.busy}
          aria-label="刷新工作区快照"
          onClick={current.refresh}
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      <p className="workspace-objective">
        {view?.objective || "等待工作区目标"}
      </p>
      <p className="workspace-snapshot-time">
        采集{" "}
        <time dateTime={current.machine.report.capturedAt}>
          {time(current.machine.report.capturedAt)} {zone}
        </time>
        <br />
        打开时读取 · 手动刷新 · 非实时内容
      </p>
      {(current.busy || current.error) && (
        <p className="workspace-snapshot-notice" role="status">
          {current.busy ? "正在读取最新已上报快照…" : current.error}
        </p>
      )}
      {view?.availability === "unavailable" && (
        <p role="status">工作区暂不可用，保留最后采集快照。</p>
      )}
      {!view && !current.busy && <p role="status">工作区已不在最新快照中。</p>}
      <div className="workspace-task-grid">
        {cards.map(({ tab, pane }) => {
          const state =
            connection === "online" && view?.availability !== "unavailable"
              ? assessPane(pane, current.machine.report.capturedAt).state
              : "unverified";
          const summary = current.machine.summaries?.find(
            (s) =>
              s.spaceId === view?.id &&
              s.paneId === pane.id &&
              s.taskId === pane.task.id,
          );
          return (
            <Button
              key={pane.id}
              variant="outline"
              className="workspace-task-card"
              data-pane={pane.id}
              aria-label={`打开实时终端 ${pane.id}`}
              aria-pressed={selectedPane === pane.id}
              onClick={() => onPane(pane.id)}
            >
              <span className="workspace-task-meta">
                <span>
                  <TerminalSquare size={13} />
                  {pane.agent || "terminal"}
                </span>
                <span>{pane.id.split(":").at(-1)}</span>
              </span>
              <strong className="workspace-task-title">
                {summary?.summary.task || pane.task.title || pane.title}
              </strong>
              <span className="workspace-task-tab">
                <Layers3 size={12} />
                {tab.name}
              </span>
              <span className="workspace-task-footer">
                <Status state={state} />
                <ArrowUpRight size={15} />
              </span>
            </Button>
          );
        })}
      </div>
      <section className="workspace-machine-snapshot" aria-label="机器快照">
        <div className="workspace-snapshot-heading">
          <div>
            <span className="workspace-eyebrow">MACHINE SNAPSHOT</span>
            <h2>机器快照</h2>
          </div>
        </div>
        <p className="workspace-machine-meta">
          {current.machine.name} · {current.machine.report.machine.platform} ·{" "}
          {current.machine.report.spaces.length} 个工作区
        </p>
        <MachineResources
          machine={current.machine}
          now={current.readAt ?? new Date().toISOString()}
          snapshot
        />
      </section>
    </section>
  );
}

export function WorkspaceShell({
  machine,
  space,
  selectedPane,
  onPane,
  onWorkspace,
  onBack,
  onAuthError,
  children,
}: {
  machine: MachineView;
  space: Space;
  selectedPane?: string;
  onPane: (id: string) => void;
  onWorkspace: (id: string) => void;
  onBack: () => void;
  onAuthError: () => void;
  children: ReactNode;
}) {
  const panelId = useId();
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 767px)").matches,
  );
  const [wide, setWide] = useState(
    () => matchMedia("(min-width: 1024px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(min-width: 1024px)");
    const narrow = matchMedia("(max-width: 767px)");
    const changed = () => setWide(media.matches);
    const mobileChanged = () => setMobile(narrow.matches);
    media.addEventListener("change", changed);
    narrow.addEventListener("change", mobileChanged);
    return () => {
      media.removeEventListener("change", changed);
      narrow.removeEventListener("change", mobileChanged);
    };
  }, []);
  return (
    <div className="workspace-shell" data-wide={wide}>
      <div className="workspace-window-bar">
        <Button
          size="icon"
          variant="ghost"
          aria-label="返回机器页"
          title="返回机器页"
          onClick={onBack}
        >
          <ArrowLeft size={17} />
        </Button>
        <WorkspaceNavigation
          spaces={machine.report.spaces}
          space={space}
          panelId={panelId}
          mobile={mobile}
          onWorkspace={onWorkspace}
        />
        <SheetClose asChild>
          <Button size="icon" variant="ghost" aria-label="关闭工作区">
            <X size={18} />
          </Button>
        </SheetClose>
      </div>
      <section
        id={panelId}
        role={mobile ? "region" : "tabpanel"}
        aria-label={mobile ? space.name : undefined}
        aria-labelledby={mobile ? undefined : `${panelId}-tab-${space.id}`}
        className="workspace-columns"
      >
        <aside className="workspace-sidebar">
          {wide && (
            <WorkspaceSnapshot
              key={space.id}
              machine={machine}
              space={space}
              selectedPane={selectedPane}
              onPane={onPane}
              onAuthError={onAuthError}
            />
          )}
        </aside>
        <div className="workspace-detail">{children}</div>
      </section>
    </div>
  );
}
