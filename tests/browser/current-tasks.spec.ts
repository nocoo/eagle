import { expect, type Page, test } from "@playwright/test";
import { report } from "../fixtures.ts";

async function workspace(page: Page, missingTarget = false) {
  const now = new Date().toISOString();
  let snapshot = report("initial", now);
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
  let overviewReads = 0,
    hoursReads = 0,
    controls = 0,
    fail = false;
  await page.route("**/api/**", (route) => {
    if (route.request().url().includes("semantic-hours")) {
      hoursReads++;
      return route.fulfill({ json: { hours: [], nextCursor: null } });
    }
    if (route.request().url().includes("overview")) overviewReads++;
    if (fail)
      return route.fulfill({ status: 503, json: { error: "unavailable" } });
    return route.fulfill({
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
            revision: overviewReads,
          },
        ],
      },
    });
  });
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    const sub = { spaceId: "default:w1", subscriptionId: "epoch" };
    const tabs = snapshot.spaces[0].tabs
      .filter((_, index) => !missingTarget || index === 0)
      .map((t) => ({
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
    ws.onMessage((data) => {
      const m = JSON.parse(String(data));
      if (m.type === "control") controls++;
      if (m.type === "control" || m.type === "release")
        ws.send(
          JSON.stringify({
            type: "status",
            online: true,
            control: m.type === "control",
          }),
        );
    });
  });
  await page.goto("/?machine=mac-one");
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await expect(
    page.getByRole("combobox", { name: "实时标签页" }),
  ).toContainText("Build");
  return {
    now,
    reads: () => overviewReads,
    hoursReads: () => hoursReads,
    controls: () => controls,
    fail: (value: boolean) => {
      fail = value;
    },
    update: (title: string, capturedAt = now) => {
      snapshot = structuredClone(snapshot);
      snapshot.reportId = title;
      snapshot.capturedAt = capturedAt;
      snapshot.spaces[0].tabs[0].panes[0].task = {
        id: title,
        title,
        requiresDeployment: false,
      };
    },
  };
}

test("current task sheet matches realtime geometry and cards open the matching realtime tab", async ({
  page,
}, testInfo) => {
  await workspace(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const sheet = page.locator(".space-sheet");
  const header = page.locator(".space-detail-header");
  const before = await sheet.boundingBox();
  const headerBefore = await header.boundingBox();
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect
    .poll(async () => (await sheet.boundingBox())?.width ?? 0)
    .toBeCloseTo(before?.width ?? 1, 2);
  expect((await sheet.boundingBox())?.height ?? 0).toBeCloseTo(
    before?.height ?? 1,
    2,
  );
  expect((await header.boundingBox())?.height ?? 0).toBeCloseTo(
    headerBefore?.height ?? 1,
    2,
  );
  await expect(page.locator(".space-detail-current")).toContainText("本次读取");
  await sheet.screenshot({
    path: testInfo.outputPath("current-task-panel.png"),
    animations: "disabled",
  });
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
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect(page.locator(".space-detail-current")).toContainText(
    "Review initial work",
  );
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  await page
    .getByRole("button", { name: "codex w1:p2 证据", exact: true })
    .click();
  await expect(
    page.getByRole("combobox", { name: "实时标签页" }),
  ).toContainText("Review");
});

test("opening current tasks fetches a fresh snapshot then freezes it until refresh or reopen", async ({
  page,
}) => {
  await page.clock.install();
  const source = await workspace(page);
  const reads = source.reads();
  source.update("New task from latest report");
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  const current = page.locator(".space-detail-current");
  await expect(current).toContainText("New task from latest report");
  expect(source.reads()).toBe(reads + 1);
  await expect(current).toContainText("快照采集");
  await expect.poll(source.hoursReads).toBe(1);
  source.update("Later task, not auto-rendered");
  await page.clock.fastForward(16000);
  await expect.poll(source.reads).toBeGreaterThan(reads + 1);
  await expect(current).not.toContainText("Later task, not auto-rendered");
  expect(source.hoursReads()).toBe(1);
  await page.getByRole("button", { name: "刷新当前任务", exact: true }).click();
  await expect(current).toContainText("Later task, not auto-rendered");
  source.update("Task when reopened");
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect(current).toContainText("Task when reopened");
});

test("a stale snapshot and failed refresh stay explicit instead of implying live task parity", async ({
  page,
}) => {
  const source = await workspace(page);
  source.update(
    "Older collected task",
    new Date(Date.parse(source.now) - 30000).toISOString(),
  );
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  const current = page.locator(".space-detail-current");
  await expect(current).toContainText("快照早于最近实时画面");
  source.fail(true);
  await page.getByRole("button", { name: "刷新当前任务", exact: true }).click();
  await expect(current).toContainText("刷新失败，保留上次快照");
  await expect(current).toContainText("Older collected task");
  source.fail(false);
  source.update("Recovered snapshot");
  await page.getByRole("button", { name: "刷新当前任务", exact: true }).click();
  await expect(current).toContainText("Recovered snapshot");
  await expect(current).not.toContainText("刷新失败");
});

test("an unavailable card target never silently opens and controls a different terminal", async ({
  page,
}) => {
  const source = await workspace(page, true);
  await expect(page.getByLabel("发送到当前 Pane")).toBeEnabled();
  const controls = source.controls();
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await page
    .getByRole("button", { name: "codex w1:p2 实时终端", exact: true })
    .click();
  await expect(
    page.getByText("所选终端不在当前实时布局中，请重新选择。"),
  ).toBeVisible();
  await expect(page.getByLabel("发送到当前 Pane")).toBeDisabled();
  expect(source.controls()).toBe(controls);
});

test("leaving the view cancels an older read so it cannot overwrite a reopened snapshot", async ({
  page,
}) => {
  await workspace(page);
  let reads = 0;
  let release = () => {};
  const delayed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let finished = () => {};
  const settled = new Promise<void>((resolve) => {
    finished = resolve;
  });
  await page.route("**/api/v1/overview", async (route) => {
    const first = ++reads === 1;
    const capturedAt = new Date().toISOString();
    const value = report(first ? "delayed" : "reopened", capturedAt);
    value.spaces[0].tabs[0].panes[0].task.title = first
      ? "Old delayed response"
      : "Fresh reopened response";
    if (first) await delayed;
    try {
      await route.fulfill({
        json: {
          now: capturedAt,
          machines: [
            {
              id: "mac-one",
              name: "Mac One",
              report: value,
              lastSeen: capturedAt,
              receivedAt: capturedAt,
              warning: null,
            },
          ],
        },
      });
    } catch {
      /* An aborted route need not receive a response. */
    } finally {
      if (first) finished();
    }
  });
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect.poll(() => reads).toBe(1);
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  const current = page.locator(".space-detail-current");
  await expect(current).toContainText("Fresh reopened response");
  release();
  await settled;
  await expect(current).not.toContainText("Old delayed response");
});

test("an expired Access session clears the task snapshot instead of showing protected cached data", async ({
  page,
}) => {
  await workspace(page);
  await page.route("**/api/v1/overview", (route) =>
    route.fulfill({ status: 401, json: { error: "Sign in required" } }),
  );
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "通过 Cloudflare Access 继续" }),
  ).toBeVisible();
  await expect(page.locator(".space-detail-current")).toHaveCount(0);
});
