import { Badge, Button, Input, Label, LayerCard, Switch } from "@nocoo/basalt";
import { SectionRule } from "@nocoo/basalt/components/section-rule";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@nocoo/basalt/components/select";
import { SkeletonLine } from "@nocoo/basalt/components/skeleton-line";
import { BUILTIN_PROVIDERS } from "@nocoo/next-ai";
import {
  Check,
  Loader2,
  Plug,
  Save,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { useEffect, useState } from "react";
import { type DailySettings, TEMPLATE_VERSION } from "../shared/daily.ts";
import { AuthError, api } from "./api.ts";
import { TIMEZONE_OFFSETS, timezoneLabel, useTimezone } from "./Timezone.tsx";

type SettingsView = DailySettings & {
  hasApiKey: boolean;
  configured: boolean;
};
function Choice({
  id,
  label,
  value,
  values,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  values: [string, string][];
  onChange: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map(([value, title]) => (
            <SelectItem key={value} value={value}>
              {title}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
export function Settings({ onAuthError }: { onAuthError: () => void }) {
  const { offset, setOffset, persisted } = useTimezone();
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    api<SettingsView>("/api/v1/settings", { signal: controller.signal })
      .then(setSettings)
      .catch((e) => {
        if (!controller.signal.aborted) {
          if (e instanceof AuthError) onAuthError();
          else setError("设置读取失败，请刷新重试。");
        }
      });
    return () => controller.abort();
  }, [onAuthError]);
  const change = (value: Partial<DailySettings>) => {
    const changedEndpoint =
      (value.provider !== undefined && value.provider !== settings?.provider) ||
      (value.baseURL !== undefined && value.baseURL !== settings?.baseURL) ||
      (value.sdkType !== undefined && value.sdkType !== settings?.sdkType) ||
      (value.authType !== undefined && value.authType !== settings?.authType);
    if (changedEndpoint) {
      setApiKey("");
      setClearKey(false);
    }
    setSettings(
      (s) =>
        s && {
          ...s,
          ...value,
          ...(changedEndpoint ? { hasApiKey: false, configured: false } : {}),
        },
    );
    setSaved(false);
    setDirty(true);
    setNotice("");
  };
  const act = async (action: "save" | "test" | "run") => {
    if (!settings) return;
    setBusy(action);
    setError("");
    setNotice("");
    const { hasApiKey: _key, configured: _ready, ...input } = settings;
    // Responses may include read-only template metadata; send only the editable fields.
    const payload: DailySettings & { apiKey?: string | null } = {
      enabled: input.enabled,
      provider: input.provider,
      model: input.model,
      baseURL: input.baseURL,
      sdkType: input.sdkType,
      authType: input.authType,
      ...(clearKey
        ? { apiKey: null }
        : apiKey.trim()
          ? { apiKey: apiKey.trim() }
          : {}),
    };
    try {
      if (action === "save") {
        setSettings(
          await api<SettingsView>("/api/v1/settings", {
            method: "POST",
            body: JSON.stringify(payload),
            headers: { "Content-Type": "application/json" },
          }),
        );
        setSaved(true);
        setDirty(false);
        setApiKey("");
        setClearKey(false);
      } else if (action === "test") {
        const result = await api<{ success: boolean; error?: string }>(
          "/api/v1/settings/test",
          {
            method: "POST",
            body: JSON.stringify(payload),
            headers: { "Content-Type": "application/json" },
            signal: AbortSignal.timeout(30000),
          },
        );
        if (result.success) setNotice("AI 连接成功。");
        else setError(result.error ?? "连接失败。");
      } else {
        const result = await api<{
          skipped?: string;
          deferred?: boolean;
          results: { generated?: boolean; error?: string }[];
        }>("/api/v1/daily-reports/run", {
          method: "POST",
          body: "{}",
          headers: { "Content-Type": "application/json" },
          signal: AbortSignal.timeout(780000),
        });
        if (result.skipped)
          setNotice(
            result.skipped === "disabled"
              ? "自动报告已暂停。"
              : "未配置 AI，已跳过。",
          );
        else if (result.results.some((r) => r.error))
          setError("部分报告生成失败，可重试；成功报告已保存在历史中。");
        else if (result.deferred)
          setNotice(
            `已生成 ${result.results.filter((r) => r.generated).length} 份报告；剩余机器请再次手动生成。`,
          );
        else
          setNotice(
            `已生成 ${result.results.filter((r) => r.generated).length} 份日报，可在最近历史查看。`,
          );
      }
    } catch (e) {
      if (e instanceof AuthError) onAuthError();
      else setError(e instanceof Error ? e.message : "操作失败。");
    } finally {
      setBusy("");
    }
  };
  if (!settings)
    return (
      <LayerCard>
        {error ? (
          <p role="alert">{error}</p>
        ) : (
          <div role="status" aria-label="正在加载设置" className="space-y-4">
            <SkeletonLine />
            <SkeletonLine />
            <SkeletonLine />
          </div>
        )}
      </LayerCard>
    );
  const provider =
    BUILTIN_PROVIDERS[settings.provider as keyof typeof BUILTIN_PROVIDERS];
  return (
    <div className="settings-layout">
      <div className="space-y-5">
        <SectionRule title="显示偏好" hint="即刻生效，保存在当前浏览器。">
          <LayerCard className="space-y-3">
            <Choice
              id="display-timezone"
              label="显示时区"
              value={String(offset)}
              values={TIMEZONE_OFFSETS.map((value) => [
                String(value),
                timezoneLabel(value),
              ])}
              onChange={(value) => setOffset(Number(value))}
            />
            <p className="text-xs leading-relaxed text-basalt-muted-foreground">
              全站时间与小时筛选均使用此时区。默认 UTC+08:00；固定 UTC
              偏移，不随夏令时变化。
            </p>
            {!persisted && (
              <p
                role="status"
                className="text-xs text-basalt-warning-foreground"
              >
                浏览器不允许保存偏好，本次选择仅在当前页面生效。
              </p>
            )}
          </LayerCard>
        </SectionRule>
        <SectionRule title="AI 连接" hint="由 next-ai 提供统一的模型配置。">
          <LayerCard className="space-y-5">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-2 text-sm font-medium">
                <Sparkles size={16} /> 报告分析模型
              </span>
              <Badge variant={settings.configured ? "success" : "secondary"}>
                {settings.configured ? "已配置" : "待配置"}
              </Badge>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Choice
                id="ai-provider"
                label="提供商"
                value={settings.provider || "none"}
                values={[
                  ["none", "暂不配置"],
                  ...Object.values(BUILTIN_PROVIDERS).map(
                    (p): [string, string] => [p.id, p.label],
                  ),
                  ["custom", "自定义兼容服务"],
                ]}
                onChange={(value) => {
                  const next =
                    BUILTIN_PROVIDERS[value as keyof typeof BUILTIN_PROVIDERS];
                  change({
                    provider: value === "none" ? "" : value,
                    model: next?.defaultModel ?? "",
                    baseURL: next?.baseURL ?? "",
                    sdkType: next?.sdkType ?? "openai",
                  });
                }}
              />
              <div className="space-y-2">
                <Label htmlFor="ai-model">模型</Label>
                <Input
                  id="ai-model"
                  value={settings.model}
                  onChange={(e) => change({ model: e.target.value })}
                  placeholder={provider?.defaultModel ?? "输入模型 ID"}
                />
              </div>
            </div>
            {settings.provider === "custom" && (
              <>
                <div className="space-y-2">
                  <Label htmlFor="ai-endpoint">API 地址</Label>
                  <Input
                    id="ai-endpoint"
                    type="url"
                    value={settings.baseURL}
                    onChange={(e) => change({ baseURL: e.target.value })}
                    placeholder="https://api.example.com/v1"
                  />
                </div>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Choice
                    id="ai-protocol"
                    label="接口协议"
                    value={settings.sdkType}
                    values={[
                      ["openai", "OpenAI Chat Completions"],
                      ["anthropic", "Anthropic Messages"],
                    ]}
                    onChange={(sdkType) =>
                      change({ sdkType: sdkType as DailySettings["sdkType"] })
                    }
                  />
                  <Choice
                    id="ai-auth"
                    label="认证方式"
                    value={settings.authType}
                    values={[
                      ["apiKey", "API Key"],
                      ["bearer", "Bearer Token"],
                    ]}
                    onChange={(authType) =>
                      change({
                        authType: authType as DailySettings["authType"],
                      })
                    }
                  />
                </div>
              </>
            )}
            <div className="space-y-2">
              <Label htmlFor="ai-key">API Key</Label>
              <Input
                id="ai-key"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                disabled={!!busy}
                value={apiKey}
                placeholder={
                  settings.hasApiKey && !clearKey
                    ? "已配置，留空保留当前密钥"
                    : "输入服务商密钥"
                }
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setClearKey(false);
                  change({});
                }}
              />
              {settings.hasApiKey && (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!!busy || clearKey}
                  onClick={() => {
                    setApiKey("");
                    setClearKey(true);
                    change({});
                  }}
                >
                  {clearKey ? "保存后清除" : "清除密钥"}
                </Button>
              )}
            </div>
            <div className="rounded-lg bg-basalt-muted/50 p-3 text-xs text-basalt-muted-foreground space-y-2">
              <p className="flex items-center gap-2">
                <ShieldCheck size={14} /> 密钥状态：
                {clearKey
                  ? "待清除"
                  : apiKey
                    ? "待保存"
                    : settings.hasApiKey
                      ? "已配置"
                      : "未配置"}
              </p>
              <p>
                密钥加密保存，保存后不回显。留空保留当前密钥，切换服务商、地址或认证协议需重新填写。
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={
                !!busy ||
                !settings.provider ||
                clearKey ||
                (!apiKey.trim() && !settings.hasApiKey)
              }
              onClick={() => void act("test")}
            >
              {busy === "test" ? (
                <Loader2 size={14} className="eagle-spin" />
              ) : (
                <Plug size={14} />
              )}
              测试连接
            </Button>
          </LayerCard>
        </SectionRule>
        <SectionRule title="日报" hint="每台机器独立总结，完成后归入历史。">
          <LayerCard className="space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label htmlFor="daily-enabled">自动生成报告</Label>
                <p className="mt-1 text-xs text-basalt-muted-foreground">
                  北京时间每天 23:59 启动，每台机器一天一份。
                </p>
              </div>
              <Switch
                id="daily-enabled"
                checked={settings.enabled}
                onCheckedChange={(enabled) => change({ enabled })}
              />
            </div>
            <p className="text-xs text-basalt-muted-foreground">
              按 00–23 时汇报，截止 23:59，不含最后一分钟。原始采集保留 48
              小时；校验失败最多重试一次，之后可手动重试。
            </p>
            {!settings.configured && (
              <p className="text-sm text-basalt-muted-foreground">
                未配置 AI，自动跳过报告生成。
              </p>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={
                !!busy || !settings.configured || !settings.enabled || dirty
              }
              onClick={() => void act("run")}
            >
              {busy === "run" && <Loader2 size={14} className="eagle-spin" />}
              生成最近日报
            </Button>
          </LayerCard>
        </SectionRule>
        <div className="flex flex-wrap items-center gap-3">
          <Button disabled={!!busy} onClick={() => void act("save")}>
            {busy === "save" ? (
              <Loader2 size={15} className="eagle-spin" />
            ) : saved ? (
              <Check size={15} />
            ) : (
              <Save size={15} />
            )}
            {saved ? "已保存" : "保存设置"}
          </Button>
          <span role="status" className="text-sm text-basalt-muted-foreground">
            {notice}
          </span>
        </div>
        {error && (
          <p role="alert" className="text-sm text-basalt-destructive">
            {error}
          </p>
        )}
      </div>
      <SectionRule title="中文报告模板" hint={`固定结构 · ${TEMPLATE_VERSION}`}>
        <LayerCard className="space-y-4">
          <p className="text-xs leading-relaxed text-basalt-muted-foreground">
            先读总览，再展开具体进展。报告覆盖本小时的事实采集与语义解释，区分已验证成果和推断，并注明缺失证据。
          </p>
          {[
            "总览 ≤160 字",
            "24 个小时，每小时 ≤80 字",
            "下一步 ≤3 条，每条 ≤60 字",
          ].map((title, i) => (
            <div key={title} className="flex gap-3 items-center text-sm">
              <span className="mono text-xs text-basalt-muted-foreground">
                0{i + 1}
              </span>
              <span>{title}</span>
            </div>
          ))}
        </LayerCard>
      </SectionRule>
    </div>
  );
}
