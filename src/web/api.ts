import { apiPath, authenticationMessage } from "./environment.ts";

export class AuthError extends Error {}
export async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(apiPath(path), {
    ...options,
    credentials: "same-origin",
    redirect: "manual",
    signal: options?.signal ?? AbortSignal.timeout(15000),
  });
  if (
    response.status === 401 ||
    response.status === 403 ||
    response.type === "opaqueredirect"
  )
    throw new AuthError(authenticationMessage);
  if (!response.ok) {
    if (options?.method && options.method !== "GET") {
      const messages: Record<number, string> = {
        400: "配置格式不正确，请检查名称、ID 与端口。",
        404: "机器不存在，请刷新列表。",
        409: "机器 ID 已存在，请使用其他 ID。",
        503: "服务暂时不可用，请稍后重试。",
      };
      throw new Error(messages[response.status] ?? "操作失败，请重试。");
    }
    throw new Error("连接中断，显示上次成功同步的数据");
  }
  return response.json();
}
export const age = (iso: string, now: string) =>
  Math.max(0, Math.floor((Date.parse(now) - Date.parse(iso)) / 1000));
