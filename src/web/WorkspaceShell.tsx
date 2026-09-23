import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  SheetClose,
  SheetContent,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nocoo/basalt";
import {
  ArrowLeft,
  Clock3,
  Layers3,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  RefreshCw,
  Target,
  TerminalSquare,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { assessPane } from "../shared/assessment.ts";
import type { MachineView, Space } from "../shared/schema.ts";
import { useCurrentTaskSnapshot } from "./CurrentTaskSnapshot.ts";
import { MachineResources, machineConnection, Status } from "./Dashboard.tsx";
import { useTimezone } from "./Timezone.tsx";
import { WorkspaceNavigation } from "./WorkspaceNavigation.tsx";

function SnapshotAge({
  capturedAt,
  enabled,
}: {
  capturedAt: string;
  enabled: boolean;
}) {
  const { time, zone } = useTimezone();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled, capturedAt]);
  const seconds = Math.floor((now - Date.parse(capturedAt)) / 1000);
  const elapsed = [
    seconds >= 3600 && `${Math.floor(seconds / 3600)} 小时`,
    seconds >= 60 && `${Math.floor(seconds / 60) % 60} 分`,
    `${seconds % 60} 秒`,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="sm" className="workspace-snapshot-time">
          <Clock3 size={13} />
          <time dateTime={capturedAt}>
            {Number.isFinite(seconds) && seconds >= 0
              ? `采集于 ${elapsed}前`
              : "采集时间异常"}
          </time>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <p>
          {time(capturedAt)} {zone}
        </p>
        <p>打开时读取 · 手动刷新 · 非实时内容</p>
      </TooltipContent>
    </Tooltip>
  );
}

