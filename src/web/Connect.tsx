import {
  Badge,
  Button,
  ConfirmDialog,
  Field,
  Input,
  LayerCard,
} from "@nocoo/basalt";
import {
  ArrowUpRight,
  Check,
  Copy,
  KeyRound,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type IssuedCredential,
  onboardingPrompt,
  type Registration,
} from "../shared/connect.ts";
import { type MachineView, WatchPortsSchema } from "../shared/schema.ts";
import { AuthError, api } from "./api.ts";
import { isStale } from "./Dashboard.tsx";
import { ingestOrigin } from "./environment.ts";
import { useTimezone } from "./Timezone.tsx";

export function Connect({
  live,
  onChange,
  onOpen,
  onAuthError,
}: {
  live: MachineView[];
  onChange: () => void;
  onOpen: (id: string) => void;
  onAuthError: () => void;
}) {
  const { time } = useTimezone();
  const [machines, setMachines] = useState<Registration[] | null>(null);
  const [canIssue, setCanIssue] = useState(false);
  const [name, setName] = useState("");
  const [id, setId] = useState("");
  const [ports, setPorts] = useState("");
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState<"prompt" | "token" | null>(null);
  const [confirm, setConfirm] = useState<{
    machine: Registration;
    action: "rotate" | "revoke";
  } | null>(null);
  const [editing, setEditing] = useState<Registration | null>(null);
  const [editName, setEditName] = useState("");
  const active = useRef(true);
  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) {
        setIssued(null);
        onAuthError();
      } else setError(e instanceof Error ? e.message : "操作失败，请重试");
    },
    [onAuthError],
  );
  const load = useCallback(async () => {
    try {
      const result = await api<{ machines: Registration[]; canIssue: boolean }>(
        "/api/v1/machines",
      );
      if (active.current) {
        setMachines(result.machines);
        setCanIssue(result.canIssue);
      }
    } catch (e) {
      if (active.current) fail(e);
    }
  }, [fail]);
  useEffect(() => {
    active.current = true;
    void load();
    return () => {
      active.current = false;
    };
  }, [load]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 2500);
    return () => clearTimeout(timer);
  }, [copied]);
  async function mutate(path: string, body: unknown) {
    setBusy(true);
    setError("");
    setCopied(null);
    try {
      const result = await api<{ machine: Registration; token?: string }>(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      if (!active.current) return;
      setMachines((previous) =>
        [
          ...(previous ?? []).filter((m) => m.id !== result.machine.id),
          result.machine,
        ].sort((a, b) => a.id.localeCompare(b.id)),
      );
      if (result.token)
        setIssued({ machine: result.machine, token: result.token });
      else if (issued?.machine.id === result.machine.id) setIssued(null);
      setConfirm(null);
      setEditing(null);
      onChange();
    } catch (e) {
      if (active.current) fail(e);
    } finally {
      if (active.current) setBusy(false);
    }
  }
  async function copy(value: string, target: "prompt" | "token") {
    try {
      await navigator.clipboard.writeText(value);
      if (active.current) setCopied(target);
    } catch {
      setCopied(null);
      setError("剪贴板不可用，请允许此网站访问剪贴板后重试。");
    }
  }
  const url = ingestOrigin;
  return (
    <div className="connect-page eagle-enter">
      <div className="connect-steps">
        {[
          [Plus, "01", "添加机器", "设置名称与唯一 ID"],
          [KeyRound, "02", "生成凭证", "独立授权，随时撤销"],
          [Terminal, "03", "粘贴提示词", "交给机器上的管理 Agent"],
        ].map(([Icon, number, title, description]) => {
          const StepIcon = Icon as typeof Plus;
          return (
            <LayerCard key={String(number)} className="connect-step">
              <span className="panel-icon">
                <StepIcon size={18} />
              </span>
              <div>
                <span className="section-index">{String(number)}</span>
                <strong>{String(title)}</strong>
                <p>{String(description)}</p>
              </div>
            </LayerCard>
          );
        })}
      </div>
      {error && (
        <LayerCard>
          <p role="alert" className="text-sm text-basalt-destructive">
            {error}
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setError("");
              void load();
            }}
          >
            重试
          </Button>
        </LayerCard>
      )}
      <div className="connect-layout">
        <section className="space-y-4" aria-label="已管理机器">
          <div className="board-title">
            <div>
              <h2>机器与凭证</h2>
              <Badge variant="secondary">{machines?.length ?? "—"}</Badge>
            </div>
            <Button
              size="sm"
              variant="ghost"
              aria-label="刷新机器列表"
              onClick={() => void load()}
            >
              <RefreshCw size={14} />
            </Button>
          </div>
          {machines === null ? (
            <LayerCard>
              <LayerCard.Loading label="读取机器配置" />
            </LayerCard>
          ) : !machines.length ? (
            <LayerCard>
              <LayerCard.Empty
                icon={<Server size={28} />}
                title="连接你的第一台机器"
                description="生成专属提示词后，交给本机管理 Agent 完成接入；推荐 Hermes。"
              />
            </LayerCard>
          ) : (
            machines.map((machine) => {
              const state = live.find((m) => m.id === machine.id);
              const fresh = state && !isStale(state, new Date().toISOString());
              return (
                <LayerCard key={machine.id} className="connect-machine">
                  <div className="flex items-center gap-3">
                    <span className="machine-icon">
                      <Server size={18} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <h3 className="truncate font-semibold">{machine.name}</h3>
                      <p className="mono mt-1 text-xs text-basalt-muted-foreground">
                        {machine.id}
                      </p>
                    </div>
                    <Badge
                      variant={
                        !machine.enabled
                          ? "secondary"
                          : fresh
                            ? "success"
                            : "warning"
                      }
                      dot
                    >
                      {!machine.enabled
                        ? "已停用"
                        : fresh
                          ? "在线"
                          : state
                            ? "等待更新"
                            : "等待接入"}
                    </Badge>
                  </div>
                  <div className="connect-key-meta">
                    <KeyRound size={13} />
                    <span>
                      {machine.source === "legacy"
                        ? "已有安全配置凭证"
                        : "机器专属 Token"}
                    </span>
                    <span>
                      {machine.expiresAt
                        ? `有效至 ${time(machine.expiresAt, { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`
                        : "手工配置"}
                    </span>
                  </div>
                  {state && (
                    <p className="text-xs text-basalt-muted-foreground">
                      {state.report.spaces.length} Spaces · 最新上报{" "}
                      {time(state.lastSeen)}
                    </p>
                  )}
                  <div className="connect-machine-actions">
                    {state && machine.enabled && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onOpen(machine.id)}
                      >
                        查看机器
                        <ArrowUpRight size={13} />
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => {
                        setEditing(machine);
                        setEditName(machine.name);
                      }}
                    >
                      重命名
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy || !canIssue}
                      aria-label={`${machine.enabled ? "轮换 Token" : "重新启用"} ${machine.name}`}
                      onClick={() => setConfirm({ machine, action: "rotate" })}
                    >
                      {machine.enabled ? "轮换 Token" : "重新启用"}
                    </Button>
                    {machine.enabled && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        aria-label={`停用 ${machine.name}`}
                        onClick={() =>
                          setConfirm({ machine, action: "revoke" })
                        }
                      >
                        停用
                      </Button>
                    )}
                  </div>
                  {editing?.id === machine.id && (
                    <form
                      className="mt-4 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void mutate(`/api/v1/machines/${machine.id}/rename`, {
                          name: editName,
                        });
                      }}
                    >
                      <Input
                        className="min-w-0"
                        aria-label="新的机器名称"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        required
                        maxLength={120}
                      />
                      <Button
                        type="submit"
                        size="sm"
                        className="whitespace-nowrap"
                        disabled={busy}
                      >
                        保存
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="whitespace-nowrap"
                        onClick={() => setEditing(null)}
                      >
                        取消
                      </Button>
                    </form>
                  )}
                </LayerCard>
              );
            })
          )}
        </section>
        <div className="space-y-4">
          <LayerCard padding="lg">
            <h2 className="flex items-center gap-2 font-semibold">
              <Plus size={17} />
              添加机器
            </h2>
            <p className="mt-2 text-xs text-basalt-muted-foreground">
              每台机器一个身份，一份接入配置。
            </p>
            <form
              className="mt-6 space-y-4"
              onSubmit={(e) => {
                e.preventDefault();
                const parsed = WatchPortsSchema.safeParse(
                  ports.trim()
                    ? ports.split(/[,，\n]/).map((entry) => {
                        const split = entry.lastIndexOf(":");
                        return {
                          name: entry.slice(0, split).trim(),
                          port: Number(entry.slice(split + 1)),
                        };
                      })
                    : [],
                );
                if (!parsed.success) {
                  setError(
                    "关注端口请填写 名称:端口，多个用逗号分隔，端口不能重复。",
                  );
                  return;
                }
                void mutate("/api/v1/machines", {
                  id,
                  name,
                  watchPorts: parsed.data,
                });
              }}
            >
              <Field label="机器名称" htmlFor="connect-name">
                <Input
                  id="connect-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Studio Mac"
                  required
                  maxLength={120}
                />
              </Field>
              <Field
                label="机器 ID"
                htmlFor="connect-id"
                hint="小写字母、数字、连字符或下划线；创建后固定。"
              >
                <Input
                  id="connect-id"
                  value={id}
                  onChange={(e) => setId(e.target.value)}
                  placeholder="studio-mac"
                  pattern="[a-z0-9][a-z0-9_-]*"
                  required
                  maxLength={80}
                />
              </Field>
              <Field
                label="关注端口"
                htmlFor="connect-ports"
                hint="选填，例如 Raven:7024, API:8080"
              >
                <Input
                  id="connect-ports"
                  value={ports}
                  onChange={(e) => setPorts(e.target.value)}
                  placeholder="Raven:7024"
                />
              </Field>
              <Button
                type="submit"
                className="w-full"
                disabled={busy || !canIssue}
              >
                <KeyRound size={14} />
                {busy ? "正在生成…" : "创建并生成提示词"}
              </Button>
            </form>
            {machines !== null && !canIssue && (
              <p className="mt-3 text-xs text-basalt-destructive">
                尚未配置签名密钥，暂时无法生成 Token。
              </p>
            )}
          </LayerCard>
          <LayerCard className="connect-security">
            <ShieldCheck size={18} />
            <div>
              <strong>凭证只在本次生成后可复制</strong>
              <p>
                平台只保存机器配置与凭证版本。关闭后无法找回
                Token，可随时轮换生成新的接入提示词。
              </p>
            </div>
          </LayerCard>
        </div>
      </div>
      {issued && (
        <LayerCard padding="lg" className="connect-prompt">
          <div className="flex items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 font-semibold">
              <Terminal size={18} />
              接入提示词
            </h2>
            <Button
              size="icon"
              variant="ghost"
              aria-label="关闭提示词"
              onClick={() => setIssued(null)}
            >
              <X size={16} />
            </Button>
          </div>
          <p className="mt-2 text-sm text-basalt-muted-foreground">
            {issued.machine.name} · 复制后交给该机器的管理 Agent。预览已隐藏
            Token，复制内容包含凭证。
          </p>
          <section aria-label="提示词预览" className="prompt-preview">
            {onboardingPrompt(
              issued.machine,
              "<Token 仅在复制时填入>",
              url,
              issued.machine.watchPorts ?? [],
            )}
          </section>
          <div className="flex flex-wrap items-center gap-3">
            <Button
              className="shrink-0 whitespace-nowrap"
              onClick={() =>
                void copy(
                  onboardingPrompt(
                    issued.machine,
                    issued.token,
                    url,
                    issued.machine.watchPorts ?? [],
                  ),
                  "prompt",
                )
              }
            >
              {copied === "prompt" ? <Check size={15} /> : <Copy size={15} />}
              <span className="w-[7em]">
                {copied === "prompt" ? "已复制提示词" : "复制完整提示词"}
              </span>
            </Button>
            <Button
              variant="outline"
              className="shrink-0 whitespace-nowrap"
              onClick={() => void copy(issued.token, "token")}
            >
              {copied === "token" ? <Check size={15} /> : <Copy size={15} />}
              {copied === "token" ? "已复制 Token" : "仅复制 Token"}
            </Button>
            {copied && (
              <span role="status" className="sr-only">
                {copied === "prompt" ? "提示词已复制" : "Token 已复制"}
                ，请安全保存
              </span>
            )}
          </div>
        </LayerCard>
      )}
      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        loading={busy}
        title={
          confirm?.action === "revoke" ? "停用这台机器？" : "生成新的机器凭证？"
        }
        description={
          <>
            {confirm?.machine.name}：
            {confirm?.action === "revoke"
              ? "立即停止接受该机器上报，当前状态保留。重新启用时需要新 Token。"
              : "旧 Token 将立即失效。请将新的接入提示词交给该机器更新配置。"}
            {error && <p role="alert">{error}</p>}
          </>
        }
        confirmLabel={confirm?.action === "revoke" ? "确认停用" : "确认生成"}
        cancelLabel="取消"
        variant={confirm?.action === "revoke" ? "destructive" : "default"}
        onConfirm={() => {
          if (confirm) {
            return mutate(
              `/api/v1/machines/${confirm.machine.id}/${confirm.action}`,
              {},
            );
          }
        }}
      />
    </div>
  );
}
