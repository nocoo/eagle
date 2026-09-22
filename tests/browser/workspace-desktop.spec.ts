import { expect, type Page, test } from "@playwright/test";
import { MachineTelemetrySchema } from "../../src/shared/schema.ts";
import { report, telemetry } from "../fixtures.ts";

async function fixture(page: Page, empty = false, spaceCount = 2) {
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
      json: route.request().url().includes("semantic-hours")
        ? { hours: [], nextCursor: null }
        : { now, machines: shown, pendingMachines: [] },
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

test("root selects the first machine, machines lead the sidebar, and explicit overview stays global", async ({
  page,
  isMobile,
}) => {
  await page.clock.install();
  await fixture(page);
  await page.goto("/");
  await expect(page.locator(".space-card")).toHaveCount(2);
  await expect(page).toHaveURL(/machine=one/);
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await expect(
    page
      .getByRole("navigation", { name: "工作台导航" })
      .getByRole("button")
      .first(),
  ).toHaveAttribute("aria-label", "Mac One");
  await page.getByRole("button", { name: "全局总览", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.locator(".fleet-machine")).toHaveCount(2);
  await page.clock.fastForward(6000);
  await expect(page.locator(".fleet-machine")).toHaveCount(2);
  await page.goBack();
  await expect(page.locator(".space-card")).toHaveCount(2);
  await page.goForward();
  await expect(page.locator(".fleet-machine")).toHaveCount(2);
  await page.goto("/?machine=two");
  await expect(page.locator(".space-card")).toHaveCount(1);
  await expect(page).toHaveURL(/machine=two/);
});

test("desktop snapshot cards stay frozen across dashboard polls until explicitly refreshed", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop snapshot surface");
  await page.clock.install();
  const source = await fixture(page);
  await page.goto("/?machine=one");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  const left = page.getByRole("region", { name: "工作区快照" });
  await expect(left).toHaveAttribute("data-read-at", /\d{4}-/);
  const reads = source.overviewReads();
  const resources = left.getByRole("region", { name: "机器快照", exact: true });
  await expect(resources).toContainText("25%");
  await expect(resources).toContainText("Mac One");
  await expect(resources).not.toContainText("实时采样");
  await expect(left.locator(".workspace-machine")).toHaveCount(0);
  const gridBox = await left.locator(".workspace-task-grid").boundingBox();
  const resourceBox = await resources.boundingBox();
  if (!gridBox || !resourceBox) throw new Error("Missing snapshot geometry");
  expect(resourceBox.y).toBeGreaterThan(gridBox.y + gridBox.height);
  source.updateTitle("New task after opening snapshot");
  source.updateCpu(67);
  await page.clock.fastForward(6000);
  await expect.poll(source.overviewReads).toBeGreaterThan(reads);
  await expect(left).not.toContainText("New task after opening snapshot");
  await expect(resources).toContainText("25%");
  await left.getByRole("button", { name: "刷新工作区快照" }).click();
  await expect(left).toContainText("New task after opening snapshot");
  await expect(resources).toContainText("67%");
  expect(source.opened()).toBe(1);
  expect(source.inputs()).toBe(0);
});

test("an initially empty fleet selects the first machine when it becomes available", async ({
  page,
}) => {
  await page.clock.install();
  const source = await fixture(page, true);
  await page.goto("/");
  await expect(
    page.getByText("等待第一台机器接入", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(".space-card")).toHaveCount(0);
  source.addMachines();
  await page.clock.fastForward(6000);
  await expect(page.locator(".space-card")).toHaveCount(2);
  await expect(page).toHaveURL(/machine=one/);
});

test("fleet activity includes working hints but never revives stale machines or certifies done hints", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/overview");
  await expect(page.locator(".metric-active .metric-value")).toContainText(
    "01",
  );
  await expect(page.locator(".metric-unverified .metric-value")).toContainText(
    "02",
  );
  await expect(page.locator(".metric-verified .metric-value")).toContainText(
    "00",
  );
});

for (const theme of ["dark", "light"] as const) {
  test(`desktop workspace has responsive cards and in-place tabs (${theme})`, async ({
    page,
    isMobile,
  }, testInfo) => {
    test.skip(isMobile, "Desktop split surface");
    await page.addInitScript(
      (value) => localStorage.setItem("theme", value),
      theme,
    );
    let errors = 0;
    page.on("pageerror", () => errors++);
    await page.setViewportSize({ width: 1600, height: 1000 });
    const source = await fixture(page);
    await page.goto("/?machine=one");
    await page
      .getByRole("button", { name: "查看 Build Workspace", exact: true })
      .click();
    const left = page.getByRole("region", { name: "工作区快照" });
    await expect(left).toBeVisible();
    await expect(left).toContainText("Mac One");
    await expect(left.locator(".workspace-task-card")).toHaveCount(4);
    const columns = () =>
      left
        .locator(".workspace-task-grid")
        .evaluate(
          (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length,
        );
    await expect.poll(columns).toBe(2);
    const sheet = page.locator(".space-sheet");
    expect((await sheet.boundingBox())?.width).toBeCloseTo(1600, 1);
    await sheet.evaluate((el) => el.setAttribute("data-continuity", "same"));
    await left
      .getByRole("button", { name: "打开实时终端 w1:p3", exact: true })
      .click();
    await expect(
      page.getByRole("combobox", { name: "实时标签页" }),
    ).toContainText("Tests");
    await expect(
      page.getByRole("combobox", { name: "当前终端" }),
    ).toContainText("w1:p3");
    await page
      .getByRole("tab", { name: "Review Workspace", exact: true })
      .click();
    await expect(
      page.getByRole("tab", { name: "Review Workspace", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await expect(left.locator(".workspace-task-card").first()).toHaveAttribute(
      "data-pane",
      "w2:p1",
    );
    await expect(sheet).toHaveAttribute("data-continuity", "same");
    await expect.poll(source.closed).toBe(1);
    await expect.poll(source.opened).toBe(2);
    await sheet.screenshot({
      path: testInfo.outputPath("workspace-desktop.png"),
      animations: "disabled",
    });
    await page.setViewportSize({ width: 1200, height: 900 });
    await expect.poll(columns).toBe(1);
    const connections = source.opened();
    await page.setViewportSize({ width: 900, height: 900 });
    await expect(left).toHaveCount(0);
    expect(source.opened()).toBe(connections);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "返回机器页", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.locator(".space-card")).toHaveCount(2);
    expect(source.inputs()).toBe(0);
    expect(errors).toBe(0);
  });
}

test("mobile workspace tabs switch in place and never carry drafts into another workspace", async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(!isMobile, "Single-column mobile surface");
  const source = await fixture(page);
  await page.goto("/?machine=one");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "工作区快照" })).toHaveCount(0);
  const input = page.getByLabel("发送到当前 Pane");
  await expect(input).toBeEnabled();
  await input.fill("local draft, never sent");
  const picker = page.getByRole("button", { name: "选择工作区" });
  await expect(picker).toContainText("Build Workspace");
  await picker.click();
  await page
    .getByRole("button", { name: "切换到 Build Workspace", exact: true })
    .click();
  await expect(input).toHaveValue("local draft, never sent");
  expect(source.opened()).toBe(1);
  await picker.click();
  await page.getByRole("textbox", { name: "搜索工作区" }).fill("review");
  await page
    .getByRole("button", { name: "切换到 Review Workspace", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  await expect.poll(source.closed).toBe(1);
  await expect(picker).toContainText("Review Workspace");
  await expect(input).toHaveValue("");
  await expect.poll(source.opened).toBe(2);
  expect(source.inputs()).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator(".space-sheet").screenshot({
    path: testInfo.outputPath("workspace-mobile.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("many workspace tabs fold, search and resize without reconnecting", async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(isMobile, "Desktop overflow surface");
  await page.setViewportSize({ width: 1200, height: 900 });
  const source = await fixture(page, false, 20);
  await page.goto("/?machine=one");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  const more = page.getByRole("button", { name: /^更多工作区/ });
  await expect(more).toBeVisible();
  const input = page.getByLabel("发送到当前 Pane");
  await expect(input).toBeEnabled();
  await input.fill("keep this draft");
  await more.click();
  const search = page.getByRole("textbox", { name: "搜索工作区" });
  await expect(search).toBeFocused();
  await search.fill("missing workspace");
  await expect(page.getByText("没有匹配的工作区")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveCount(0);
  await expect(more).toBeFocused();
  await expect(input).toHaveValue("keep this draft");
  await more.click();
  await search.fill("default:w20");
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(source.opened()).toBe(1);
  await page
    .locator(".workspace-picker")
    .screenshot({ path: testInfo.outputPath("workspace-overflow.png") });
  await search.press("ArrowDown");
  await expect(
    page.getByRole("button", { name: "切换到 Workspace 20", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  const active = page.getByRole("tab", { name: "Workspace 20", exact: true });
  await expect(active).toHaveAttribute("aria-selected", "true");
  await expect(active).toBeFocused();
  await expect(input).toHaveValue("");
  await expect.poll(source.closed).toBe(1);
  await expect.poll(source.opened).toBe(2);
  await input.fill("survives resizing");
  for (const width of [900, 390, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) {
      await expect(
        page.getByRole("button", { name: "选择工作区" }),
      ).toContainText("Workspace 20");
    } else await expect(active).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const bar = page.locator(".workspace-window-bar");
    expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
      true,
    );
  }
  await expect(input).toHaveValue("survives resizing");
  expect(source.opened()).toBe(2);
  expect(source.inputs()).toBe(0);
  await active.press("Home");
  await expect(
    page.getByRole("tab", { name: "Build Workspace", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
});

test("one workspace needs no desktop overflow", async ({ page, isMobile }) => {
  test.skip(isMobile, "Desktop tabs");
  await fixture(page, false, 1);
  await page.goto("/");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Build Workspace", exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /^更多工作区/ })).toHaveCount(
    0,
  );
});

test("machine snapshot keeps missing and historical resource states explicit", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop snapshot surface");
  const source = await fixture(page);
  source.resourceState("missing");
  await page.goto("/");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  const resources = page.getByRole("region", { name: "机器快照", exact: true });
  await expect(resources).toContainText("尚未上报机器资源");
  source.resourceState("stale");
  await page.getByRole("button", { name: "刷新工作区快照" }).click();
  await expect(resources).toContainText("历史快照 · 等待更新");
  await expect(resources).toContainText("上次可连接");
  await expect(resources).not.toContainText("实时采样");
});

test("growing the desktop can unfold every tab without recreating realtime", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Desktop overflow surface");
  await page.setViewportSize({ width: 900, height: 900 });
  const source = await fixture(page, false, 6);
  await page.goto("/");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  const more = page.getByRole("button", { name: /^更多工作区/ });
  await more.click();
  await page
    .getByRole("button", { name: "切换到 Workspace 6", exact: true })
    .click();
  await expect.poll(source.opened).toBe(2);
  await more.click();
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect(more).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "搜索工作区" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("tablist", { name: "切换工作区" }).getByRole("tab"),
  ).toHaveCount(6);
  await expect(
    page.getByRole("tab", { name: "Workspace 6", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.setViewportSize({ width: 900, height: 900 });
  await more.click();
  await expect(page.getByRole("textbox", { name: "搜索工作区" })).toHaveValue(
    "",
  );
  expect(source.opened()).toBe(2);
  expect(source.inputs()).toBe(0);
});

test("mobile can search a large workspace list by ID", async ({
  page,
  isMobile,
}, testInfo) => {
  test.skip(!isMobile, "Mobile picker surface");
  const source = await fixture(page, false, 20);
  await page.goto("/");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  const picker = page.getByRole("button", { name: "选择工作区" });
  await picker.click();
  const search = page.getByRole("textbox", { name: "搜索工作区" });
  await expect(page.getByRole("button", { name: /^切换到 / })).toHaveCount(20);
  await page
    .locator(".workspace-picker")
    .screenshot({ path: testInfo.outputPath("workspace-picker-mobile.png") });
  await search.fill("default:w20");
  await page
    .getByRole("button", { name: "切换到 Workspace 20", exact: true })
    .click();
  await expect(picker).toContainText("Workspace 20");
  await expect(picker).toBeFocused();
  await expect.poll(source.opened).toBe(2);
  expect(source.inputs()).toBe(0);
});
