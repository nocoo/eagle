import {
  Badge,
  Button,
  ContentIsland,
  LayerCard,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Sidebar,
  SidebarBrand,
  SidebarDrawer,
  SidebarFooter,
  SidebarHeader,
  SidebarIconItem,
  SidebarItem,
  SidebarNav,
  SidebarPartition,
  SidebarProvider,
  SidebarToggle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nocoo/basalt";
import {
  AppHeader,
  AppHeaderMenuButton,
} from "@nocoo/basalt/components/app-header";
import {
  AppMain,
  AppShell,
  AppSkipLink,
} from "@nocoo/basalt/components/app-shell";
import { Link } from "@nocoo/basalt/components/link";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { useSidebar } from "@nocoo/basalt/components/sidebar";
import {
  Layers3,
  LayoutDashboard,
  Monitor,
  Plug,
  RefreshCw,
  TerminalSquare,
} from "@nocoo/basalt/icons";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { assessPane } from "../../../../packages/contracts/src/assessment.ts";
import { machinesBySidebarGroup } from "../../../../packages/contracts/src/machine-groups.ts";
import type {
  MachineView,
  Overview,
  Space,
} from "../../../../packages/contracts/src/schema.ts";
import { AuthError, api } from "./api.ts";
import { FamilyActions, Mark, SidebarAccount } from "./Brand.tsx";
import { Connect } from "./Connect.tsx";
import { useCurrentTaskSnapshot } from "./CurrentTaskSnapshot.ts";
import {
  Dashboard,
  DashboardSkeleton,
  MachineStatus,
  machineConnection,
  Status,
  Topology,
} from "./Dashboard.tsx";
import { EnvironmentSwitch } from "./EnvironmentSwitch.tsx";
import {
  authenticationMessage,
  localFrontend,
  localProduction,
} from "./environment.ts";
import { createRealtimeView, Realtime } from "./Realtime.tsx";
import { useTimezone } from "./Timezone.tsx";
import { WorkspaceShell } from "./WorkspaceShell.tsx";

declare const __APP_VERSION__: string;
function machineFromRoute(): string | null {
  const params = new URLSearchParams(location.search);
  return params.has("machine")
    ? params.get("machine")
    : location.pathname === "/"
      ? null
      : "";
}
function AccessGate() {
  return (
    <main className="access-gate">
      <nav
        aria-label="项目链接"
        className="absolute right-4 top-4 flex items-center gap-1"
      >
        <EnvironmentSwitch />
        <FamilyActions />
      </nav>
      <LayerCard className="access-card">
        <span className="access-mark">
          <Mark size={64} />
        </span>
        <Badge tone="info">CLOUDFLARE ACCESS</Badge>
        <h1>安全连接到 Eagle</h1>
        <p>
          {localProduction
            ? authenticationMessage
            : "使用 nocoo 团队身份继续访问工作台。"}
        </p>
        <Button onClick={() => window.location.assign(window.location.href)}>
          {localProduction
            ? "已在终端登录，重试"
            : "通过 Cloudflare Access 继续"}
        </Button>
      </LayerCard>
    </main>
  );
}

function SpaceDetail({
  machine: liveMachine,
  space: liveSpace,
  selection,
  onAuthError,
  onPaneSelection,
  actions,
  obscured,
}: {
  machine: MachineView;
  space: Space;
  selection: { pane?: string } | null;
  onAuthError: () => void;
  onPaneSelection?: (pane: string) => void;
  actions: ReactNode;
  obscured: boolean;
}) {
  const { time, zone } = useTimezone();
  const header = useRef<HTMLElement | null>(null);
  const [statusTarget, setStatusTarget] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    const sheet = header.current?.closest<HTMLElement>("[role=dialog]");
    if (!viewport || !sheet) return;
    const resize = () => {
      sheet.style.setProperty(
        "--eagle-viewport-height",
        `${viewport.height}px`,
      );
      sheet.style.setProperty(
        "--eagle-viewport-top",
        `${viewport.offsetTop}px`,
      );
    };
    resize();
    viewport.addEventListener("resize", resize);
    viewport.addEventListener("scroll", resize);
    return () => {
      viewport.removeEventListener("resize", resize);
      viewport.removeEventListener("scroll", resize);
      sheet.style.removeProperty("--eagle-viewport-height");
      sheet.style.removeProperty("--eagle-viewport-top");
    };
  }, []);
  const [paneId, setPaneId] = useState(selection?.pane ?? "");
  const paneSelectionHandler = useRef(onPaneSelection);
  paneSelectionHandler.current = onPaneSelection;
  const selectLivePane = useCallback((id: string) => {
    setPaneId(id);
    paneSelectionHandler.current?.(id);
  }, []);
  const [realtime, setRealtime] = useState(true);
  const realtimeView = useRef(createRealtimeView());
  useEffect(() => {
    if (!selection?.pane) return;
    setPaneId(selection.pane);
    setRealtime(true);
  }, [selection]);
  const current = useCurrentTaskSnapshot(
    liveMachine,
    liveSpace,
    !realtime,
    onAuthError,
  );
  const machine = realtime ? liveMachine : current.machine;
  const space = realtime ? liveSpace : (current.space ?? liveSpace);
  const panes =
    !realtime && !current.space ? [] : space.tabs.flatMap((t) => t.panes);
  const pane =
    panes.find((p) => p.id === paneId) ?? (!paneId ? panes[0] : undefined);
  const assessment = pane ? assessPane(pane, machine.report.capturedAt) : null;
  const lastRealtimeAt = useRef<string | undefined>(undefined);
  const observeRealtime = useCallback((at: string) => {
    if (
      !lastRealtimeAt.current ||
      Date.parse(at) > Date.parse(lastRealtimeAt.current)
    )
      lastRealtimeAt.current = at;
  }, []);
  return (
    <>
      <header ref={header} className="space-detail-header">
        <div className="space-detail-identity">
          <SheetTitle
            className="space-detail-title"
            title={`${space.name} · ${space.session} / ${space.id}`}
          >
            {space.name}
          </SheetTitle>
          <div className="live-header-status" ref={setStatusTarget} />
        </div>
        <SheetDescription className="sr-only">
          {space.objective || "目标待补充"}
        </SheetDescription>
        <fieldset className="space-mode-switch" aria-label="工作区视图">
          <Button
            size="sm"
            variant={realtime ? "default" : "outline"}
            aria-pressed={realtime}
            onClick={() => setRealtime(true)}
          >
            <TerminalSquare size={14} />
            实时模式
          </Button>
          <Button
            size="sm"
            variant={realtime ? "outline" : "default"}
            aria-pressed={!realtime}
            onClick={() => setRealtime(false)}
          >
            <Layers3 size={14} />
            当前任务
          </Button>
        </fieldset>
        {actions}
      </header>
      <div
        inert={obscured}
        className={
          realtime
            ? "space-detail-body space-detail-live"
            : "space-detail-body space-detail-current"
        }
      >
        {realtime ? (
          <Realtime
            view={realtimeView}
            statusTarget={statusTarget}
            machineId={machine.id}
            spaceId={space.id}
            initialPane={paneId}
            selectedPane={paneId}
            onPaneChange={selectLivePane}
            onObservedAt={observeRealtime}
          />
        ) : (
          <>
            <LayerCard
              className="current-task-snapshot"
              aria-label="当前任务快照"
            >
              <div>
                <p>
                  快照采集{" "}
                  <time dateTime={machine.report.capturedAt}>
                    {time(machine.report.capturedAt)} {zone}
                  </time>
                </p>
                <p className="text-basalt-sm text-basalt-muted-foreground">
                  仅打开或手动刷新时更新，不持续刷新任务内容。
                  {current.readAt && ` 本次读取 ${time(current.readAt)}`}
                </p>
                {lastRealtimeAt.current &&
                  Date.parse(machine.report.capturedAt) <
                    Date.parse(lastRealtimeAt.current) && (
                    <p className="text-basalt-sm text-basalt-muted-foreground">
                      快照早于最近实时画面，可能尚未包含新任务；任务摘要并非终端逐帧内容。
                    </p>
                  )}
                {space.availability === "unavailable" && (
                  <p role="status">工作区当前不可用，展示最后采集快照。</p>
                )}
                {(current.busy || current.error) && (
                  <p role="status">
                    {current.busy ? "正在读取最新已上报快照…" : current.error}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={current.busy}
                onClick={current.refresh}
                aria-label="刷新当前任务"
              >
                <RefreshCw size={14} />
                刷新
              </Button>
            </LayerCard>
            {current.space ? (
              <SectionRule title="终端布局" hint="点击卡片打开对应实时终端">
                <LayerCard className="space-topology-card">
                  <Topology
                    space={space}
                    at={machine.report.capturedAt}
                    onPane={(p) => {
                      setPaneId(p.id);
                      setRealtime(true);
                    }}
                    paneActionLabel="实时终端"
                    selectedPane={pane?.id}
                  />
                </LayerCard>
              </SectionRule>
            ) : (
              <p role="status">该机器或工作区已不在最新快照中。</p>
            )}
            {current.space && !pane && paneId && (
              <p role="status">所选终端尚未出现在采集快照中；请稍后刷新。</p>
            )}
            {pane && assessment && (current.readAt || current.error) && (
              <>
                <SectionRule title={`${pane.agent || "终端"} · ${pane.id}`}>
                  <LayerCard>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Status state={assessment.state} />
                      <span className="text-basalt-sm text-basalt-muted-foreground">
                        Herdr 弱提示：{pane.hint}
                      </span>
                    </div>
                    <h3 className="mt-3 text-basalt-base font-medium">
                      {pane.task.title}
                    </h3>
                    <p className="mt-2 text-basalt-base text-basalt-muted-foreground">
                      {assessment.reason}
                    </p>
                  </LayerCard>
                </SectionRule>
                <SectionRule
                  title="判断依据"
                  hint="来源、时间、任务与 revision 一起核对。"
                >
                  <div className="space-y-3">
                    {pane.evidence.length ? (
                      pane.evidence.map((e) => (
                        <LayerCard
                          key={`${e.kind}-${e.source}-${e.observedAt}-${e.taskId}`}
                        >
                          <div className="flex flex-wrap justify-between gap-2 text-basalt-sm">
                            <Badge variant="outline">
                              {e.kind} · {e.status}
                            </Badge>
                            <span className="text-basalt-muted-foreground">
                              {time(e.observedAt)}
                            </span>
                          </div>
                          <p className="mt-3 whitespace-pre-wrap break-words text-basalt-base">
                            {e.summary}
                          </p>
                          <p className="mt-2 break-all text-basalt-sm text-basalt-muted-foreground">
                            {e.source}
                            {e.revision ? ` · ${e.revision.slice(0, 12)}` : ""}
                          </p>
                        </LayerCard>
                      ))
                    ) : (
                      <p className="text-basalt-base text-basalt-muted-foreground">
                        尚无可靠证据。Pane 状态不能证明任务完成。
                      </p>
                    )}
                  </div>
                </SectionRule>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

function AppSidebar({
  sections,
  activeMachineId,
  page,
  now,
  navigate,
  onDismiss,
}: {
  sections: { name: string; machines: MachineView[] }[];
  activeMachineId: string;
  page: "overview" | "connect";
  now: string;
  navigate: (next: "overview" | "connect", id?: string) => void;
  onDismiss?: () => void;
}) {
  const { collapsed, peeking } = useSidebar();
  const compact = collapsed && !peeking;
  const NavItem = compact ? SidebarIconItem : SidebarItem;
  return (
    <Sidebar id="eagle-navigation" aria-label="侧栏" resizable={!onDismiss}>
      <SidebarHeader>
        <SidebarBrand
          logo={
            <Link href="/overview" aria-label="Eagle 总览">
              <img
                data-eagle-mark
                src="/brand/mark-128.png"
                alt=""
                aria-hidden="true"
              />
            </Link>
          }
          name="Eagle"
          version={`v${__APP_VERSION__}`}
          action={
            onDismiss ? (
              <SidebarToggle
                mode="dismiss"
                onDismiss={onDismiss}
                dismissLabel="收起导航"
              />
            ) : (
              <SidebarToggle expandLabel="展开导航" collapseLabel="收起导航" />
            )
          }
        />
      </SidebarHeader>
      <SidebarNav aria-label="工作台导航">
        {sections.map((section) => (
          <div key={section.name} className="flex flex-col gap-basalt-nav-gap">
            {!compact && (
              <SidebarPartition>
                {section.name} · {section.machines.length}
              </SidebarPartition>
            )}
            {section.machines.map((m) => {
              const connection = machineConnection(m, now);
              const label = {
                online: "在线",
                stale: "采集过期",
                offline: "离线 · 心跳过期",
              }[connection];
              return (
                <Tooltip key={m.id}>
                  <TooltipTrigger asChild>
                    <NavItem
                      aria-label={m.name}
                      aria-description={label}
                      className="machine-nav-item"
                      data-compact={compact}
                      active={activeMachineId === m.id && page === "overview"}
                      onClick={() => navigate("overview", m.id)}
                    >
                      <Monitor
                        className="h-4 w-4 shrink-0"
                        strokeWidth={1.5}
                        aria-hidden="true"
                      />
                      {compact ? (
                        <span className="sr-only">
                          {m.name} · {label}
                        </span>
                      ) : (
                        <span className="truncate">{m.name}</span>
                      )}
                      <span
                        className="machine-status-dot"
                        data-status={connection}
                        aria-hidden="true"
                      />
                    </NavItem>
                  </TooltipTrigger>
                  <TooltipContent side="right" sideOffset={8}>
                    {m.name} · {label}
                  </TooltipContent>
                </Tooltip>
              );
            })}
          </div>
        ))}
        {!compact && <SidebarPartition>工作态势</SidebarPartition>}
        <div
          className={`flex flex-col gap-basalt-nav-gap ${compact ? "pt-basalt-layout" : ""}`}
        >
          <NavItem
            aria-label="全局总览"
            active={page === "overview" && !activeMachineId}
            onClick={() => navigate("overview", "")}
          >
            <LayoutDashboard className="h-4 w-4 shrink-0" strokeWidth={1.5} />
            {compact ? <span className="sr-only">全局总览</span> : "全局总览"}
          </NavItem>
          <NavItem
            aria-label="Connect"
            active={page === "connect"}
            onClick={() => navigate("connect", "")}
          >
            <Plug className="h-4 w-4 shrink-0" strokeWidth={1.5} />
            {compact ? <span className="sr-only">Connect</span> : "Connect"}
          </NavItem>
        </div>
      </SidebarNav>
      <SidebarFooter>
        <SidebarAccount />
      </SidebarFooter>
    </Sidebar>
  );
}

export function App() {
  const { time, zone } = useTimezone();
  const [clock, setClock] = useState(new Date().toISOString());
  const [data, setData] = useState<Overview | null>(null);
  const [auth, setAuth] = useState(false);
  const [boot, setBoot] = useState(true);
  const [error, setError] = useState("");
  const [machineId, setMachineId] = useState<string | null>(machineFromRoute);
  const [page, setPage] = useState<"overview" | "connect">(() =>
    location.pathname === "/connect" ? "connect" : "overview",
  );
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<{
    machine: string;
    space: string;
    pane?: string;
  } | null>(null);
  const activeMachineId = machineId ?? data?.machines[0]?.id ?? "";
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 767px)").matches,
  );
  const [collapsed, setCollapsed] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  const mobileTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileSheetId = useId();
  const [syncing, setSyncing] = useState(false);
  const fetching = useRef(false);
  useEffect(() => {
    if (machineId !== null || page !== "overview" || !data?.machines.length)
      return;
    const id = data.machines[0].id;
    setMachineId(id);
    history.replaceState(null, "", `/?machine=${encodeURIComponent(id)}`);
  }, [data, machineId, page]);
  useLayoutEffect(() => {
    document.getElementById("eagle-content")?.scrollTo(0, 0);
  }, [page, activeMachineId]);
  const expire = useCallback(() => {
    setAuth(false);
    setData(null);
    setError("");
  }, []);
  const refresh = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    setSyncing(true);
    try {
      setData(await api<Overview>("/api/v1/overview"));
      setAuth(true);
      setError("");
    } catch (e) {
      if (e instanceof AuthError) {
        setAuth(false);
        setData(null);
      } else setError(e instanceof Error ? e.message : "连接中断");
    } finally {
      setClock(new Date().toISOString());
      setBoot(false);
      fetching.current = false;
      setSyncing(false);
    }
  }, []);
  useEffect(() => {
    const back = () => {
      setSelection(null);
      setPage(location.pathname === "/connect" ? "connect" : "overview");
      setMachineId(machineFromRoute());
      setSearch("");
      setMobileNav(false);
    };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    const visible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh]);
  useEffect(() => {
    const media = matchMedia("(max-width: 767px)");
    const change = () => {
      setMobile(media.matches);
      if (media.matches) setMobileNav(false);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  if (!boot && !auth && !error) return <AccessGate />;
  const machines = data?.machines ?? [];
  const machineSections = machinesBySidebarGroup(
    machines,
    data?.machineGroups ?? { groups: [], assignments: {} },
  );
  const now = clock;
  const selectedMachine = machines.find((m) => m.id === activeMachineId);
  const shown = activeMachineId
    ? machines.filter((m) => m.id === activeMachineId)
    : machines;
  const detailMachine = machines.find((m) => m.id === selection?.machine);
  const detailSpace = detailMachine?.report.spaces.find(
    (s) => s.id === selection?.space,
  );
  const navigate = (next: "overview" | "connect", id = activeMachineId) => {
    setSelection(null);
    setPage(next);
    setMachineId(id);
    setSearch("");
    history.pushState(
      null,
      "",
      `${next === "overview" ? (id ? "/" : "/overview") : `/${next}`}${id && next === "overview" ? `?machine=${encodeURIComponent(id)}` : ""}`,
    );
    setMobileNav(false);
  };

  const title =
    page === "connect" ? "Connect" : (selectedMachine?.name ?? "全局总览");
  const compactMachine = page === "overview" && !!selectedMachine;
  const syncCaption = (
    <span className="sync-caption" data-ready={!!data && !error}>
      <span
        className={syncing ? "sync-dot syncing" : "sync-dot"}
        data-offline={!!error}
      />
      {error
        ? data
          ? "连接中断 · 保留上次快照"
          : "连接中断 · 等待首次快照"
        : data
          ? `已同步 ${time(data.now)} · ${zone}`
          : "正在连接机器状态…"}
      <span>每 5 秒自动更新</span>
    </span>
  );
  return (
    <AppShell>
      <AppSkipLink>跳至内容</AppSkipLink>
      {!mobile && (
        <SidebarProvider collapsed={collapsed} onCollapsedChange={setCollapsed}>
          <AppSidebar
            sections={machineSections}
            activeMachineId={activeMachineId}
            page={page}
            now={now}
            navigate={navigate}
          />
        </SidebarProvider>
      )}
      {mobile && (
        <SidebarDrawer
          id={mobileSheetId}
          open={mobileNav}
          onOpenChange={setMobileNav}
          returnFocusRef={mobileTriggerRef}
          title="导航"
          description="选择机器与历史"
        >
          <AppSidebar
            sections={machineSections}
            activeMachineId={activeMachineId}
            page={page}
            now={now}
            navigate={navigate}
            onDismiss={() => setMobileNav(false)}
          />
        </SidebarDrawer>
      )}
      <AppMain className="relative" tabIndex={-1}>
        <AppHeader
          title={title}
          breadcrumbs={mobile ? undefined : [{ label: "工作台" }]}
          leading={
            mobile ? (
              <AppHeaderMenuButton
                ref={mobileTriggerRef}
                label="展开导航"
                aria-controls={mobileSheetId}
                onClick={() => setMobileNav(true)}
              />
            ) : undefined
          }
          actions={
            <>
              {localFrontend ? (
                <EnvironmentSwitch />
              ) : (
                <Badge tone="info" className="hidden sm:inline-flex">
                  ACCESS
                </Badge>
              )}
              <FamilyActions />
            </>
          }
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:px-basalt-layout-sm md:pb-basalt-layout-sm">
          <ContentIsland id="eagle-content" className="relative">
            <div
              className="sync-progress"
              data-active={syncing}
              aria-hidden="true"
            />
            <div
              className={
                compactMachine
                  ? "page-content machine-page space-y-3"
                  : "page-content space-y-3 md:space-y-5"
              }
            >
              <PageHeader
                title={title}
                description={
                  compactMachine && selectedMachine ? (
                    <span className="machine-subtitle">
                      <MachineStatus machine={selectedMachine} now={now} />
                      {syncCaption}
                    </span>
                  ) : page === "connect" ? (
                    "连接机器，管理凭证，把接入交给 Agent。"
                  ) : activeMachineId ? (
                    "机器资源、工作空间与任务证据。"
                  ) : (
                    "全部机器的工作分布与资源概况。"
                  )
                }
                actions={
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant="outline"
                        size={mobile ? "lg" : "sm"}
                        aria-label="刷新"
                        disabled={syncing}
                        onClick={() => void refresh()}
                      >
                        {!mobile && (
                          <RefreshCw
                            size={14}
                            aria-hidden="true"
                            className={syncing ? "eagle-spin" : ""}
                          />
                        )}
                        刷新
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>刷新</TooltipContent>
                  </Tooltip>
                }
              />
              {error && (
                <LayerCard>
                  <p
                    role="alert"
                    className="text-basalt-base text-basalt-destructive"
                  >
                    {error}
                  </p>
                </LayerCard>
              )}
              {!compactMachine && syncCaption}
              {page === "overview" &&
                !activeMachineId &&
                !!data?.pendingMachines?.length && (
                  <LayerCard>
                    <p className="text-basalt-base text-basalt-muted-foreground">
                      等待首次上报：{data.pendingMachines.join("、")}
                    </p>
                  </LayerCard>
                )}
              {boot ? (
                <DashboardSkeleton />
              ) : page === "connect" ? (
                <Connect
                  live={machines}
                  onChange={() => void refresh()}
                  onOpen={(id) => navigate("overview", id)}
                  onAuthError={expire}
                />
              ) : (
                <Dashboard
                  key={activeMachineId || "fleet"}
                  machines={shown}
                  now={now}
                  search={search}
                  onSearch={setSearch}
                  onMachine={
                    !activeMachineId
                      ? (id) => {
                          setSearch("");
                          navigate("overview", id);
                        }
                      : undefined
                  }
                  onOpen={(machine, space, pane) =>
                    setSelection({ machine, space, pane })
                  }
                />
              )}
            </div>
          </ContentIsland>
        </div>
      </AppMain>
      <Sheet
        open={!!selection}
        onOpenChange={(open) => {
          if (!open) setSelection(null);
        }}
      >
        {detailMachine && detailSpace ? (
          <WorkspaceShell
            machine={detailMachine}
            space={detailSpace}
            selectedPane={selection?.pane}
            onPane={(pane) =>
              setSelection((previous) =>
                previous &&
                previous.machine === detailMachine.id &&
                previous.space === detailSpace.id
                  ? { ...previous, pane }
                  : previous,
              )
            }
            onWorkspace={(space) =>
              setSelection({ machine: detailMachine.id, space })
            }
            onBack={() => navigate("overview", detailMachine.id)}
            onAuthError={expire}
          >
            {(chrome) => (
              <SpaceDetail
                {...chrome}
                key={`${detailMachine.id}:${detailSpace.id}`}
                machine={detailMachine}
                space={detailSpace}
                selection={selection}
                onAuthError={expire}
                onPaneSelection={(pane) =>
                  setSelection((previous) =>
                    previous &&
                    previous.machine === detailMachine.id &&
                    previous.space === detailSpace.id &&
                    previous.pane !== pane
                      ? { ...previous, pane }
                      : previous,
                  )
                }
              />
            )}
          </WorkspaceShell>
        ) : (
          <SheetContent side="right" className="space-sheet">
            <SheetTitle>Space 已关闭</SheetTitle>
            <SheetDescription>
              可在最近历史查看之前的任务与证据。
            </SheetDescription>
          </SheetContent>
        )}
      </Sheet>
    </AppShell>
  );
}
