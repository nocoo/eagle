import { useEffect, useRef, useState } from "react";
import type { MachineView, Overview, Space } from "../shared/schema.ts";
import { AuthError, api } from "./api.ts";

/** Read on entry/explicit refresh, then keep this view independent of dashboard polling. */
export function useCurrentTaskSnapshot(
  machine: MachineView,
  space: Space,
  enabled: boolean,
  onAuthError: () => void,
) {
  const [snapshot, setSnapshot] = useState<{
    machine: MachineView;
    space?: Space;
    readAt?: string;
    generation: number;
  }>({ machine, space, generation: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const active = useRef(false);
  const machineId = machine.id,
    spaceId = space.id;
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    active.current = true;
    setBusy(true);
    setError("");
    void api<Overview>("/api/v1/overview", {
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]),
      cache: "no-store",
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        const latest = result.machines.find((m) => m.id === machineId);
        setSnapshot((previous) => ({
          machine: latest ?? previous.machine,
          space: latest?.report.spaces.find((s) => s.id === spaceId),
          readAt: result.now,
          generation: previous.generation + 1,
        }));
      })
      .catch((cause) => {
        if (controller.signal.aborted) return;
        if (cause instanceof AuthError) onAuthError();
        else setError("刷新失败，保留上次快照；请重试。");
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          active.current = false;
          setBusy(false);
        }
      });
    return () => {
      controller.abort();
      active.current = false;
    };
  }, [enabled, machineId, spaceId, attempt, onAuthError]);
  return {
    ...snapshot,
    busy,
    error,
    refresh: () => {
      if (active.current) return;
      active.current = true;
      setAttempt((n) => n + 1);
    },
  };
}
