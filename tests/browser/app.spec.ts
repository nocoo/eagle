import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import pkg from "../../package.json" with { type: "json" };
import { report, telemetry } from "../fixtures.ts";

// Workspace sheets now open realtime by default. Keep these task/overview
// fixtures isolated from any actual local Worker behind the dev proxy.
test.beforeEach(async ({ page }) => {
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    ws.send(JSON.stringify({ type: "status", online: false, control: false }));
  });
});

test("global overview summarizes the fleet and opens only the selected machine", async ({
  page,
  isMobile,
}) => {
  const now = new Date().toISOString();
  const machines = ["One", "Two"].map((name) => {
    const value = report(`fleet-${name}`, now);
    value.spaces[0].name = `${name} Space`;
    return {
      id: name.toLowerCase(),
      name: `Mac ${name}`,
      report: value,
      lastSeen: now,
      receivedAt: now,
      warning: null,
    };
  });
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now, machines } }),
  );
  await page.goto("/");
  await expect(page.getByRole("region", { name: "全部机器" })).toBeVisible();
  await expect(page.getByText("2/2 台机器在线")).toBeVisible();
  await expect(page.locator(".space-card")).toHaveCount(0);
  await expect(page.getByLabel("搜索 Space")).toHaveCount(0);
  const card = page.locator(".fleet-machine").first();
  await card.evaluate((node) =>
    node.setAttribute("data-continuity", "original"),
  );
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(card).toHaveAttribute("data-continuity", "original");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await expect(page.locator(".space-card")).toHaveCount(1);
  await expect(page.locator(".space-card")).toContainText("One Space");
  await expect(page.getByRole("region", { name: "当前工作态势" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("region", { name: "机器资源" })).toBeVisible();
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await page.getByRole("button", { name: "全局总览", exact: true }).click();
  await expect(page.locator(".fleet-machine")).toHaveCount(2);
  await expect(page.locator(".space-card")).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("live overview reads only current state and keeps cards mounted through refresh and failures", async ({
  page,
}) => {
  let revision = 1;
  let fail = false;
  let release: (() => void) | undefined;
  let paused: Promise<void> | undefined;
  let historyReads = 0;
  const value = report("do-snapshot", new Date().toISOString());
  await page.route("**/api/**", async (route) => {
    if (route.request().url().includes("history")) historyReads++;
    await paused;
    if (fail) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({
      json: {
        now: new Date().toISOString(),
        pendingMachines: [],
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            revision,
            changedAt: value.capturedAt,
            changes: ["Eagle：任务已更新"],
            lastSeen: value.capturedAt,
            receivedAt: value.capturedAt,
            warning: null,
            report: { ...value, reportId: `do-${revision}` },
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  const card = page.locator(".space-card").first();
  await expect(card).toBeVisible();
  await expect(page.getByText("Eagle：任务已更新")).toBeVisible();
  expect(historyReads).toBe(0);
  await page
    .locator(".dashboard-content")
    .evaluate((node) =>
      Promise.all(node.getAnimations().map((animation) => animation.finished)),
    );
  await card.evaluate((node) =>
    node.setAttribute("data-continuity", "original"),
  );
  // Move off any hovered card and settle its lift before measuring refresh.
  await page.getByRole("button", { name: "刷新", exact: true }).hover();
  await page.getByRole("button", { name: "刷新", exact: true }).focus();
  await card.evaluate((node) =>
    Promise.all(node.getAnimations().map((animation) => animation.finished)),
  );
  const before = await card.boundingBox();
  paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(card).toHaveAttribute("data-continuity", "original");
  await expect(
    page.getByRole("status", { name: "正在同步工作空间" }),
  ).toHaveCount(0);
  await expect(card).toHaveCSS("opacity", "1");
  revision++;
  release?.();
  await expect(
    page.getByRole("button", { name: "刷新", exact: true }),
  ).toBeEnabled();
  await expect(card).toHaveAttribute("data-continuity", "original");
  expect(await card.boundingBox()).toEqual(before);
  fail = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("连接中断");
  await expect(card).toHaveAttribute("data-continuity", "original");
  expect(historyReads).toBe(0);
});

test("machine resources and named TCP ports show freshness and missing data honestly", async ({
  page,
  isMobile,
}) => {
  const now = new Date().toISOString();
  const snapshot = telemetry(now);
  const value = report("resources", now);
  let stale = false;
  let legacy = false;
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now: new Date().toISOString(),
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            lastSeen: now,
            receivedAt: now,
            warning: null,
            report: {
              ...value,
              machine: {
                ...value.machine,
                ...(!legacy && {
                  telemetry: {
                    ...snapshot,
                    observedAt: stale
                      ? new Date(Date.now() - 600000).toISOString()
                      : now,
                    ports: snapshot.ports.map((port) => ({
                      ...port,
                      checkedAt: stale
                        ? new Date(Date.now() - 600000).toISOString()
                        : now,
                    })),
                  },
                }),
              },
            },
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  const resources = page.getByRole("region", { name: "机器资源" });
  await expect(resources).toContainText("25%");
  await expect(resources).toContainText("12 / 16 GiB");
  await expect(resources).toContainText("200 GiB");
  await expect(resources).toContainText("Raven");
  await expect(resources).toContainText("7024");
  await expect(resources.getByText("可连接", { exact: true })).toBeVisible();
  const resourceBox = await resources.boundingBox();
  const cardBox = await page.locator(".space-card").first().boundingBox();
  const islandBox = await page.locator("#eagle-content").boundingBox();
  const pulseBox = await page
    .getByRole("heading", { name: "运行脉搏", exact: false })
    .boundingBox();
  expect(resourceBox).not.toBeNull();
  expect(cardBox).not.toBeNull();
  expect(pulseBox).not.toBeNull();
  if (!resourceBox || !cardBox || !pulseBox || !islandBox)
    throw new Error("Missing dashboard regions");
  expect(resourceBox.y + resourceBox.height).toBeLessThan(pulseBox.y);
  if (isMobile) {
    expect(resourceBox.y).toBeLessThan(cardBox.y);
  } else {
    expect(resourceBox.x).toBeGreaterThan(cardBox.x + cardBox.width);
    expect(cardBox.y - islandBox.y).toBeLessThan(190);
  }
  stale = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(resources).toContainText("历史快照");
  await expect(resources.getByText("可连接", { exact: true })).toHaveCount(0);
  await expect(resources).toContainText("上次可连接");
  legacy = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(resources).toContainText("尚未上报机器资源");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("narrow desktop layouts keep three-pane topology controls readable", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const value = report("narrow-topology", now);
  const pane = value.spaces[0].tabs[0].panes[0];
  value.spaces[0].tabs[0].panes = ["codex", "grok", "terminal"].map(
    (agent, i) => ({
      ...pane,
      id: `w1:p${i + 1}`,
      agent,
      rect: { x: i / 3, y: 0, width: 1 / 3, height: 1 },
    }),
  );
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            report: value,
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  for (const width of [520, 768, 1024]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/?machine=mac-one");
    await expect(page.locator(".pane-button")).toHaveCount(3);
    for (const button of await page.locator(".pane-button").all()) {
      expect((await button.boundingBox())?.width).toBeGreaterThanOrEqual(44);
      expect(
        await button.evaluate(
          (node) => node.scrollWidth <= node.clientWidth + 1,
        ),
      ).toBe(true);
    }
  }
});

test("token-free overview, topology evidence, history and empty search", async ({
  page,
}) => {
  const value = report("browser-report", new Date().toISOString());
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes("history"))
      return route.fulfill({
        json: {
          entries: [
            {
              seq: 1,
              report: value,
              receivedAt: value.capturedAt,
              changes: ["首次接入：Eagle"],
            },
          ],
          nextCursor: null,
        },
      });
    return route.fulfill({
      json: {
        now: new Date().toISOString(),
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            lastSeen: new Date().toISOString(),
            receivedAt: value.capturedAt,
            warning: null,
            changes: ["首次接入：Eagle"],
            changedAt: value.capturedAt,
            revision: 1,
            report: value,
          },
        ],
      },
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Space 拓扑" })).toBeVisible();
  await page.getByRole("button", { name: "筛选进行中" }).click();
  await expect(page.getByText("没有匹配的 Space")).toBeVisible();
  await page.getByRole("button", { name: "筛选全部" }).click();
  await expect(page.getByRole("heading", { name: "当前态势" })).toHaveCount(0);
  await expect(page.getByText("待核实", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "最近变化" })).toBeVisible();
  await expect(page.getByText("首次接入：Eagle").first()).toBeVisible();
  for (const button of await page.locator(".evidence-strip button").all()) {
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(28);
    expect(
      await button.evaluate((node) =>
        Number.parseFloat(getComputedStyle(node).paddingLeft),
      ),
    ).toBeGreaterThanOrEqual(4);
  }
  await page.getByRole("button", { name: "查看 Eagle" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect(page.getByText("Herdr 弱提示：done")).toBeVisible();
  await expect(page.getByText(/待补充或核对/).first()).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("搜索 Space").fill("no-such-space");
  await expect(page.getByText("没有匹配的 Space")).toBeVisible();
  await page.getByLabel("搜索 Space").clear();
  await page.getByRole("button", { name: "查看最近历史" }).click();
  await expect(page.getByText("首次接入：Eagle").first()).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "test-token",
  );
});

test("failed refresh clearly preserves last known data and does not imply live success", async ({
  page,
}) => {
  let fail = false;
  await page.route("**/api/**", (route) => {
    if (fail)
      return route.fulfill({ status: 503, json: { error: "unavailable" } });
    return route.fulfill({
      json: { now: new Date().toISOString(), machines: [] },
    });
  });
  await page.goto("/");
  await expect(page.getByText("等待第一台机器接入")).toBeVisible();
  fail = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("连接中断");
  await expect(page.locator(".sync-caption")).toContainText(
    "连接中断 · 保留上次快照",
  );
  await expect(page.locator(".sync-caption")).not.toContainText("已同步");
});

test("stale machine data is marked explicitly", async ({ page }) => {
  const value = report("stale", new Date(Date.now() - 600_000).toISOString());
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now: new Date().toISOString(),
        machines: [
          {
            id: "mac-one",
            name: "Old Mac",
            lastSeen: value.capturedAt,
            receivedAt: value.capturedAt,
            report: value,
            warning: null,
          },
        ],
      },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "打开机器 Old Mac" }).click();
  await expect(page.getByText("心跳过期", { exact: true })).toBeVisible();
  await expect(page.getByText("历史快照 · 等待重新采集")).toBeVisible();
});

test("sidebar machine lights distinguish heartbeat and snapshot freshness across layouts and refresh", async ({
  page,
  isMobile,
}) => {
  const now = new Date().toISOString();
  const old = new Date(Date.now() - 600_000).toISOString();
  const machines = [
    { id: "online", name: "Online Mac", lastSeen: now, capturedAt: now },
    { id: "stale", name: "Stale Mac", lastSeen: now, capturedAt: old },
    { id: "offline", name: "Offline Mac", lastSeen: old, capturedAt: now },
  ].map(({ capturedAt, ...machine }) => ({
    ...machine,
    report: report(machine.id, capturedAt),
    receivedAt: now,
    warning: null,
  }));
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now, machines } }),
  );
  await page.goto("/");
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  const nav = page.getByRole("navigation", { name: "工作台导航" });
  const online = nav.getByRole("button", { name: "Online Mac", exact: true });
  const stale = nav.getByRole("button", { name: "Stale Mac", exact: true });
  const offline = nav.getByRole("button", { name: "Offline Mac", exact: true });
  await expect(online).toHaveAccessibleDescription("在线");
  await expect(stale).toHaveAccessibleDescription("采集过期");
  await expect(offline).toHaveAccessibleDescription("离线 · 心跳过期");
  const colors: string[] = [];
  for (const item of [online, stale, offline]) {
    const dot = item.locator(".machine-status-dot");
    await expect(dot).toBeVisible();
    await expect(dot).not.toHaveCSS("box-shadow", "none");
    colors.push(
      await dot.evaluate((node) => getComputedStyle(node).backgroundColor),
    );
    const itemBox = await item.boundingBox();
    const dotBox = await dot.boundingBox();
    if (!itemBox || !dotBox)
      throw new Error("Machine item and light must be visible");
    expect(dotBox.x).toBeGreaterThan(itemBox.x + itemBox.width / 2);
    expect(dotBox.x + dotBox.width).toBeLessThan(itemBox.x + itemBox.width);
  }
  expect(new Set(colors).size).toBe(3);
  await page.getByRole("button", { name: "收起导航" }).click();
  if (!isMobile) {
    await expect(online.locator(".machine-status-dot")).toBeVisible();
    await offline.focus();
    await expect(page.getByRole("tooltip")).toContainText(
      "Offline Mac · 离线 · 心跳过期",
    );
    await page.keyboard.press("Escape");
    await online.click();
    await expect(page).toHaveURL(/machine=online/);
  }
  // Reconnection updates the existing item instead of flashing a replacement.
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await offline
    .locator(".machine-status-dot")
    .evaluate((node) => node.setAttribute("data-continuity", "original"));
  machines[2].lastSeen = now;
  if (isMobile) await page.getByRole("button", { name: "收起导航" }).click();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await expect(offline).toHaveAccessibleDescription("在线");
  if (!isMobile)
    await expect(offline.locator(".machine-status-dot")).toHaveAttribute(
      "data-continuity",
      "original",
    );
  await expect(offline.locator(".machine-status-dot")).toHaveCSS(
    "background-color",
    colors[0],
  );
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(online.locator(".machine-status-dot")).toHaveCSS(
    "transition-duration",
    "0s",
  );
});

