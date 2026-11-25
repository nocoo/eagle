import { expect, type Page, test } from "@playwright/test";
import { report } from "../fixtures.ts";

async function workspace(page: Page) {
  const now = new Date().toISOString();
  const snapshot = report("initial", now);
  snapshot.spaces[0].tabs.push({
    id: "w1:t2",
    name: "Review",
    panes: [
      {
        ...structuredClone(snapshot.spaces[0].tabs[0].panes[0]),
        id: "w1:p2",
        title: "Reviewer",
        task: {
          id: "review-1",
          title: "Review initial work",
          requiresDeployment: false,
        },
      },
    ],
  });
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            report: snapshot,
            lastSeen: now,
            receivedAt: now,
            warning: null,
            revision: 1,
          },
        ],
      },
    }),
  );
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    const sub = { spaceId: "default:w1", subscriptionId: "epoch" };
    const tabs = snapshot.spaces[0].tabs.map((t) => ({
      id: t.id,
      name: t.name,
      panes: t.panes.map((p) => ({
        id: p.id,
        title: p.title,
        terminalId: `${p.id}-terminal`,
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
          text: `Live ${p.id}`,
          observedAt: now,
        }),
      );
  });
  await page.goto("/?machine=mac-one");
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "实时标签页" }),
  ).toContainText("Build");
}

test("current task sheet renders snapshot and opens the matching realtime tab", async ({
  page,
}) => {
  await workspace(page);
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect(page.locator(".space-detail-current")).toContainText("本次读取");
  await expect(page.locator(".space-detail-current")).toContainText(
    "Review initial work",
  );
  await page
    .getByRole("button", { name: "codex w1:p2 实时终端", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "实时标签页" }),
  ).toContainText("Review");
  await expect(page.getByRole("combobox", { name: "当前终端" })).toContainText(
    "w1:p2",
  );
  await expect(page.locator('.live-pane[data-selected="true"] pre')).toHaveText(
    "Live w1:p2",
  );
});
