import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  SidebarUser,
  ThemeToggle,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@nocoo/basalt";
import { ProjectLinks } from "@nocoo/basalt/components/app-header";
import { LogOut } from "lucide-react";
import { useEffect, useState } from "react";
import type { Viewer } from "../../../../packages/contracts/src/schema.ts";
import { api } from "./api.ts";
import { localFrontend, localProduction } from "./environment.ts";
export function Mark({
  size = 24,
  className = "shrink-0 object-contain",
}: {
  size?: number;
  className?: string;
}) {
  return (
    <img
      data-eagle-mark
      src="/brand/mark-128.png"
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      className={className}
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
    <Avatar>
      <AvatarImage
        src={viewer?.avatar || undefined}
        alt={`${name} 的头像`}
        referrerPolicy="no-referrer"
      />
      <AvatarFallback>
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
  return (
    <>
      <ProjectLinks
        github="nocoo/eagle"
        hexly="eagle"
        name="Eagle"
        githubLabel="Eagle GitHub 仓库"
        hexlyLabel="在 hexly.ai 查看 Eagle"
        newTabLabel="（新标签页）"
      />
      <ThemeToggle
        aria-label="切换主题"
        labels={{
          light: "切换到浅色",
          dark: "切换到深色",
          system: "跟随系统主题",
        }}
      />
    </>
  );
}
