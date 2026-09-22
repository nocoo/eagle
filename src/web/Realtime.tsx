import {
  Badge,
  Button,
  Input,
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
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  type LiveFrame,
  type LiveInput,
  LiveServerMessageSchema,
  type LiveTopology,
} from "../shared/realtime.ts";
import { RealtimeActivity } from "./RealtimeActivity.tsx";
import { TerminalOutput } from "./TerminalOutput.tsx";
import { TERMINAL_THEMES, useTerminalTheme } from "./TerminalTheme.ts";
import { useTimezone } from "./Timezone.tsx";

export function Realtime({
  machineId,
  spaceId,
  initialPane = "",
  selectedPane,
  onPaneChange,
  onObservedAt,
}: {
  machineId: string;
  spaceId: string;
  initialPane?: string;
  selectedPane?: string;
  onPaneChange?: (paneId: string) => void;
  onObservedAt?: (observedAt: string) => void;
}) {
  const { time, zone } = useTimezone();
  const appearance = useTerminalTheme();
  const socket = useRef<WebSocket | null>(null);
  const sequence = useRef(0);
  const pending = useRef<{ seq: number; at: number } | null>(null);
  const initialControlRequested = useRef(false);
  const [connection, setConnection] = useState("正在连接");
  const [online, setOnline] = useState(false);
  const [control, setControl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [topology, setTopology] = useState<LiveTopology | null>(null);
  const [frames, setFrames] = useState<Record<string, LiveFrame>>({});
  const [localSelected, setLocalSelected] = useState(initialPane);
  const selected = selectedPane ?? localSelected;
  const setSelected = (id: string) => {
    setLocalSelected(id);
    onPaneChange?.(id);
  };
  const [draft, setDraft] = useState({ target: "", text: "" });
  const [authority, setAuthority] = useState("");
  const [receipt, setReceipt] = useState("");
  const [attempt, setAttempt] = useState(0);
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
        setReceipt("连接中断，输入结果未知；不会自动重发");
        pending.current = null;
      }
      setOnline(false);
      setControl(false);
      setAuthority("");
      setDraft({ target: "", text: "" });
      setBusy(false);
      setTopology(null);
      setFrames({});
      current = null;
    };
    const connect = () => {
      if (disposed || document.hidden || socket.current) return;
      disconnect();
      setConnection("正在连接");
      const url = new URL("/api/v1/realtime", location.origin);
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
          setControl(m.control);
          setConnection(m.online ? "实时连接" : "等待本机实时服务");
        }
        if (m.type === "topology" && m.spaceId === spaceId) {
          current = m;
          setTopology(m);
          setFrames((old) =>
            Object.fromEntries(
              Object.entries(old).filter(
                ([id, f]) =>
                  f.subscriptionId === m.subscriptionId &&
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
                : "输入未发送，请检查控制权和 Pane",
          );
        }
      };
      ws.onerror = () => setConnection("连接失败，请检查登录和本机实时服务");
      ws.onclose = (e) => {
        if (disposed || socket.current !== ws) return;
        disconnect();
        setConnection(
          e.code === 4001
            ? "连接授权已过期，请重新连接"
            : e.code === 4008
              ? "实时消息异常，请重新连接"
              : "连接已断开",
        );
        if (![1008, 4001, 4004, 4008].includes(e.code) && !document.hidden) {
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
  }, [machineId, spaceId, attempt, onObservedAt]);
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
  const text = draft.target === targetIdentity ? draft.text : "";
  const previousTarget = useRef("");
  useEffect(() => {
    if (previousTarget.current && previousTarget.current !== targetIdentity) {
      setDraft({ target: "", text: "" });
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
      !targetIdentity ||
      ws?.readyState !== WebSocket.OPEN
    )
      return;
    // Request once per opened view; only the server can grant the lease.
    // Rejection, release, target replacement and reconnect never retry it.
    initialControlRequested.current = true;
    setAuthority(targetIdentity);
    ws.send(JSON.stringify({ type: "control" }));
  }, [online, targetIdentity]);
  const send = (keys: LiveInput["keys"], value = "") => {
    const ws = socket.current;
    if (
      !pane ||
      !online ||
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
    if (value) setDraft({ target: "", text: "" });
  };
  const disabled =
    !online || !control || authority !== targetIdentity || busy || !pane;
  return (
    <section
      aria-label="Space 实时终端"
      className="live-space"
      data-terminal-theme={appearance.resolved}
    >
      <div className="live-toolbar">
        <div className="live-connection">
          <Radio size={15} aria-hidden="true" />
          <Badge variant={online ? "success" : "warning"} dot>
            {connection}
          </Badge>
        </div>
        <div className="live-actions">
          <Select value={appearance.theme} onValueChange={appearance.select}>
            <SelectTrigger aria-label="终端配色" className="live-theme-select">
              <Palette size={14} aria-hidden="true" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(TERMINAL_THEMES).map(([value, label]) => (
                <SelectItem key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant={control ? "default" : "secondary"}
            disabled={!online || !pane}
            onClick={() => {
              initialControlRequested.current = true;
              setAuthority(control ? "" : targetIdentity);
              socket.current?.send(
                JSON.stringify({ type: control ? "release" : "control" }),
              );
            }}
          >
            {control ? <Keyboard size={14} /> : <Eye size={14} />}
            {control ? "释放输入" : "接管输入"}
          </Button>
          <Button
            size="icon"
            variant="outline"
            aria-label="重新连接"
            onClick={() => setAttempt((n) => n + 1)}
          >
            <RefreshCw size={14} />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="icon" variant="outline" aria-label="实时输入说明">
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
      <div className="live-navigation">
        <Select
          value={tab?.id ?? ""}
          onValueChange={(id) =>
            setSelected(
              topology?.tabs.find((t) => t.id === id)?.panes[0]?.id ?? "",
            )
          }
        >
          <SelectTrigger aria-label="实时标签页">
            <SelectValue placeholder="等待标签页" />
          </SelectTrigger>
          <SelectContent>
            {topology?.tabs.map((t) => (
              <SelectItem key={t.id} value={t.id} disabled={!t.panes.length}>
                {t.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <ChevronRight size={13} aria-hidden="true" />
        <Select value={pane?.id ?? ""} onValueChange={setSelected}>
          <SelectTrigger aria-label="当前终端">
            <SelectValue placeholder="等待终端" />
          </SelectTrigger>
          <SelectContent>
            {tab?.panes.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.title} · {p.id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="live-pane-count mono">
          {tab?.panes.length ?? 0} PANES
        </span>
      </div>
      <div className="live-stage">
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
        <div className="live-composer-meta">
          <RealtimeActivity
            frame={pane ? frames[pane.id] : undefined}
            online={online}
            connection={connection}
          />
          <label htmlFor="live-input">
            <span className="live-target-name" title={pane?.title}>
              {pane ? `发送到 ${pane.title}` : "等待终端"}
            </span>
            <span className="mono" title={pane?.id}>
              {pane?.id}
            </span>
          </label>
          <span className="live-control-mode">
            {control ? "你正在控制" : "观看模式"}
          </span>
        </div>
        <div className="live-input-row">
          <span className="live-prompt mono" aria-hidden="true">
            ❯
          </span>
          <Input
            id="live-input"
            aria-label="发送到当前 Pane"
            value={text}
            onChange={(e) =>
              setDraft({ target: targetIdentity, text: e.target.value })
            }
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
            disabled={disabled}
            placeholder={
              control ? "输入指令，Enter 发送" : "接管输入后发送指令"
            }
          />
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
        <fieldset className="live-shortcuts" aria-label="终端快捷键">
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
              ["ctrl+c", "Ctrl+C"],
              ["ctrl+d", "Ctrl+D"],
              ["ctrl+l", "Ctrl+L"],
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
        </fieldset>
        <p role="status" className="live-receipt">
          {busy
            ? "等待提交结果…"
            : receipt || "输入仅发送一次 · 以终端执行结果为准"}
        </p>
      </form>
    </section>
  );
}
