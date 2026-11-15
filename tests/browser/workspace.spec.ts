import { expect, test } from "@playwright/test";
import { fixture } from "./workspace-fixtures.ts";

test("machine spaces follow Herdr order with compact full-width mobile cards", async ({
  page,
  isMobile,
}) => {
  const source = await fixture(page);
  source.markSecondAttention();
  await page.goto("/?machine=one");
  const cards = page.locator(".space-card");
  await expect(cards.locator("h3")).toHaveText([
    "Build Workspace",
    "Review Workspace",
  ]);
  if (isMobile) {
    for (const card of await cards.all()) {
      await expect(card.locator(".space-topology")).toBeHidden();
      await expect(card.locator(".evidence-strip")).toBeHidden();
      expect((await card.boundingBox())?.height).toBeLessThanOrEqual(100);
      for (const selector of ["h3", ".space-objective", ".space-summary"]) {
        const lines = await card
          .locator(selector)
          .evaluate(
            (node) =>
              node.getBoundingClientRect().height /
              Number.parseFloat(getComputedStyle(node).lineHeight),
          );
        expect(lines).toBeLessThanOrEqual(1.1);
      }
    }
    const aside = page.locator(".dashboard-aside");
    const width = (await aside.boundingBox())?.width ?? 0;
    for (const selector of [
      ".activity-card",
      ".agents-card",
      ".coverage-card",
    ]) {
      expect(
        (await page.locator(selector).boundingBox())?.width,
      ).toBeGreaterThanOrEqual(width - 2);
    }
    await page
      .locator(".dashboard-content")
      .screenshot({ path: test.info().outputPath("machine-mobile.png") });
    await cards.first().click({ position: { x: 100, y: 50 } });
    await expect(page.getByRole("dialog")).toBeVisible();
  }
});

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

test("Basalt sidebar keeps one navigation inset and native section spacing", async ({
  page,
  isMobile,
}) => {
  await fixture(page);
  await page.goto("/");
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  const nav = page.getByRole("navigation", { name: "工作台导航" });
  await expect(nav.getByRole("button", { name: "Mac One" })).toBeVisible();
  await page.screenshot({ path: test.info().outputPath("sidebar.png") });
  const geometry = await nav.evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return Array.from(node.querySelectorAll("button")).map((item) => ({
      inset: item.getBoundingClientRect().left - bounds.left,
      rightInset: bounds.right - item.getBoundingClientRect().right,
    }));
  });
  for (const row of geometry) {
    expect(row.inset).toBeCloseTo(16, 1);
    expect(row.rightInset).toBeCloseTo(16, 1);
  }
  for (const label of await nav
    .locator('[data-slot="sidebar-partition"]')
    .all()) {
    await expect(label).toHaveCSS("margin-top", "0px");
    await expect(label).toHaveCSS("font-size", "12px");
  }
  await expect(nav.getByRole("button", { name: "Mac One" })).toHaveCSS(
    "font-size",
    "14px",
  );
});

test("Basalt typography keeps machine and workspace content readable", async ({
  page,
  isMobile,
}) => {
  await fixture(page);
  await page.goto("/");
  for (const selector of [
    ".space-objective",
    ".space-summary",
    ".resource-metric-heading",
  ]) {
    await expect(page.locator(selector).first()).toHaveCSS("font-size", "14px");
  }
  await expect(page.locator(".resource-metric-detail").first()).toHaveCSS(
    "font-size",
    "12px",
  );
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  await expect(page.getByLabel("发送到当前 Pane")).toHaveCSS(
    "font-size",
    isMobile ? "16px" : "14px",
  );
  const toggle = page.getByRole("button", { name: "工作区信息", exact: true });
  if ((await toggle.getAttribute("aria-expanded")) === "false")
    await toggle.click();
  await expect(page.locator(".workspace-objective")).toHaveCSS(
    "font-size",
    "14px",
  );
  await expect(page.locator(".workspace-task-title").first()).toHaveCSS(
    "font-size",
    "14px",
  );
});

