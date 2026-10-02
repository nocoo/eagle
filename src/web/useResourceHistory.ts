import { useEffect, useState } from "react";
import type { ResourceHistory } from "../shared/resources.ts";
import { AuthError, api } from "./api.ts";

export function useResourceHistory(machineId: string, observedAt?: string) {
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<{
    machineId: string;
    data?: ResourceHistory;
    error?: string;
    loading: boolean;
  }>({ machineId, loading: true });
  useEffect(() => {
    const controller = new AbortController();
    setResult((previous) => ({
      machineId,
      data: previous.machineId === machineId ? previous.data : undefined,
      loading: true,
    }));
    void api<ResourceHistory>(
      `/api/v1/resources?machine=${encodeURIComponent(machineId)}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (!Array.isArray(data.samples) || data.retentionSeconds !== 86400)
          throw new Error("Invalid resource history");
        if (!controller.signal.aborted)
          setResult({ machineId, data, loading: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult((previous) => ({
          machineId,
          data:
            error instanceof AuthError || previous.machineId !== machineId
              ? undefined
              : previous.data,
          error:
            error instanceof AuthError
              ? "请重新登录后查看资源历史"
              : "历史更新失败，保留上次成功读取的数据",
          loading: false,
        }));
      });
    return () => controller.abort();
  }, [machineId, observedAt, refresh]);
  return {
    ...(result.machineId === machineId
      ? result
      : { machineId, loading: true, data: undefined, error: undefined }),
    refresh: () => setRefresh((value) => value + 1),
  };
}
