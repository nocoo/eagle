import { Button, Tooltip, TooltipContent, TooltipTrigger } from "@nocoo/basalt";
import { Activity, CircleAlert, Radio } from "lucide-react";
import { useEffect, useState } from "react";
import type { LiveFrame } from "../shared/realtime.ts";

export function RealtimeActivity({
  frame,
  online,
  connection,
  targetDescription,
}: {
  frame?: LiveFrame;
  online: boolean;
  connection: string;
  targetDescription: string;
}) {
  const [recent, setRecent] = useState(false);
  const content = frame
    ? JSON.stringify([frame.subscriptionId, frame.terminalId, frame.text])
    : "";
  useEffect(() => {
    setRecent(!!content && online);
    if (!content || !online) return;
    const timer = setTimeout(() => setRecent(false), 3000);
    return () => clearTimeout(timer);
  }, [content, online]);
  const message = !online
    ? connection
    : !frame
      ? "已连接，等待画面"
      : recent
        ? "刚有新输出"
        : "已连接，等待新输出";
  const Icon = !online ? CircleAlert : recent ? Activity : Radio;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="live-output-status"
          data-state={!online ? "offline" : recent ? "recent" : "waiting"}
          aria-label={`终端输出：${message}`}
        >
          <Icon size={13} aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        <p>{targetDescription}</p>
        <p>{message}。仅表示连接与画面变化，不代表任务完成。</p>
      </TooltipContent>
    </Tooltip>
  );
}
