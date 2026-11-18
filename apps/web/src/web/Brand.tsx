import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  SidebarUser,
  ThemeToggle,
} from "@nocoo/basalt";
import { ProjectLinks } from "@nocoo/basalt/components/app-header";
import { LogOut } from "@nocoo/basalt/icons";
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
export function SidebarAccount() {
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
  const canSignOut = !!viewer && !viewer.local && !localFrontend;
  const signOutAction =
    viewer && !canSignOut ? (
      <Button size="icon-sm" variant="ghost" aria-label="退出登录" disabled>
        <LogOut strokeWidth={1.5} aria-hidden="true" />
      </Button>
    ) : undefined;
  return (
    <SidebarUser
      name={name}
      email={viewer?.local ? "本地免登录" : viewer?.email}
      avatar={avatar}
      tooltip={viewer?.email ? `${name} · ${viewer.email}` : name}
      action={signOutAction}
      onSignOut={
        canSignOut
          ? () => window.location.assign("/cdn-cgi/access/logout")
          : undefined
      }
      signOutLabel={localProduction ? "退出 Cloudflare Access" : "退出登录"}
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