test("sidebar machine lights expire when overview requests fail", async ({
  page,
  isMobile,
}) => {
  const now = new Date();
  await page.clock.install({ time: now });
  let fail = false;
  await page.route("**/api/**", (route) =>
    fail
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({
          json: {
            now: now.toISOString(),
            machines: [
              {
                id: "mac",
                name: "Cached Mac",
                lastSeen: now.toISOString(),
                receivedAt: now.toISOString(),
                warning: null,
                report: report("cached", now.toISOString()),
              },
            ],
          },
        }),
  );
  await page.goto("/");
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  const item = page.getByRole("button", { name: "Cached Mac", exact: true });
  await expect(item).toHaveAccessibleDescription("在线");
  fail = true;
  await page.clock.fastForward(95_000);
  await expect(item).toHaveAccessibleDescription("离线 · 心跳过期");
  await expect(item.locator(".machine-status-dot")).toBeVisible();
});

test("adopted eagle mark and family links work in both sidebar states", async ({
  page,
  isMobile,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.goto("/");
  await expect(page.getByText("等待第一台机器接入")).toBeVisible();
  const github = page.getByRole("link", {
    name: "Eagle GitHub 仓库（新标签页）",
  });
  const hexly = page.getByRole("link", {
    name: "在 hexly.ai 查看 Eagle（新标签页）",
  });
  await expect(github).toHaveAttribute(
    "href",
    "https://github.com/nocoo/eagle",
  );
  await expect(hexly).toHaveAttribute(
    "href",
    "https://hexly.ai/projects/eagle",
  );
  await expect(hexly).toHaveAttribute("target", "_blank");
  await hexly.focus();
  await expect(page.getByRole("tooltip")).toContainText(
    "在 hexly.ai 查看 Eagle",
  );
  await page.keyboard.press("Escape");
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await expect(page.getByRole("button", { name: "收起导航" })).toBeVisible();
  const mark = page.locator("img[data-eagle-mark]").last();
  await expect(mark).toBeVisible();
  await mark.evaluate((node) => (node as HTMLImageElement).decode());
  expect(
    await mark.evaluate(
      (node) =>
        (node as HTMLImageElement).complete &&
        (node as HTMLImageElement).naturalWidth > 0,
    ),
  ).toBe(true);
  expect(
    await mark.evaluate((node) => getComputedStyle(node).borderRadius),
  ).toBe("0px");
  const expandedMark = await mark.boundingBox();
  await page.getByRole("button", { name: "收起导航" }).click();
  if (!isMobile) {
    await expect(mark).toBeVisible();
    await expect.poll(() => mark.boundingBox()).toEqual(expandedMark);
    const toggle = page.getByRole("button", { name: "展开导航" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect.poll(() => mark.boundingBox()).toEqual(expandedMark);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("sidebar profile shows service avatar and Access logout in expanded and collapsed layouts", async ({
  page,
  isMobile,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: {
        name: "Li Zheng",
        email: "viewer@example.test",
        avatar: "https://images.example.test/avatar.svg",
        local: false,
      },
    }),
  );
  await page.route("https://images.example.test/avatar.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20" fill="blue"/></svg>',
    }),
  );
  await page.route("**/cdn-cgi/access/logout", (route) =>
    route.fulfill({ body: "Signed out" }),
  );
  await page.goto("/");
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await expect(page.getByText("Li Zheng", { exact: true })).toBeVisible();
  await expect(
    page.getByText("viewer@example.test", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Li Zheng 的头像" }),
  ).toBeVisible();
  if (!isMobile) {
    await page.getByRole("button", { name: "收起导航" }).click();
    await expect(
      page.getByRole("img", { name: "Li Zheng 的头像" }),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page).toHaveURL(/\/cdn-cgi\/access\/logout$/);
});

test("local sidebar preserves logout chrome without inventing a login session", async ({
  page,
  isMobile,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.route("**/api/v1/me", (route) =>
    route.fulfill({
      json: { name: "本地开发", email: "", avatar: null, local: true },
    }),
  );
  await page.goto("/");
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await expect(page.getByText("本地开发", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("本地免登录", { exact: true })).toBeVisible();
});

test("deployment image policy allows HTTPS author-service avatars", async ({
  page,
}) => {
  const policy = readFileSync("public/_headers", "utf8")
    .split("\n")
    .find((line) => line.trim().startsWith("Content-Security-Policy:"))
    ?.trim()
    .slice("Content-Security-Policy:".length)
    .trim();
  expect(policy).toBeTruthy();
  await page.route("**/avatar-policy-check", (route) =>
    route.fulfill({
      contentType: "text/html",
      headers: { "Content-Security-Policy": policy as string },
      body: '<img alt="Profile" src="https://images.example.test/profile.svg">',
    }),
  );
  await page.route("https://images.example.test/profile.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><circle cx="20" cy="20" r="20"/></svg>',
    }),
  );
  await page.goto("/avatar-policy-check");
  await expect(page.getByRole("img", { name: "Profile" })).toHaveJSProperty(
    "naturalWidth",
    40,
  );
});

test("first load shows a stable skeleton and Access expiry offers SSO without a token field", async ({
  page,
}) => {
  let finish: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    finish = resolve;
  });
  await page.route("**/api/**", async (route) => {
    await ready;
    await route.fulfill({ status: 401, json: { error: "Access required" } });
  });
  await page.goto("/");
  await expect(
    page.getByRole("status", { name: "正在同步工作空间" }),
  ).toBeVisible();
  finish();
  await expect(
    page.getByRole("button", { name: "通过 Cloudflare Access 继续" }),
  ).toBeVisible();
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);
});

test("attention is shown first and reduced-motion users get no entrance animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const value = report("priority", new Date().toISOString());
  const urgent = structuredClone(value.spaces[0]);
  urgent.id = "default:w2";
  urgent.name = "Urgent";
  urgent.tabs[0].panes[0].evidence.push({
    kind: "test",
    status: "failure",
    summary: "Production regression",
    source: "test",
    observedAt: value.capturedAt,
    taskId: "task-1",
  });
  value.spaces.push(urgent);
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("history")
        ? { entries: [], nextCursor: null }
        : {
            now: value.capturedAt,
            machines: [
              {
                id: "mac-one",
                name: "Mac One",
                lastSeen: value.capturedAt,
                receivedAt: value.capturedAt,
                warning: null,
                report: value,
              },
            ],
          },
    }),
  );
  await page.goto("/");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await expect(page.locator(".space-card h3").first()).toHaveText("Urgent");
  expect(
    await page
      .locator(".space-card")
      .first()
      .evaluate((element) => getComputedStyle(element).animationName),
  ).toBe("none");
});

