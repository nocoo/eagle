import type { Page } from "@playwright/test";
import { MachineTelemetrySchema } from "../../packages/contracts/src/schema.ts";
import { evidence, report, telemetry } from "../fixtures.ts";

export async function fixture(page: Page, empty = false, spaceCount = 2) {
  const now = new Date().toISOString();
  const value = report("workspaces", now);
  value.machine.telemetry = MachineTelemetrySchema.parse(telemetry(now));
  value.spaces = Array.from({ length: spaceCount }, (_, i) => i + 1).map(
    (index) => ({
      ...structuredClone(value.spaces[0]),
      id: `default:w${index}`,
      name:
        index === 1
          ? "Build Workspace"
          : index === 2
            ? "Review Workspace"
            : `Workspace ${index}`,
      objective:
        index === 1
          ? "Ship a precise, readable workspace"
          : "Review and validate the release",
      tabs: [1, 2].map((tab) => ({
        id: `w${index}:t${tab}`,
        name: tab === 1 ? "Code" : "Tests",
        panes: [1, 2].map((p) => ({
          ...structuredClone(value.spaces[0].tabs[0].panes[0]),
          id: `w${index}:p${(tab - 1) * 2 + p}`,
          title: `Terminal ${tab}-${p}`,
          hint:
            index === 1 && p === 1 && tab === 1
              ? ("working" as const)
              : ("done" as const),
          task: {
            id: `task-${index}-${tab}-${p}`,
            title: [
              "Implement responsive workspace layout",
              "Review authentication boundaries",
              "Run desktop and mobile checks",
              "Verify the release snapshot",
            ][(tab - 1) * 2 + p - 1],
            requiresDeployment: true,
          },
          rect: { x: (p - 1) / 2, y: 0, width: 0.5, height: 1 },
        })),
      })),
    }),
  );
  const stale = structuredClone(value);
  stale.spaces = stale.spaces.slice(0, 1);
  stale.capturedAt = new Date(Date.parse(now) - 600000).toISOString();
  const machines = [
    {
      id: "one",
      name: "Mac One",
      report: value,
      lastSeen: now,
      receivedAt: now,
      warning: null,
      revision: 1,
    },
    {
      id: "two",
      name: "Mac Two",
      report: stale,
      lastSeen: stale.capturedAt,
      receivedAt: stale.capturedAt,
      warning: null,
      revision: 1,
    },
  ];
  let shown = empty ? [] : machines;
  let overviewReads = 0;
  await page.route("**/api/**", (route) => {
    if (route.request().url().includes("/overview")) overviewReads++;
    return route.fulfill({
      json: { now, machines: shown, pendingMachines: [] },
    });
  });
  let opened = 0,
    closed = 0,
    inputs = 0;
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    opened++;
    const spaceId = new URL(ws.url()).searchParams.get("space");
    const space = value.spaces.find((s) => s.id === spaceId);
    if (!space) throw new Error("Unexpected Space");
    const sub = { spaceId, subscriptionId: `epoch-${opened}` };
    const tabs = space.tabs.map((t) => ({
      id: t.id,
      name: t.name,
      panes: t.panes.map((p) => ({
        id: p.id,
        terminalId: `${p.id}-terminal`,
        title: p.title,
        rect: p.rect,
      })),
    }));
    ws.send(JSON.stringify({ type: "status", online: true, control: false }));
    ws.send(JSON.stringify({ type: "topology", ...sub, tabs }));
    for (const p of tabs.flatMap((t) => t.panes))
      ws.send(
        JSON.stringify({
          type: "frame",
          ...sub,
          paneId: p.id,
          terminalId: p.terminalId,
          revision: 1,
          text: `Synthetic live output for ${p.id}`,
          observedAt: now,
        }),
      );
    ws.onMessage((data) => {
      const m = JSON.parse(String(data));
      if (m.type === "input") inputs++;
      if (m.type === "control" || m.type === "release")
        ws.send(
          JSON.stringify({
            type: "status",
            online: true,
            control: m.type === "control",
          }),
        );
    });
    ws.onClose(() => closed++);
  });
  return {
    opened: () => opened,
    closed: () => closed,
    inputs: () => inputs,
    markSecondAttention: () => {
      const pane = value.spaces[1].tabs[0].panes[0];
      pane.evidence = [
        evidence("test", "failure", { taskId: pane.task.id, observedAt: now }),
      ];
    },
    addMachines: () => {
      shown = machines;
    },
    overviewReads: () => overviewReads,
    updateTitle: (title: string) => {
      value.spaces[0].tabs[0].panes[0].task.title = title;
    },
    updateCpu: (cpu: number) => {
      if (value.machine.telemetry?.resources)
        value.machine.telemetry.resources.cpuUsagePercent = cpu;
    },
    resourceState: (state: "missing" | "stale") => {
      value.machine.telemetry =
        state === "missing"
          ? undefined
          : MachineTelemetrySchema.parse(
              telemetry(new Date(Date.parse(now) - 600000).toISOString()),
            );
    },
  };
}
