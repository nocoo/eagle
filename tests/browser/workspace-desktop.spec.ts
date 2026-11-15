import { expect, test } from "@playwright/test";
import { fixture } from "./workspace-fixtures.ts";

test("desktop snapshot cards stay frozen across dashboard polls until explicitly refreshed", async ({
  page,
}) => {
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

for (const theme of ["dark", "light"] as const) {
  test(`desktop workspace has compact details and vertical navigation (${theme})`, async ({
    page,
  }, testInfo) => {
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
    await expect.poll(columns).toBe(1);
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
    await expect(left).toHaveCount(0);
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

for (const view of ["当前任务"]) {
  test(`the selected snapshot card reopens realtime from ${view}`, async ({
    page,
  }) => {
    const source = await fixture(page);
    await page.goto("/?machine=one");
    await page
      .getByRole("button", { name: "查看 Build Workspace", exact: true })
      .click();
    const card = page.getByRole("button", {
      name: "打开实时终端 w1:p1",
      exact: true,
    });
    await expect(card).toHaveAttribute("aria-pressed", "true");
    const input = page.getByLabel("发送到当前 Pane");
    await expect(input).toBeEnabled();
    await input.fill("preserved when leaving realtime");
    await page.getByRole("button", { name: view, exact: true }).click();
    await expect(page.locator(".live-space")).toHaveCount(0);
    await expect.poll(source.closed).toBe(1);
    await card.click();
    await expect(page.locator(".live-space")).toBeVisible();
    await expect(
      page.getByRole("combobox", { name: "当前终端" }),
    ).toContainText("w1:p1");
    await expect(input).toHaveValue("preserved when leaving realtime");
    await expect.poll(source.opened).toBe(2);
    expect(source.inputs()).toBe(0);
  });
}

test("vertical spaces stay searchable and keyboard accessible without losing terminal drafts", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  const source = await fixture(page, false, 20);
  await page.goto("/");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  const navigation = page.getByRole("tablist", { name: "切换工作区" });
  await expect(navigation).toHaveAttribute("aria-orientation", "vertical");
  await expect(navigation.getByRole("tab")).toHaveCount(20);
  const search = page.getByRole("textbox", { name: "搜索工作区" });
  const input = page.getByLabel("发送到当前 Pane");
  await expect(input).toBeEnabled();
  await input.fill("keep this draft");
  await search.fill("missing workspace");
  await expect(page.getByText("没有匹配的工作区")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(input).toHaveValue("keep this draft");
  await search.fill("default:w20");
  await search.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  expect(source.opened()).toBe(1);
  await search.press("ArrowDown");
  const active = page.getByRole("tab", { name: "Workspace 20", exact: true });
  await expect(active).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(active).toHaveAttribute("aria-selected", "true");
  await expect(active).toHaveAttribute("aria-current", "true");
  expect(
    await active.evaluate(
      (node) => getComputedStyle(node, "::before").backgroundColor,
    ),
  ).toBe("rgba(0, 0, 0, 0)");
  await expect(input).toHaveValue("");
  await expect.poll(source.closed).toBe(1);
  await expect.poll(source.opened).toBe(2);
  await search.fill("");
  await active.focus();
  await active.press("Home");
  await expect(
    page.getByRole("tab", { name: "Build Workspace", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowDown");
  await expect(
    page.getByRole("tab", { name: "Review Workspace", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page.locator(".space-sheet").screenshot({
    path: testInfo.outputPath("workspace-navigation.png"),
    animations: "disabled",
  });
  expect(source.inputs()).toBe(0);
});

test("one workspace needs no desktop overflow", async ({ page }) => {
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
}) => {
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

test("workspace information can be tucked away and reopened without reconnecting", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1600, height: 900 });
  const source = await fixture(page, false, 20);
  await page.goto("/");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  const nav = page.locator(".workspace-rail");
  const main = page.locator(".workspace-detail");
  const info = page.getByRole("region", { name: "工作区快照" });
  await expect(info).toBeVisible();
  const n = await nav.boundingBox(),
    m = await main.boundingBox(),
    i = await info.boundingBox();
  if (!n || !m || !i) throw new Error("Missing workspace regions");
  expect(n.x + n.width).toBeLessThanOrEqual(m.x + 1);
  expect(m.x + m.width).toBeLessThanOrEqual(i.x + 1);
  const columns = await page.locator(".workspace-columns").boundingBox();
  const inspector = await page.locator(".workspace-inspector").boundingBox();
  if (!columns || !inspector) throw new Error("Missing split geometry");
  expect(m.width).toBeCloseTo(columns.width - inspector.width, 0);
  expect(m.width).toBeGreaterThan(i.width);
  const card = await info.locator(".workspace-task-card").first().boundingBox();
  expect(card?.height).toBeLessThan(145);
  const body = await page.locator(".space-detail-body").boundingBox();
  expect(body?.y).toBeLessThanOrEqual(48);
  await expect(nav.getByRole("button", { name: "关闭工作区" })).toBeVisible();
  const input = page.getByLabel("发送到当前 Pane");
  await expect(input).toBeEnabled();
  await input.fill("survives layout changes");
  const toggle = page.getByRole("button", { name: "工作区信息", exact: true });
  await toggle.click();
  await expect(info).toHaveCount(0);
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await toggle.click();
  await expect(info).toBeVisible();
  for (const width of [1200, 900, 390, 1600]) {
    await page.setViewportSize({ width, height: 900 });
    if (width < 1280) {
      await expect(info).toHaveCount(0);
      await toggle.click();
      await expect(info).toBeVisible();
      await expect(
        info.getByRole("region", { name: "机器快照", exact: true }),
      ).toBeVisible();
      if (width === 390) {
        await expect(input).toHaveValue("survives layout changes");
        await info
          .getByRole("button", { name: "打开实时终端 w1:p3", exact: true })
          .click();
        await expect(info).toHaveCount(0);
        await expect(
          page.getByRole("combobox", { name: "当前终端" }),
        ).toContainText("w1:p3");
        await toggle.click();
      }
      await page.keyboard.press("Escape");
      await expect(info).toHaveCount(0);
      await expect(toggle).toBeFocused();
      await expect(page.getByRole("dialog")).toBeVisible();
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  await expect(input).toHaveValue("");
  expect(source.opened()).toBe(1);
  expect(source.inputs()).toBe(0);
});