test("Connect manages machines and creates a one-time onboarding prompt without browser persistence", async ({
  page,
}) => {
  let machines: {
    id: string;
    name: string;
    enabled: boolean;
    source: string;
    expiresAt: string;
  }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/machines" && request.method() === "GET")
      return route.fulfill({ json: { machines, canIssue: true } });
    if (path === "/api/v1/machines") {
      machines = [
        {
          ...request.postDataJSON(),
          enabled: true,
          source: "managed",
          expiresAt: "2027-09-19T00:00:00Z",
        },
      ];
      return route.fulfill({
        status: 201,
        json: {
          machine: machines[0],
          token: "eag1.test-only-never-persisted-token",
        },
      });
    }
    if (path.endsWith("/revoke")) {
      machines[0].enabled = false;
      return route.fulfill({ json: { machine: machines[0] } });
    }
    return route.fulfill({
      json: {
        now: new Date().toISOString(),
        machines: [],
        pendingMachines: [],
      },
    });
  });
  await page.goto("/connect");
  await expect(page.getByRole("heading", { name: "添加机器" })).toBeVisible();
  await page.getByLabel("机器名称", { exact: true }).fill("Studio Mac");
  await page.getByLabel("机器 ID", { exact: true }).fill("studio-mac");
  await page.getByLabel("关注端口", { exact: true }).fill("Raven:7024");
  await page.getByRole("button", { name: "创建并生成提示词" }).click();
  await expect(page.getByRole("heading", { name: "接入提示词" })).toBeVisible();
  await expect(page.getByLabel("提示词预览")).toContainText(
    `npm install -g @nocoo/eagle-agent@${pkg.version} --registry=https://registry.npmjs.org`,
  );
  await expect(page.getByLabel("提示词预览")).toContainText(
    `npm install -g @nocoo/eagle-agent@${pkg.version} --registry=https://mirrors.cloud.tencent.com/npm/`,
  );
  await expect(page.getByLabel("提示词预览")).toContainText("首选腾讯云镜像");
  await expect(page.getByLabel("提示词预览")).toContainText("默认直连");
  await expect(page.getByLabel("提示词预览")).toContainText(
    "NODE_USE_ENV_PROXY=1",
  );
  await expect(page.getByLabel("提示词预览")).toContainText("HTTPS_PROXY");
  await expect(page.getByLabel("提示词预览")).not.toContainText(
    "127.0.0.1:7890",
  );
  await expect(page.getByLabel("提示词预览")).toContainText(
    "eagle-agent --version",
  );
  await expect(page.getByLabel("提示词预览")).toContainText("7024");
  await expect(page.getByLabel("提示词预览")).not.toContainText(
    "eag1.test-only",
  );
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  const copyButton = page.getByRole("button", {
    name: "复制完整提示词",
    exact: true,
  });
  const copyWidth = (await copyButton.boundingBox())?.width;
  await copyButton.click();
  const copiedButton = page.getByRole("button", {
    name: "已复制提示词",
    exact: true,
  });
  await expect(copiedButton).toBeVisible();
  expect((await copiedButton.boundingBox())?.width).toBe(copyWidth);
  await page.getByRole("button", { name: "仅复制 Token", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已复制 Token", exact: true }),
  ).toBeVisible();
  await expect(copyButton).toBeVisible();
  await expect(
    page.getByRole("button", { name: "仅复制 Token", exact: true }),
  ).toBeVisible({ timeout: 5000 });
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("eag1.");
  await page.getByRole("button", { name: "关闭提示词" }).click();
  await page.getByRole("button", { name: "停用 Studio Mac" }).click();
  await page.getByRole("button", { name: "确认停用" }).click();
  await expect(page.getByText("已停用", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重新启用 Studio Mac" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "接入提示词" })).toHaveCount(
    0,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("Connect rename actions keep a single text line and leave room for the input", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === "/api/v1/machines"
          ? {
              canIssue: true,
              machines: [
                {
                  id: "mac-one",
                  name: "Mac One",
                  enabled: true,
                  source: "managed",
                },
              ],
            }
          : { now: new Date().toISOString(), machines: [] },
    }),
  );
  await page.goto("/connect");
  await page.getByRole("button", { name: "重命名", exact: true }).click();
  const input = page.getByRole("textbox", { name: "新的机器名称" });
  expect((await input.boundingBox())?.width).toBeGreaterThanOrEqual(120);
  for (const name of ["保存", "取消"]) {
    const button = page.getByRole("button", { name, exact: true });
    const geometry = await button.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const text = range.getBoundingClientRect();
      const box = node.getBoundingClientRect();
      return {
        textHeight: text.height,
        lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
        left: text.left - box.left,
        right: box.right - text.right,
      };
    });
    expect(geometry.textHeight).toBeLessThanOrEqual(geometry.lineHeight + 1);
    expect(geometry.left).toBeGreaterThanOrEqual(8);
    expect(geometry.right).toBeGreaterThanOrEqual(8);
  }
});