test("desktop machine and workspace use the same generous panel width", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await fixture(page);
  for (const width of [1280, 1600, 1920]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/");
    const resources = page.locator(".dashboard-resources");
    await expect(resources).toBeVisible();
    const expected = Math.min(608, Math.max(416, width * 0.32));
    const resourceWidth = (await resources.boundingBox())?.width ?? 0;
    await page.screenshot({
      path: test.info().outputPath(`machine-${width}.png`),
    });
    expect(resourceWidth).toBeCloseTo(expected, 0);
    await page
      .getByRole("button", { name: "查看 Build Workspace", exact: true })
      .click();
    const inspector = page.locator(".workspace-inspector");
    await expect(inspector).toBeVisible();
    await expect
      .poll(async () => (await inspector.boundingBox())?.width ?? 0)
      .toBeCloseTo(resourceWidth, 0);
    await expect(page.getByLabel("发送到当前 Pane")).toBeInViewport({
      ratio: 1,
    });
    await page.screenshot({
      path: test.info().outputPath(`workspace-${width}.png`),
    });
  }
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

test("information panel animates without replacing the terminal", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1600, height: 900 });
  const source = await fixture(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  const input = page.getByLabel("发送到当前 Pane");
  await expect(input).toBeEnabled();
  await input.fill("keep this draft");
  const toggle = page.getByRole("button", { name: "工作区信息", exact: true });
  const inspector = page.locator(".workspace-inspector");
  for (const width of [1600, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if ((await toggle.getAttribute("aria-expanded")) === "false")
      await toggle.click();
    await expect(inspector).toBeVisible();
    await inspector.evaluate(async (el) => {
      await Promise.all(el.getAnimations().map((a) => a.finished));
    });
    const openWidth = (await inspector.boundingBox())?.width ?? 0;
    expect(openWidth).toBeGreaterThan(0);
    const frames = await toggle.evaluate(async (el) => {
      (el as HTMLButtonElement).click();
      await new Promise(requestAnimationFrame);
      const panel = document.querySelector<HTMLElement>(".workspace-inspector");
      if (!panel) throw new Error("Missing inspector");
      const animations = panel.getAnimations();
      for (const animation of animations) {
        animation.pause();
        animation.currentTime = 120;
      }
      const box = panel.getBoundingClientRect();
      const result = { count: animations.length, width: box.width, x: box.x };
      for (const animation of animations) animation.finish();
      return result;
    });
    expect(frames.count).toBeGreaterThan(0);
    if (width >= 1280) {
      expect(frames.width).toBeGreaterThan(0);
      expect(frames.width).toBeLessThan(openWidth);
    } else {
      expect(frames.x).toBeGreaterThan(width - openWidth);
      expect(frames.x).toBeLessThan(width);
    }
    await expect(page.getByRole("region", { name: "工作区快照" })).toHaveCount(
      0,
    );
    await expect(toggle).toBeVisible();
    await expect(input).toHaveValue("keep this draft");
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  await toggle.click();
  expect(await inspector.evaluate((el) => el.getAnimations().length)).toBe(0);
  expect(source.opened()).toBe(1);
  expect(source.inputs()).toBe(0);
});

test("snapshot age counts upward without refreshing frozen content", async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1600, height: 900 });
  const source = await fixture(page);
  await page.goto("/");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  const snapshot = page.getByRole("region", { name: "工作区快照" });
  await expect(snapshot).toHaveAttribute("aria-busy", "false");
  const stamp = snapshot.locator(".workspace-snapshot-time time");
  const capturedAt = await stamp.getAttribute("datetime");
  if (!capturedAt) throw new Error("Missing capture time");
  await page.clock.setSystemTime(new Date(Date.parse(capturedAt) + 90120000));
  await page.clock.runFor(1000);
  await expect(stamp).toContainText("25 小时 2 分 1 秒前");
  await page.clock.setSystemTime(new Date(Date.parse(capturedAt) + 192000));
  await page.clock.runFor(1000);
  await expect(stamp).toContainText("3 分 13 秒前");
  source.updateTitle("A newer task must stay hidden");
  await page.clock.fastForward(2000);
  await expect(stamp).toContainText("3 分 15 秒前");
  await expect(snapshot).not.toContainText("A newer task must stay hidden");
  await snapshot.getByRole("button", { name: /采集于/ }).focus();
  await expect(page.getByRole("tooltip")).toContainText("手动刷新");
  await expect(page.getByRole("tooltip")).toContainText("UTC+08:00");
  await page.clock.setSystemTime(new Date(Date.parse(capturedAt) - 10000));
  await page.clock.runFor(1000);
  await expect(stamp).toContainText("采集时间异常");
  expect(source.opened()).toBe(1);
  expect(source.inputs()).toBe(0);
});

test("drafts stay isolated by machine, workspace and pane", async ({
  page,
}) => {
  const source = await fixture(page);
  const open = async (machine: string, space: string) => {
    await page.goto(`/?machine=${machine}`);
    await page
      .getByRole("button", { name: `查看 ${space}`, exact: true })
      .click();
  };
  const input = page.getByLabel("发送到当前 Pane");
  await open("one", "Build Workspace");
  await input.fill("machine one first pane");
  await page.getByRole("combobox", { name: "当前终端" }).click();
  await page
    .getByRole("option", { name: "Terminal 1-2 · w1:p2", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await input.fill("machine one second pane");
  await page.getByRole("combobox", { name: "当前终端" }).click();
  await page
    .getByRole("option", { name: "Terminal 1-1 · w1:p1", exact: true })
    .click();
  await expect(input).toHaveValue("machine one first pane");
  await open("one", "Review Workspace");
  await expect(input).toHaveValue("");
  await input.fill("review workspace draft");
  await open("two", "Build Workspace");
  await expect(input).toHaveValue("");
  await input.fill("machine two draft");
  await open("one", "Build Workspace");
  await expect(input).toHaveValue("machine one first pane");
  expect(source.inputs()).toBe(0);
});
