import {
  Badge,
  Button,
  ContentIsland,
  DialogDescription,
  DialogTitle,
  LayerCard,
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  Sidebar,
  SidebarFooter,
  SidebarHeader,
  SidebarIconItem,
  SidebarItem,
  SidebarNav,
  SidebarPartition,
  SidebarProvider,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nocoo/basalt";
import { AppHeader } from "@nocoo/basalt/components/app-header";
import {
  AppMain,
  AppShell,
  AppSkipLink,
} from "@nocoo/basalt/components/app-shell";
import { PageHeader } from "@nocoo/basalt/components/page-header";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";
import {
  History as HistoryIcon,
  Layers3,
  LayoutDashboard,
  Monitor,
  PanelLeft,
  Plug,
  RefreshCw,
  Settings as SettingsIcon,
  TerminalSquare,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { assessPane } from "../shared/assessment.ts";
import type {
  HistoryEntry,
  MachineView,
  Overview,
  Space,
} from "../shared/schema.ts";
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
import { HourlyHistory } from "./HourlyHistory.tsx";
import { PaneSummaryView } from "./PaneSummary.tsx";
import { Realtime } from "./Realtime.tsx";
import { Settings } from "./Settings.tsx";
import { useTimezone } from "./Timezone.tsx";

declare const __APP_VERSION__: string;
function AccessGate() {
  return (
    <main className="access-gate">
      <nav
        aria-label="项目链接"
        className="absolute right-4 top-4 flex items-center gap-1"
      >
        <FamilyActions />
      </nav>
      <LayerCard className="access-card">
        <span className="access-mark">
          <Mark size={64} />
        </span>
        <Badge variant="blue">CLOUDFLARE ACCESS</Badge>
        <h1>安全连接到 Eagle</h1>
        <p>使用 nocoo 团队身份继续访问工作台。</p>
        <Button onClick={() => window.location.assign(window.location.href)}>
          通过 Cloudflare Access 继续
        </Button>
      </LayerCard>
    </main>
  );
}

function HistoryView({ machine, space }: { machine: string; space?: string }) {
  const { time } = useTimezone();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(
    async (before?: number) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setLoading(true);
      setError("");
      const query = new URLSearchParams({ limit: "12" });
      if (machine) query.set("machine", machine);
      if (space) query.set("space", space);
      if (before) query.set("before", String(before));
      try {
        const result = await api<{
          entries: HistoryEntry[];
          nextCursor: number | null;
        }>(`/api/v1/history?${query}`, { signal: controller.signal });
        if (controller.signal.aborted) return;
        setEntries((old) =>
          before ? [...old, ...(result.entries ?? [])] : (result.entries ?? []),
        );
        setCursor(result.nextCursor);
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "历史加载失败");
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    },
    [machine, space],
  );
  useEffect(() => {
    setEntries([]);
    void load();
    return () => active.current?.abort();
  }, [load]);
  return (
    <div className="space-y-4">
      <HourlyHistory machine={machine} />
      <div className="flex items-center justify-between">
        <p className="text-sm text-basalt-muted-foreground">
          历史归档已暂停（旧版原始快照）；新的 AI 小时报告显示在上方。
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void load()}
          disabled={loading}
        >
          刷新历史
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-basalt-destructive">
          {error}
        </p>
      )}
      {!loading && !entries.length && !error && (
        <LayerCard>暂无历史记录；当前状态可在总览查看。</LayerCard>
      )}
      {loading && !entries.length && (
        <div role="status" aria-label="正在读取历史" className="space-y-3">
          {[0, 1, 2].map((key) => (
            <LayerCard key={key}>
              <SkeletonLine />
              <SkeletonLine minWidth={50} maxWidth={70} />
            </LayerCard>
          ))}
        </div>
      )}
      {entries.map((entry) => (
        <LayerCard key={entry.seq}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium">
              {entry.report.machine.name}
            </span>
            <span className="text-xs text-basalt-muted-foreground">
              采集 {time(entry.report.capturedAt)}
            </span>
          </div>
          <ul className="mt-3 space-y-2 text-sm">
            {(entry.changes.length
              ? entry.changes
              : ["任务与拓扑无变化，采集证据已刷新"]
            ).map((change) => (
              <li key={change} className="break-words">
                {change}
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-basalt-muted-foreground">
            {entry.report.spaces.length} 个 Space · 接收{" "}
            {time(entry.receivedAt)} · #{entry.seq}
          </p>
        </LayerCard>
      ))}
      {cursor && (
        <Button
          variant="outline"
          loading={loading}
          onClick={() => void load(cursor)}
        >
          更早记录
        </Button>
      )}
      {loading && (
        <p role="status" className="text-sm text-basalt-muted-foreground">
          读取历史…
        </p>
      )}
    </div>
  );
}

function SpaceDetail({
  machine: liveMachine,
  space: liveSpace,
  initialPane = "",
  onAuthError,
}: {
  machine: MachineView;
  space: Space;
  initialPane?: string;
  onAuthError: () => void;
}) {
  const { time, zone } = useTimezone();
  const header = useRef<HTMLElement | null>(null);
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
  const [paneId, setPaneId] = useState(initialPane);
  const [history, setHistory] = useState(false);
  const [realtime, setRealtime] = useState(true);
  const current = useCurrentTaskSnapshot(
    liveMachine,
    liveSpace,
    !history && !realtime,
    onAuthError,
  );
  const machine = realtime || history ? liveMachine : current.machine;
  const space = realtime || history ? liveSpace : (current.space ?? liveSpace);
  const panes =
    !realtime && !history && !current.space
      ? []
      : space.tabs.flatMap((t) => t.panes);
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
        <div className="space-detail-eyebrow">
          <span>
            <Layers3 size={13} /> 工作区{" "}
            <span className="mono">{space.id}</span>
          </span>
          <SheetClose asChild>
            <Button size="icon" variant="outline" aria-label="关闭工作区">
              <X size={17} />
            </Button>
          </SheetClose>
        </div>
        <SheetTitle className="space-detail-title">{space.name}</SheetTitle>
        <SheetDescription className="space-detail-description">
          {space.objective || "目标待补充"}
        </SheetDescription>
        <div className="space-detail-meta">
          <span>
            <Monitor size={13} />
            {machine.name}
          </span>
          <span>
            <TerminalSquare size={13} />
            {panes.length} Panes
          </span>
          <span className="mono">{zone}</span>
        </div>
        <fieldset className="space-mode-switch" aria-label="工作区视图">
          <Button
            size="sm"
            variant={realtime ? "default" : "outline"}
            aria-pressed={realtime}
            onClick={() => {
              setRealtime(true);
              setHistory(false);
            }}
          >
            <TerminalSquare size={14} />
            实时模式
          </Button>
          <Button
            size="sm"
            variant={history || realtime ? "outline" : "default"}
            aria-pressed={!history && !realtime}
            onClick={() => {
              setHistory(false);
              setRealtime(false);
            }}
          >
            <Layers3 size={14} />
            当前任务
          </Button>
          <Button
            size="sm"
            variant={history ? "default" : "outline"}
            aria-pressed={history}
            onClick={() => {
              setHistory(true);
              setRealtime(false);
            }}
          >
            <HistoryIcon size={14} />
            Space 历史
          </Button>
        </fieldset>
      </header>
      <div
        className={
          realtime
            ? "space-detail-body space-detail-live"
            : history
              ? "space-detail-body"
              : "space-detail-body space-detail-current"
        }
      >
        {realtime ? (
          <Realtime
            machineId={machine.id}
            spaceId={space.id}
            initialPane={paneId}
            onPaneChange={setPaneId}
            onObservedAt={observeRealtime}
          />
        ) : history ? (
          <HistoryView machine={machine.id} space={space.id} />
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
                <p className="text-xs text-basalt-muted-foreground">
                  仅打开或手动刷新时更新，不持续刷新任务内容。
                  {current.readAt && ` 本次读取 ${time(current.readAt)}`}
                </p>
                {lastRealtimeAt.current &&
                  Date.parse(machine.report.capturedAt) <
                    Date.parse(lastRealtimeAt.current) && (
                    <p className="text-xs text-basalt-muted-foreground">
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
                    summaries={machine.summaries}
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
                <PaneSummaryView
                  key={`${space.id}/${pane.id}/${current.generation}`}
                  machine={machine}
                  space={space}
                  pane={pane}
                  at={current.readAt}
                />
                <SectionRule title={`${pane.agent || "终端"} · ${pane.id}`}>
                  <LayerCard>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <Status state={assessment.state} />
                      <span className="text-xs text-basalt-muted-foreground">
                        Herdr 弱提示：{pane.hint}
                      </span>
                    </div>
                    <h3 className="mt-3 text-sm font-medium">
                      {pane.task.title}
                    </h3>
                    <p className="mt-2 text-sm text-basalt-muted-foreground">
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
                          <div className="flex flex-wrap justify-between gap-2 text-xs">
                            <Badge variant="outline">
                              {e.kind} · {e.status}
                            </Badge>
                            <span className="text-basalt-muted-foreground">
                              {time(e.observedAt)}
                            </span>
                          </div>
                          <p className="mt-3 whitespace-pre-wrap break-words text-sm">
                            {e.summary}
                          </p>
                          <p className="mt-2 break-all text-xs text-basalt-muted-foreground">
                            {e.source}
                            {e.revision ? ` · ${e.revision.slice(0, 12)}` : ""}
                          </p>
                        </LayerCard>
                      ))
                    ) : (
                      <p className="text-sm text-basalt-muted-foreground">
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

export function App() {
  const { time, zone } = useTimezone();
  const [clock, setClock] = useState(new Date().toISOString());
  const [data, setData] = useState<Overview | null>(null);
  const [auth, setAuth] = useState(false);
  const [boot, setBoot] = useState(true);
  const [error, setError] = useState("");
  const [machineId, setMachineId] = useState(
    () => new URLSearchParams(location.search).get("machine") || "",
  );
  const [page, setPage] = useState<
    "overview" | "history" | "connect" | "settings"
  >(() =>
    location.pathname === "/settings"
      ? "settings"
      : location.pathname === "/connect"
        ? "connect"
        : location.pathname === "/history"
          ? "history"
          : "overview",
  );
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<{
    machine: string;
    space: string;
    pane?: string;
  } | null>(null);
  const [mobile, setMobile] = useState(
    () => matchMedia("(max-width: 767px)").matches,
  );
  const [collapsed, setCollapsed] = useState(mobile);
  const [syncing, setSyncing] = useState(false);
  const fetching = useRef(false);
  useLayoutEffect(() => {
    document.getElementById("eagle-content")?.scrollTo(0, 0);
  }, [page, machineId]);
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
      setPage(
        location.pathname === "/settings"
          ? "settings"
          : location.pathname === "/connect"
            ? "connect"
            : location.pathname === "/history"
              ? "history"
              : "overview",
      );
      setMachineId(new URLSearchParams(location.search).get("machine") || "");
      setSearch("");
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
      setCollapsed(media.matches);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  if (!boot && !auth && !error) return <AccessGate />;
  const machines = data?.machines ?? [];
  const now = clock;
  const selectedMachine = machines.find((m) => m.id === machineId);
  const shown = machineId
    ? machines.filter((m) => m.id === machineId)
    : machines;
  const detailMachine = machines.find((m) => m.id === selection?.machine);
  const detailSpace = detailMachine?.report.spaces.find(
    (s) => s.id === selection?.space,
  );
  const navigate = (
    next: "overview" | "history" | "connect" | "settings",
    id = machineId,
  ) => {
    setSelection(null);
    setPage(next);
    setMachineId(id);
    setSearch("");
    history.pushState(
      null,
      "",
      `${next === "overview" ? "/" : `/${next}`}${id && (next === "overview" || next === "history") ? `?machine=${encodeURIComponent(id)}` : ""}`,
    );
    if (mobile) setCollapsed(true);
  };
  const sidebarToggle = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className={!collapsed || mobile ? "h-7 w-7 shrink-0" : undefined}
          aria-label={collapsed && !mobile ? "展开导航" : "收起导航"}
          aria-expanded={!collapsed}
          aria-controls="eagle-navigation"
          onClick={() => setCollapsed((value) => !value)}
        >
          <PanelLeft size={18} strokeWidth={1.5} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={collapsed && !mobile ? "right" : "bottom"}>
        {collapsed && !mobile ? "展开侧栏" : "收起侧栏"}
      </TooltipContent>
    </Tooltip>
  );
  const NavItem = collapsed && !mobile ? SidebarIconItem : SidebarItem;
  const title =
    page === "settings"
      ? "设置"
      : page === "connect"
        ? "Connect"
        : page === "history"
          ? "最近历史"
          : (selectedMachine?.name ?? "全局总览");
  const compactMachine = page === "overview" && !!selectedMachine;
  const syncCaption = (
    <span className="sync-caption">
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
    <SidebarProvider
      collapsed={collapsed}
      onCollapsedChange={setCollapsed}
      overlay={mobile}
    >
      <AppShell>
        <AppSkipLink>跳至内容</AppSkipLink>
        <Sidebar id="eagle-navigation" aria-label="侧栏">
          {mobile && (
            <>
              <DialogTitle className="sr-only">导航</DialogTitle>
              <DialogDescription className="sr-only">
                选择机器与历史
              </DialogDescription>
            </>
          )}
          <SidebarHeader className="gap-3 pl-[22px] pr-3">
            <Mark />
            {(!collapsed || mobile) && (
              <>
                <strong className="text-lg font-semibold">Eagle</strong>
                <Badge variant="secondary" className="font-mono text-[10px]">
                  v{__APP_VERSION__}
                </Badge>
                <div className="ml-auto">{sidebarToggle}</div>
              </>
            )}
          </SidebarHeader>
          {collapsed && !mobile && (
            <div className="mb-1 self-center">{sidebarToggle}</div>
          )}
          <SidebarNav aria-label="工作台导航">
            {(!collapsed || mobile) && (
              <SidebarPartition>工作态势</SidebarPartition>
            )}
            <div
              className={`flex flex-col gap-0.5 ${collapsed && !mobile ? "items-center" : "px-3"}`}
            >
              <NavItem
                aria-label="全局总览"
                active={page === "overview" && !machineId}
                onClick={() => navigate("overview", "")}
              >
                <LayoutDashboard
                  className="h-4 w-4 shrink-0"
                  strokeWidth={1.5}
                />
                {(!collapsed || mobile) && "全局总览"}
              </NavItem>
              <NavItem
                aria-label="Connect"
                active={page === "connect"}
                onClick={() => navigate("connect", "")}
              >
                <Plug className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                {(!collapsed || mobile) && "Connect"}
              </NavItem>
              <NavItem
                aria-label="最近历史"
                active={page === "history"}
                onClick={() => navigate("history")}
              >
                <HistoryIcon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                {(!collapsed || mobile) && "最近历史"}
              </NavItem>
              <NavItem
                aria-label="设置"
                active={page === "settings"}
                onClick={() => navigate("settings", "")}
              >
                <SettingsIcon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                {(!collapsed || mobile) && "设置"}
              </NavItem>
            </div>
            {(!collapsed || mobile) && (
              <SidebarPartition className="mt-6">
                机器 · {machines.length}
              </SidebarPartition>
            )}
            <div
              className={`flex flex-col gap-0.5 ${collapsed && !mobile ? "items-center mt-6" : "px-3"}`}
            >
              {machines.map((m) => {
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
                        data-compact={collapsed && !mobile}
                        active={machineId === m.id && page === "overview"}
                        onClick={() => navigate("overview", m.id)}
                      >
                        <Monitor
                          className="h-4 w-4 shrink-0"
                          strokeWidth={1.5}
                          aria-hidden="true"
                        />
                        {(!collapsed || mobile) && (
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
          </SidebarNav>
          <SidebarFooter
            className={
              collapsed && !mobile
                ? "flex flex-col items-center gap-2 px-0"
                : undefined
            }
          >
            <SidebarAccount collapsed={collapsed && !mobile} />
          </SidebarFooter>
        </Sidebar>
        <AppMain className="relative" tabIndex={-1}>
          <AppHeader
            title={title}
            breadcrumbs={[
              { label: <span className="whitespace-nowrap">工作台</span> },
            ]}
            leading={
              mobile ? (
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="展开导航"
                  onClick={() => setCollapsed(false)}
                >
                  <PanelLeft size={18} strokeWidth={1.5} aria-hidden="true" />
                </Button>
              ) : undefined
            }
            actions={
              <>
                <Badge variant="blue" className="hidden sm:inline-flex">
                  {import.meta.env.DEV ? "LOCAL" : "ACCESS"}
                </Badge>
                <FamilyActions />
              </>
            }
          />
          <div className="flex min-h-0 flex-1 flex-col px-2 pb-2 md:px-3 md:pb-3">
            <ContentIsland id="eagle-content" className="relative">
              <div
                className="sync-progress"
                data-active={syncing}
                aria-hidden="true"
              />
              <div
                className={
                  compactMachine ? "machine-page space-y-3" : "space-y-5"
                }
              >
                <PageHeader
                  title={title}
                  description={
                    page === "settings" ? (
                      "显示时区、AI 连接与小时报告。"
                    ) : compactMachine && selectedMachine ? (
                      <span className="machine-subtitle">
                        <MachineStatus machine={selectedMachine} now={now} />
                        {syncCaption}
                      </span>
                    ) : page === "connect" ? (
                      "连接机器，管理凭证，把接入交给 Agent。"
                    ) : machineId ? (
                      "机器资源、工作空间与任务证据。"
                    ) : (
                      "全部机器的工作分布与资源概况。"
                    )
                  }
                  actions={
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label="刷新"
                        disabled={syncing}
                        onClick={() => void refresh()}
                      >
                        <RefreshCw
                          size={14}
                          className={syncing ? "eagle-spin" : ""}
                        />
                        刷新
                      </Button>
                      <Button
                        size="sm"
                        onClick={() =>
                          navigate(page === "overview" ? "history" : "overview")
                        }
                        aria-label={
                          page === "overview" ? "查看最近历史" : "返回总览"
                        }
                      >
                        {page === "overview" ? "最近历史" : "返回总览"}
                      </Button>
                    </>
                  }
                />
                {error && (
                  <LayerCard>
                    <p role="alert" className="text-sm text-basalt-destructive">
                      {error}
                    </p>
                  </LayerCard>
                )}
                {!compactMachine && page !== "settings" && syncCaption}
                {page === "overview" &&
                  !machineId &&
                  !!data?.pendingMachines?.length && (
                    <LayerCard>
                      <p className="text-sm text-basalt-muted-foreground">
                        等待首次上报：{data.pendingMachines.join("、")}
                      </p>
                    </LayerCard>
                  )}
                {boot ? (
                  <DashboardSkeleton />
                ) : page === "settings" ? (
                  <Settings onAuthError={expire} />
                ) : page === "connect" ? (
                  <Connect
                    live={machines}
                    onChange={() => void refresh()}
                    onOpen={(id) => navigate("overview", id)}
                    onAuthError={expire}
                  />
                ) : page === "history" ? (
                  <HistoryView machine={machineId} />
                ) : (
                  <Dashboard
                    key={machineId || "fleet"}
                    machines={shown}
                    now={now}
                    search={search}
                    onSearch={setSearch}
                    onMachine={
                      !machineId
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
          <SheetContent side="right" className="space-sheet">
            {detailMachine && detailSpace ? (
              <SpaceDetail
                key={`${detailMachine.id}:${detailSpace.id}`}
                machine={detailMachine}
                space={detailSpace}
                initialPane={selection?.pane}
                onAuthError={expire}
              />
            ) : (
              <>
                <SheetTitle>Space 已关闭</SheetTitle>
                <SheetDescription>
                  可在最近历史查看之前的任务与证据。
                </SheetDescription>
              </>
            )}
          </SheetContent>
        </Sheet>
      </AppShell>
    </SidebarProvider>
  );
}