test("Pane summary stays frozen until explicit refresh then exposes a disconnected manager", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const value = report("semantic-browser", now);
  let disconnected = false;
  const summary = {
    spaceId: "default:w1",
    paneId: "w1:p1",
    taskId: "task-1",
    basis: [],
    observedAt: now,
    updatedAt: now,
    checkedAt: now,
    receivedAt: now,
    sequence: 1,
    evidence: [],
    summary: {
      task: "让每个 Pane 可读",
      phase: "verify",
      progress: "实时摘要已经连通",
      outcomes: [
        { kind: "test", text: "终端声称测试通过，待核对", evidenceRefs: [] },
      ],
      blocker: null,
      nextStep: "核验生产链路",
      rationale: "参考当前终端，缺少测试独立回执",
      evidenceRefs: [],
    },
  };
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: route.request().url().includes("semantic-hours")
        ? {
            hours: [
              {
                hour: `${now.slice(0, 13)}:00:00.000Z`,
                count: 1,
                latest: {
                  seq: 1,
                  receivedAt: now,
                  source: { managerId: "cherry", protocolVersion: 1 },
                  contentHash: "a".repeat(64),
                  value: {
                    ...summary,
                    summary: {
                      ...summary.summary,
                      progress: "此前完成协议设计",
                    },
                  },
                },
              },
            ],
            nextCursor: null,
          }
        : {
            now,
            machines: [
              {
                id: "mac-one",
                name: "Mac One",
                lastSeen: now,
                receivedAt: now,
                warning: null,
                report: value,
                summaries: [summary],
                manager: {
                  id: "cherry",
                  sequence: 1,
                  lastSeen: disconnected ? "2020-01-01T00:00:00.000Z" : now,
                },
              },
            ],
          },
    }),
  );
  await page.goto("/?machine=mac-one");
  await page.getByRole("button", { name: "查看 Eagle" }).click();
  const panel = page.getByRole("region", { name: "Pane 实时总结" });
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect(panel).toContainText("实时摘要已经连通");
  await expect(panel).toContainText("语义在线");
  await expect(panel).toContainText("核验生产链路");
  await expect(panel).toContainText("未独立验证");
  await expect(page.getByText("此前完成协议设计")).toBeVisible();
  await panel.evaluate((node) => node.setAttribute("data-continuity", "same"));
  disconnected = true;
  await page.waitForTimeout(6000);
  await expect(panel).toContainText("语义在线");
  await expect(panel).toHaveAttribute("data-continuity", "same");
  await page.getByRole("button", { name: "刷新当前任务", exact: true }).click();
  await expect(panel).toContainText("Manager 断连");
  await expect(panel).not.toContainText("已验证完成");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("Pane history groups UTC hours and expands every semantic record in that hour", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const value = report("hour-ui", now);
  const hour = `${now.slice(0, 13)}:00:00.000Z`;
  const semantic = {
    spaceId: "default:w1",
    paneId: "w1:p1",
    taskId: "task-1",
    basis: [],
    observedAt: now,
    updatedAt: now,
    checkedAt: now,
    receivedAt: now,
    sequence: 1,
    evidence: [],
    summary: {
      task: "小时契约",
      phase: "verify",
      progress: "这个小时的最新进展",
      outcomes: [],
      blocker: null,
      nextStep: "验证",
      rationale: "实际证据",
      evidenceRefs: [],
    },
  };
  const entry = {
    seq: 1,
    hour,
    contentHash: "a".repeat(64),
    source: { managerId: "cherry", protocolVersion: 1 },
    receivedAt: now,
    value: semantic,
  };
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      json: url.pathname.includes("semantic-hours")
        ? url.searchParams.has("hour")
          ? {
              entries: [
                entry,
                {
                  ...entry,
                  seq: 2,
                  value: {
                    ...semantic,
                    summary: {
                      ...semantic.summary,
                      progress: "该小时更早的语义记录",
                    },
                  },
                },
              ],
              nextCursor: null,
            }
          : {
              hours: [{ hour, count: 2, latest: entry }],
              nextCursor: null,
              retention: { days: 30, maxRecords: 10000 },
            }
        : url.pathname.includes("history")
          ? { entries: [], nextCursor: null }
          : {
              now,
              machines: [
                {
                  id: "mac-one",
                  name: "Mac One",
                  report: value,
                  lastSeen: now,
                  receivedAt: now,
                  warning: null,
                  summaries: [semantic],
                  manager: { id: "cherry", lastSeen: now, sequence: 1 },
                },
              ],
            },
    });
  });
  await page.goto("/?machine=mac-one");
  await page.getByRole("button", { name: "查看 Eagle" }).click();
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect(page.getByText("小时时间线 · UTC+08:00")).toBeVisible();
  await page.getByRole("button", { name: /展开.*2 条/ }).click();
  await expect(page.getByText("该小时更早的语义记录")).toBeVisible();
});