function WorkspaceSnapshot({
  machine,
  space,
  selectedPane,
  onPane,
  onAuthError,
  enabled,
}: {
  machine: MachineView;
  space: Space;
  selectedPane?: string;
  onPane: (id: string) => void;
  onAuthError: () => void;
  enabled: boolean;
}) {
  const current = useCurrentTaskSnapshot(machine, space, enabled, onAuthError);
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
          <h2>
            <Layers3 size={14} /> 任务快照 <span>{cards.length}</span>
          </h2>
        </div>
        <Button
          size="icon"
          variant="outline"
          disabled={current.busy}
          aria-label="刷新工作区快照"
          onClick={current.refresh}
        >
          <RefreshCw
            size={15}
            className={current.busy ? "workspace-refreshing" : undefined}
          />
        </Button>
      </div>
      <SnapshotAge
        capturedAt={current.machine.report.capturedAt}
        enabled={enabled}
      />
      <Collapsible className="workspace-objective">
        <CollapsibleTrigger>
          <span className="workspace-objective-label">
            <Target size={13} />
            工作区目标
          </span>
        </CollapsibleTrigger>
        <p className="workspace-objective-preview">
          {view?.objective || "等待工作区目标"}
        </p>
        <CollapsibleContent unstyled>
          {view?.objective || "等待工作区目标"}
        </CollapsibleContent>
      </Collapsible>
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
              <strong
                className="workspace-task-title"
                title={summary?.summary.task || pane.task.title || pane.title}
              >
                {summary?.summary.task || pane.task.title || pane.title}
              </strong>
              <span className="workspace-task-footer">
                <span className="workspace-task-tab" title={tab.name}>
                  <Layers3 size={12} />
                  {tab.name}
                </span>
                <Status state={state} />
              </span>
            </Button>
          );
        })}
      </div>
      <section className="workspace-machine-snapshot" aria-label="机器快照">
        <div className="workspace-snapshot-heading">
          <div>
            <h2>
              <Monitor size={14} />
              机器快照
            </h2>
          </div>
        </div>
        <p className="workspace-machine-meta">
          {current.machine.name} · {current.machine.report.machine.platform} ·{" "}
          {current.machine.report.spaces.length} 个工作区
        </p>
        <p
          className="workspace-context"
          title={`${space.session} / ${space.id}`}
        >
          <TerminalSquare size={12} />
          <span>
            {space.session} / {space.id}
          </span>
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
  children: (chrome: { actions: ReactNode; obscured: boolean }) => ReactNode;
}) {
  const panelId = useId();
  const infoId = useId();
  const toggle = useRef<HTMLButtonElement>(null);
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 767px)").matches,
  );
  const [wide, setWide] = useState(
    () => matchMedia("(min-width: 1280px)").matches,
  );
  const [information, setInformation] = useState<boolean | undefined>();
  const showInformation = information ?? wide;
  useEffect(() => {
    const media = matchMedia("(min-width: 1280px)");
    const narrow = matchMedia("(max-width: 767px)");
    const changed = () => {
      setWide(media.matches);
      setInformation(undefined);
    };
    const mobileChanged = () => {
      setMobile(narrow.matches);
      setInformation(undefined);
    };
    media.addEventListener("change", changed);
    narrow.addEventListener("change", mobileChanged);
    return () => {
      media.removeEventListener("change", changed);
      narrow.removeEventListener("change", mobileChanged);
    };
  }, []);
  const navigation = (
    <WorkspaceNavigation
      spaces={machine.report.spaces}
      space={space}
      panelId={panelId}
      mobile={mobile}
      onWorkspace={onWorkspace}
    />
  );
  const back = (
    <Button
      size="icon"
      variant="ghost"
      aria-label="返回机器页"
      title="返回机器页"
      onClick={onBack}
    >
      <ArrowLeft size={16} />
    </Button>
  );
  const close = (
    <SheetClose asChild>
      <Button
        size="icon"
        variant="ghost"
        aria-label="关闭工作区"
        title="关闭工作区"
      >
        <X size={16} />
      </Button>
    </SheetClose>
  );
  const actions = (
    <Button
      ref={toggle}
      size="icon"
      variant="ghost"
      className="workspace-information-toggle"
      aria-label="工作区信息"
      title={showInformation ? "收起工作区信息" : "展开工作区信息"}
      aria-expanded={showInformation}
      aria-controls={infoId}
      onClick={() => setInformation(!showInformation)}
    >
      {showInformation ? (
        <PanelRightClose size={16} />
      ) : (
        <PanelRightOpen size={16} />
      )}
    </Button>
  );
  return (
    <SheetContent
      side="right"
      className="space-sheet"
      onEscapeKeyDown={(event) => {
        if (event.isComposing) {
          event.preventDefault();
          return;
        }
        if (
          event.target instanceof HTMLInputElement &&
          event.target.hasAttribute("data-workspace-search") &&
          event.target.value
        ) {
          event.preventDefault();
        } else if (!wide && showInformation) {
          event.preventDefault();
          setInformation(false);
          toggle.current?.focus();
        }
      }}
    >
      <div
        className="workspace-shell"
        data-wide={wide}
        data-information={showInformation}
      >
        {!mobile && (
          <aside className="workspace-rail" aria-label="工作区导航">
            <div className="workspace-rail-header">
              {back}
              <span title={machine.name}>{machine.name}</span>
              {close}
            </div>
            {navigation}
          </aside>
        )}
        {mobile && (
          <div className="workspace-mobile-navigation">
            {back}
            {navigation}
            {close}
          </div>
        )}
        <section
          id={panelId}
          role={mobile ? "region" : "tabpanel"}
          aria-label={space.name}
          className="workspace-columns"
        >
          <div className="workspace-detail">
            {children({
              actions,
              obscured: mobile && showInformation,
            })}
          </div>
          <aside
            id={infoId}
            className="workspace-inspector"
            aria-hidden={!showInformation}
            inert={!showInformation}
            aria-label="工作区信息"
          >
            <div className="workspace-inspector-content">
              <WorkspaceSnapshot
                key={`${machine.id}/${space.id}`}
                machine={machine}
                space={space}
                selectedPane={selectedPane}
                onPane={(id) => {
                  onPane(id);
                  if (!wide) {
                    setInformation(false);
                    toggle.current?.focus();
                  }
                }}
                onAuthError={onAuthError}
                enabled={showInformation}
              />
            </div>
          </aside>
        </section>
      </div>
    </SheetContent>
  );
}
