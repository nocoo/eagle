import {
  Button,
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nocoo/basalt";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@nocoo/basalt/components/select";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  CornerDownLeft,
  Eye,
  Keyboard,
  Palette,
  Radio,
  RefreshCw,
  ShieldAlert,
  TerminalSquare,
} from "@nocoo/basalt/icons";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  type LiveFrame,
  type LiveInput,
  LiveServerMessageSchema,
  type LiveTopology,
} from "../../../../packages/contracts/src/realtime.ts";
import { apiPath, environment } from "./environment.ts";
import { useInputDraft } from "./InputDraft.ts";
import { RealtimeActivity } from "./RealtimeActivity.tsx";
import { TerminalOutput, type TerminalPosition } from "./TerminalOutput.tsx";
import { TERMINAL_THEMES, useTerminalTheme } from "./TerminalTheme.ts";
import { useTimezone } from "./Timezone.tsx";

// Owned by the open workspace, never browser storage. At most one frame per
// topology pane (32), each bounded by the validated realtime message schema.
export function createRealtimeView() {
  return {
    topology: null as LiveTopology | null,
    frames: {} as Record<string, LiveFrame>,
    positions: {} as Record<string, TerminalPosition>,
    controlRequested: false,
    receipt: "",
  };
}

export function Realtime({
  machineId,
  spaceId,
  initialPane = "",
  selectedPane,
  onPaneChange,
  onObservedAt,
  statusTarget,
  view,
}: {
  view: { current: ReturnType<typeof createRealtimeView> };
  statusTarget: HTMLElement | null;
  machineId: string;
  spaceId: string;
  initialPane?: string;
  selectedPane?: string;
  onPaneChange?: (paneId: string) => void;
  onObservedAt?: (observedAt: string) => void;
}) {
  const { time, zone } = useTimezone();
  const appearance = useTerminalTheme();
  const positions = view.current.positions;
  const socket = useRef<WebSocket | null>(null);
  const sequence = useRef(0);
  const pending = useRef<{ seq: number; at: number } | null>(null);
  const initialControlRequested = useRef(view.current.controlRequested);
  const [connection, setConnection] = useState("正在连接");
  const [online, setOnline] = useState(false);
  const [ready, setReady] = useState(false);
  const [retrying, setRetrying] = useState(true);
  const [control, setControl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [topology, setTopology] = useState(view.current.topology);
  const [frames, setFrames] = useState(view.current.frames);
  const [localSelected, setLocalSelected] = useState(initialPane);
  const selected = selectedPane ?? localSelected;
  const setSelected = (id: string) => {
    setLocalSelected(id);
    onPaneChange?.(id);
  };
  const [authority, setAuthority] = useState("");
  const [receipt, setReceipt] = useState(view.current.receipt);
  const [attempt, setAttempt] = useState(0);
  useLayoutEffect(() => {
    view.current.topology = topology;
    view.current.frames = frames;
    view.current.receipt = receipt;
  }, [view, topology, frames, receipt]);
  useEffect(() => {
    let disposed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let backoff = 1000;
    let current: LiveTopology | null = null;
    const disconnect = () => {
      clearTimeout(retry);
      clearInterval(heartbeat);
      const ws = socket.current;
      socket.current = null;
      if (ws) {
        ws.onopen = null;
        ws.onclose = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.close(1000, "View left");
      }
      if (pending.current) {
        view.current.receipt = "连接中断，输入结果未知；不会自动重发";
        setReceipt(view.current.receipt);
        pending.current = null;
      }
      setOnline(false);
      setReady(false);
      setControl(false);
      setAuthority("");
      setBusy(false);
      current = null;
    };
    const connect = () => {
      if (disposed || document.hidden || socket.current) return;
      disconnect();
      setConnection("正在连接");
      setRetrying(true);
      const url = new URL(apiPath("/api/v1/realtime"), location.origin);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      url.searchParams.set("machine", machineId);
      url.searchParams.set("space", spaceId);
      url.searchParams.set("format", "styled-text-v1");
      const ws = new WebSocket(url);
      socket.current = ws;
      let last = Date.now();
      ws.onopen = () => {
        if (!disposed && socket.current === ws)
          ws.send(JSON.stringify({ type: "ping" }));
      };
      ws.onmessage = (e) => {
        if (disposed || socket.current !== ws) return;
        last = Date.now();
        backoff = 1000;
        let raw: unknown;
        try {
          raw = JSON.parse(e.data);
        } catch {
          ws.close(4008, "Invalid realtime message");
          return;
        }
        const parsed = LiveServerMessageSchema.safeParse(raw);
        if (!parsed.success) {
          ws.close(4008, "Invalid realtime message");
          return;
        }
        const m = parsed.data;
        if (m.type === "status") {
          setOnline(m.online);
          setControl(m.online && m.control);
          if (!m.online) setAuthority("");
          setConnection(m.online ? "实时连接" : "等待本机实时服务");
        }
        if (m.type === "topology" && m.spaceId === spaceId) {
          current = m;
          const identities = new Set(
            m.tabs.flatMap((t) =>
              t.panes.map((p) => `${p.id}/${p.terminalId}`),
            ),
          );
          view.current.positions = Object.fromEntries(
            Object.entries(view.current.positions).filter(([id]) =>
              identities.has(id),
            ),
          );
          setTopology(m);
          setReady(true);
          setFrames((old) =>
            Object.fromEntries(
              Object.entries(old).filter(([id, f]) =>
                m.tabs.some((t) =>
                  t.panes.some(
                    (p) => p.id === id && p.terminalId === f.terminalId,
                  ),
                ),
              ),
            ),
          );
        }
        if (
          m.type === "frame" &&
          m.spaceId === spaceId &&
          m.subscriptionId === current?.subscriptionId &&
          current.tabs.some((t) =>
            t.panes.some(
              (p) => p.id === m.paneId && p.terminalId === m.terminalId,
            ),
          )
        ) {
          onObservedAt?.(m.observedAt);
          setFrames((old) =>
            old[m.paneId]?.subscriptionId === m.subscriptionId &&
            old[m.paneId]?.revision > m.revision
              ? old
              : { ...old, [m.paneId]: m },
          );
          if (m.deliveryId)
            ws.send(
              JSON.stringify({
                type: "rendered",
                deliveryId: m.deliveryId,
                deliveryBytes: m.deliveryBytes,
              }),
            );
        }
        if (m.type === "ack" && pending.current?.seq === m.seq) {
          pending.current = null;
          setBusy(false);
          setReceipt(
            m.status === "submitted"
              ? "已提交输入；请查看终端执行结果"
              : m.status === "unknown"
                ? "输入结果未知；不会自动重发"
                : "输入未发送，请检查控制权、Pane 或终端键盘模式",
          );
        }
      };
      ws.onerror = () => setConnection("连接失败，请检查登录和本机实时服务");
      ws.onclose = (e) => {
        if (disposed || socket.current !== ws) return;
        disconnect();
        const canRetry = ![1008, 4001, 4004, 4008].includes(e.code);
        setRetrying(canRetry && !document.hidden);
        if (!canRetry) {
          view.current = { ...createRealtimeView(), controlRequested: true };
          initialControlRequested.current = true;
          setTopology(null);
          setFrames({});
        }
        setConnection(
          e.code === 4001
            ? "连接授权已过期，请重新连接"
            : e.code === 4008
              ? "实时消息异常，请重新连接"
              : canRetry
                ? "连接已断开，正在重试…"
                : "连接不可用，请重新连接",
        );
        if (canRetry && !document.hidden) {
          retry = setTimeout(connect, backoff);
          backoff = Math.min(backoff * 2, 15000);
        }
      };
      heartbeat = setInterval(() => {
        if (socket.current !== ws) return;
        if (
          Date.now() - last > 30000 ||
          (pending.current && Date.now() - pending.current.at > 10000)
        ) {
          ws.close(4000, "Response timeout");
          return;
        }
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: "ping" }));
      }, 5000);
    };
    const visibility = () => {
      if (document.hidden) {
        disconnect();
        setRetrying(false);
        setConnection("页面在后台，实时连接已暂停");
      } else connect();
    };
    const leave = () => disconnect();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", leave);
    window.addEventListener("pageshow", visibility);
    connect();
    return () => {
      disposed = true;
      disconnect();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", leave);
      window.removeEventListener("pageshow", visibility);
    };
  }, [machineId, spaceId, attempt, onObservedAt, view]);
  const panes = topology?.tabs.flatMap((t) => t.panes) ?? [];
  const pane =
    panes.find((p) => p.id === selected) ?? (!selected ? panes[0] : undefined);
  useEffect(() => {
    if (pane) onPaneChange?.(pane.id);
  }, [pane?.id, onPaneChange]);
  const tab = topology?.tabs.find((t) =>
    t.panes.some((p) => p.id === pane?.id),
  );
  const targetIdentity = pane ? `${pane.id}/${pane.terminalId}` : "";
  const draft = useInputDraft(
    pane
      ? `eagle-input-draft:${JSON.stringify([environment, machineId, spaceId, pane.id, pane.terminalId])}`
      : "",
  );
  const { text } = draft;
  const previousTarget = useRef("");
  useEffect(() => {
    if (previousTarget.current && previousTarget.current !== targetIdentity) {
      setAuthority("");
      setControl(false);
      if (socket.current?.readyState === WebSocket.OPEN)
        socket.current.send(JSON.stringify({ type: "release" }));
      if (targetIdentity) setReceipt("目标已变化，请重新选择 Pane 并接管输入");
    }
    previousTarget.current = targetIdentity;
  }, [targetIdentity]);
  useEffect(() => {
    const ws = socket.current;
    if (
      initialControlRequested.current ||
      !online ||
      !ready ||
      !targetIdentity ||
      ws?.readyState !== WebSocket.OPEN
    )
      return;
    // Request once per opened view; only the server can grant the lease.
    // Rejection, release, target replacement and reconnect never retry it.
    initialControlRequested.current = true;
    view.current.controlRequested = true;
    setAuthority(targetIdentity);
    ws.send(JSON.stringify({ type: "control" }));
  }, [online, ready, targetIdentity, view]);
  const send = (keys: LiveInput["keys"], value = "") => {
    const ws = socket.current;
    if (
      !pane ||
      !online ||
      !ready ||
      !control ||
      authority !== targetIdentity ||
      pending.current ||
      ws?.readyState !== WebSocket.OPEN
    )
      return;
    const seq = ++sequence.current;
    pending.current = { seq, at: Date.now() };
    setBusy(true);
    ws.send(
      JSON.stringify({
        type: "input",
        seq,
        paneId: pane.id,
        terminalId: pane.terminalId,
        text: value,
        keys,
      }),
    );
    if (value) draft.update("");
  };
  const targetDescription = `${pane ? `发送到 ${pane.title} · ${pane.id}` : "等待终端"} · ${control ? "你正在控制" : "观看模式"}`;
  const disabled =
    !online ||
    !ready ||
    !control ||
    authority !== targetIdentity ||
    busy ||
    !pane;
  return (
    <section
      aria-label="Space 实时终端"
      className="live-space"
      data-terminal-theme={appearance.resolved}
    >
      {statusTarget &&
        createPortal(
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="live-connection"
                  data-online={online}
                  aria-label={`实时连接：${connection}`}
                >
                  <Radio size={14} aria-hidden="true" />
                  <span className="live-connection-text">{connection}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{connection}</TooltipContent>
            </Tooltip>
            <span className="live-pane-count mono" title="当前标签页的终端数量">
              {tab?.panes.length ?? 0} PANES
            </span>
          </>,
          statusTarget,
        )}
      <div className="live-toolbar">
        <div className="live-navigation">
          <Select
            value={tab?.id ?? ""}
            onValueChange={(id) =>
              setSelected(
                topology?.tabs.find((t) => t.id === id)?.panes[0]?.id ?? "",
              )
            }
          >
            <SelectTrigger size="sm" aria-label="实时标签页">
              <SelectValue placeholder="等待标签页" />
            </SelectTrigger>
            <SelectContent className="live-select-content" collisionPadding={8}>
              {topology?.tabs.map((t) => (
                <SelectItem key={t.id} value={t.id} disabled={!t.panes.length}>
                  {t.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ChevronRight size={13} aria-hidden="true" />
          <Select value={pane?.id ?? ""} onValueChange={setSelected}>
            <SelectTrigger size="sm" aria-label="当前终端">
              <SelectValue placeholder="等待终端" />
            </SelectTrigger>
            <SelectContent className="live-select-content" collisionPadding={8}>
              {tab?.panes.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.title} · {p.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="live-actions">
          <Select value={appearance.theme} onValueChange={appearance.select}>
            <SelectTrigger
              size="sm"
              aria-label="终端配色"
              className="live-theme-select"
            >
              <Palette size={14} aria-hidden="true" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="live-select-content" collisionPadding={8}>
              {Object.entries(TERMINAL_THEMES).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            aria-label="重新连接"
            onClick={() => setAttempt((n) => n + 1)}
          >
            <RefreshCw size={14} />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" aria-label="实时输入说明">
                <ShieldAlert size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent className="max-w-72">
              同一 Space
              仅一个网页可输入。发送时会短暂附着终端，可能调整尺寸或恢复暂停的任务。切换或关闭视图会释放连接。
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
      {!appearance.persisted && (
        <p className="live-theme-warning" role="status">
          配色仅在本次打开时有效
        </p>
      )}
      <div className="live-stage">
        {(!online || !ready) && (
          <div className="live-reconnecting" role="status">
            <RefreshCw
              size={16}
              className={retrying ? "eagle-spin" : undefined}
              aria-hidden="true"
            />
            <span>
              {connection}
              {tab ? " · 保留上次画面，可继续编辑草稿" : ""}
            </span>
          </div>
        )}
        {tab ? (
          <section className="live-panes" aria-label={tab.name}>
            {tab.panes.map((p) => (
              <div
                key={`${p.id}/${p.terminalId}`}
                className="live-pane"
                data-selected={pane?.id === p.id}
                style={{
                  gridColumn: `${Math.round(p.rect.x * 12) + 1} / span ${Math.max(1, Math.round(p.rect.width * 12))}`,
                  gridRow: `${Math.round(p.rect.y * 12) + 1} / span ${Math.max(1, Math.round(p.rect.height * 12))}`,
                }}
              >
                <Button
                  size="sm"
                  variant="secondary"
                  className="live-pane-heading"
                  aria-label={`${p.title} · ${p.id}`}
                  onClick={() => setSelected(p.id)}
                  aria-pressed={pane?.id === p.id}
                >
                  <TerminalSquare size={13} />
                  <span>{p.title}</span>
                  <span className="mono">{p.id}</span>
                </Button>
                <TerminalOutput
                  frame={frames[p.id]}
                  selected={pane?.id === p.id}
                  position={positions[`${p.id}/${p.terminalId}`]}
                  onPosition={(position) => {
                    positions[`${p.id}/${p.terminalId}`] = position;
                  }}
                />
                <div className="live-pane-footer mono">
                  <span>{pane?.id === p.id ? "当前目标" : "只读画面"}</span>
                  <span>
                    {frames[p.id]
                      ? `${time(frames[p.id].observedAt, { hour: "2-digit", minute: "2-digit", second: "2-digit" })} ${zone}`
                      : "等待同步"}
                  </span>
                </div>
              </div>
            ))}
          </section>
        ) : (
          <div className="live-empty">
            <TerminalSquare size={32} />
            <p>
              {online && topology && selected && !pane
                ? "所选终端不在当前实时布局中，请重新选择。"
                : online
                  ? "等待 Herdr 终端画面…"
                  : "等待本机实时服务"}
            </p>
            <span>连接建立后，终端会显示在这里。</span>
          </div>
        )}
      </div>
      <form
        className="live-composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (text) send(["enter"], text);
        }}
      >
        <span id="live-input-target" className="sr-only">
          {targetDescription}
        </span>
        <div className="live-input-row">
          <div className="live-input-field">
            <RealtimeActivity
              frame={pane ? frames[pane.id] : undefined}
              online={online}
              connection={connection}
              targetDescription={targetDescription}
            />
            <Input
              id="live-input"
              aria-label="发送到当前 Pane"
              aria-describedby="live-input-target"
              value={text}
              onChange={(e) => draft.update(e.target.value)}
              onKeyDown={(e) => {
                if (
                  e.key === "Enter" &&
                  (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229)
                )
                  e.preventDefault();
              }}
              autoComplete="off"
              spellCheck={false}
              maxLength={8000}
              disabled={!pane}
              placeholder={
                !online || !ready
                  ? "连接恢复前可继续编辑草稿"
                  : control
                    ? `发送到 ${pane?.title ?? "当前终端"} · Enter 发送`
                    : "可先编辑草稿，接管输入后发送"
              }
            />
            <span className="live-control-mode">
              {control ? "你正在控制" : "观看模式"}
            </span>
          </div>
          <Button
            type="button"
            size="sm"
            variant={control ? "outline" : "secondary"}
            className="live-control-toggle"
            aria-label={control ? "释放输入" : "接管输入"}
            title={control ? "释放输入" : "接管输入"}
            disabled={!online || !ready || !pane}
            onClick={() => {
              initialControlRequested.current = true;
              view.current.controlRequested = true;
              setAuthority(control ? "" : targetIdentity);
              socket.current?.send(
                JSON.stringify({ type: control ? "release" : "control" }),
              );
            }}
          >
            {control ? <Keyboard size={14} /> : <Eye size={14} />}
            <span className="live-control-label">
              {control ? "释放输入" : "接管输入"}
            </span>
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={disabled || !text}
            aria-label="发送并回车"
          >
            <ArrowUp size={16} />
            <span>发送</span>
          </Button>
        </div>
        <div className="live-composer-footer">
          <fieldset className="live-shortcuts" aria-label="终端快捷键">
            {(
              [
                ["ctrl+c", "Ctrl+C"],
                ["ctrl+d", "Ctrl+D"],
                ["up", "上一条历史"],
                ["down", "下一条历史"],
              ] as const
            ).map(([key, label]) => (
              <Button
                type="button"
                key={key}
                size="sm"
                variant="outline"
                disabled={disabled}
                aria-label={label}
                title={label}
                onClick={() => send([key])}
              >
                {key === "up" ? (
                  <ArrowUp size={15} />
                ) : key === "down" ? (
                  <ArrowDown size={15} />
                ) : (
                  label
                )}
              </Button>
            ))}
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label="更多快捷键"
                >
                  更多
                </Button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                align="start"
                collisionPadding={8}
                className="live-extra-keys"
                aria-label="更多终端快捷键"
              >
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={disabled || !text}
                  onClick={() => send([], text)}
                >
                  仅发送文字
                </Button>
                {(
                  [
                    ["enter", "Enter"],
                    ["ctrl+l", "Ctrl+L"],
                    ["ctrl+p", "Ctrl+P"],
                    ["ctrl+n", "Ctrl+N"],
                    ["esc", "Esc"],
                    ["tab", "Tab"],
                    ["shift+tab", "Shift+Tab"],
                    ["backspace", "⌫"],
                  ] as const
                ).map(([key, label]) => (
                  <Button
                    type="button"
                    key={key}
                    size="sm"
                    variant="outline"
                    disabled={disabled}
                    onClick={() => send([key])}
                  >
                    {key === "enter" && <CornerDownLeft size={12} />}
                    {label}
                  </Button>
                ))}
                <p className="live-key-help">
                  上下方向键需增强键盘模式；普通命令行可尝试 Ctrl+P /
                  Ctrl+N，具体行为由终端应用决定。
                </p>
              </PopoverContent>
            </Popover>
          </fieldset>
          <p
            role="status"
            className="live-receipt"
            data-idle={!busy && !receipt}
          >
            {busy
              ? "等待提交结果…"
              : receipt || "输入仅发送一次 · 以终端执行结果为准"}
          </p>
        </div>
      </form>
      {draft.warning && (
        <p className="live-theme-warning" role="status">
          {draft.warning}
        </p>
      )}
    </section>
  );
}
