import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  SidebarUser,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nocoo/basalt";
import { useTheme } from "@nocoo/basalt/providers/theme";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import type { Viewer } from "../shared/schema.ts";
import { api } from "./api.ts";
import { localFrontend, localProduction } from "./environment.ts";
export function Mark({ size = 24 }: { size?: number }) {
  return (
    <img
      data-eagle-mark
      src="/brand/mark-128.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className="shrink-0 object-contain"
    />
  );
}
export function SidebarAccount({ collapsed }: { collapsed: boolean }) {
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<Viewer>("/api/v1/me", { signal: controller.signal })
      .then(setViewer)
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, []);
  const name = viewer?.name || (failed ? "身份暂不可用" : "正在读取身份…");
  const avatar = (
    <Avatar className="h-9 w-9 shrink-0">
      <AvatarImage
        src={viewer?.avatar || undefined}
        alt={`${name} 的头像`}
        referrerPolicy="no-referrer"
      />
      <AvatarFallback className="text-xs">
        {viewer?.name?.slice(0, 1).toUpperCase() || "E"}
      </AvatarFallback>
    </Avatar>
  );
  const logout = (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label="退出登录"
          aria-disabled={!viewer || viewer.local || localFrontend}
          className="shrink-0 aria-disabled:opacity-50"
          onClick={() => {
            if (viewer && !viewer.local && !localFrontend)
              window.location.assign("/cdn-cgi/access/logout");
          }}
        >
          <LogOut size={16} strokeWidth={1.5} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side={collapsed ? "right" : "top"}>
        {localProduction
          ? "生产身份由本机 cloudflared 管理；可切回 Local"
          : viewer?.local
            ? "本地免登录，无须退出"
            : "退出登录"}
      </TooltipContent>
    </Tooltip>
  );
  return collapsed ? (
    <>
      {logout}
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex">{avatar}</span>
        </TooltipTrigger>
        <TooltipContent side="right">
          {name}
          {viewer?.email ? ` · ${viewer.email}` : ""}
        </TooltipContent>
      </Tooltip>
    </>
  ) : (
    <SidebarUser
      name={name}
      email={viewer?.local ? "本地免登录" : viewer?.email}
      avatar={avatar}
      action={logout}
    />
  );
}
export function FamilyActions() {
  const { theme, setTheme } = useTheme();
  const next =
    theme === "system" ? "light" : theme === "light" ? "dark" : "system";
  const ThemeIcon =
    theme === "system" ? Monitor : theme === "dark" ? Moon : Sun;
  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild size="icon" variant="ghost">
            <a
              href="https://github.com/nocoo/eagle"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Eagle GitHub 仓库（新标签页）"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
                focusable="false"
                pointerEvents="none"
              >
                <path d="M12 2a10 10 0 0 0-3.16 19.49c.5.09.68-.22.68-.48v-1.87c-2.78.6-3.37-1.18-3.37-1.18-.45-1.16-1.11-1.47-1.11-1.47-.91-.62.07-.61.07-.61 1 .07 1.53 1.03 1.53 1.03.9 1.53 2.35 1.09 2.93.83.09-.65.35-1.09.64-1.34-2.22-.25-4.56-1.11-4.56-4.94 0-1.09.39-1.98 1.03-2.68-.1-.25-.45-1.27.1-2.65 0 0 .84-.27 2.75 1.02a9.58 9.58 0 0 1 5 0c1.91-1.29 2.75-1.02 2.75-1.02.55 1.38.2 2.4.1 2.65.64.7 1.03 1.59 1.03 2.68 0 3.84-2.34 4.69-4.57 4.94.36.31.68.92.68 1.85v2.76c0 .27.18.58.69.48A10 10 0 0 0 12 2Z" />
              </svg>
              <span className="sr-only">Eagle GitHub 仓库（新标签页）</span>
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          GitHub 仓库
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button asChild size="icon" variant="ghost">
            <a
              href="https://hexly.ai/projects/eagle"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="在 hexly.ai 查看 Eagle（新标签页）"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                focusable="false"
                pointerEvents="none"
              >
                <path d="m12 2 8.66 5v10L12 22l-8.66-5V7Z" />
                <path d="M12 2v20M3.34 7l17.32 10m0-10L3.34 17" />
              </svg>
              <span className="sr-only">
                在 hexly.ai 查看 Eagle（新标签页）
              </span>
            </a>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          在 hexly.ai 查看 Eagle
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            aria-label="切换主题"
            onClick={() => setTheme(next)}
          >
            <ThemeIcon size={16} strokeWidth={1.5} aria-hidden="true" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom" className="text-xs">
          {next === "light"
            ? "切换到浅色"
            : next === "dark"
              ? "切换到深色"
              : "跟随系统主题"}
        </TooltipContent>
      </Tooltip>
    </>
  );
}
