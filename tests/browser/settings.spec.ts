import { expect, test } from "@playwright/test";
import {
  HourlySettingsSchema,
  REPORT_SECTIONS,
  TEMPLATE_VERSION,
} from "../../src/shared/hourly.ts";

test("AI key can be saved, retained, tested and cleared without returning or persisting its plaintext", async ({
  page,
}) => {
  const key = "browser-only-test-key";
  let storedKey = "";
  let settings = {
    ...HourlySettingsSchema.parse({
      provider: "custom",
      model: "test-model",
      baseURL: "https://api.ai.example/v1",
    }),
    hasApiKey: false,
    configured: false,
  };
  let tests = 0;
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "POST") {
      const { apiKey, ...config } = route.request().postDataJSON();
      if (apiKey === null) storedKey = "";
      else if (apiKey) storedKey = apiKey;
      settings = {
        ...settings,
        ...config,
        hasApiKey: !!storedKey,
        configured: !!storedKey,
      };
    }
    await route.fulfill({ json: settings });
  });
  await page.route("**/api/v1/settings/test", async (route) => {
    expect(route.request().postDataJSON().apiKey || storedKey).toBe(key);
    tests++;
    await route.fulfill({ json: { success: true } });
  });
  await page.goto("/settings");
  const input = page.getByLabel("API Key", { exact: true });
  await expect(input).toHaveAttribute("type", "password");
  await input.fill(key);
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("AI 连接成功。", { exact: true })).toBeVisible();
  expect(storedKey).toBe("");
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  expect(storedKey).toBe(key);
  await expect(input).toHaveValue("");
  await page.reload();
  await expect(input).toHaveValue("");
  await expect(input).toHaveAttribute(
    "placeholder",
    "已配置，留空保留当前密钥",
  );
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  expect(storedKey).toBe(key);
  await page.getByRole("button", { name: "测试连接", exact: true }).click();
  await expect(page.getByText("AI 连接成功。", { exact: true })).toBeVisible();
  expect(tests).toBe(2);
  await page.getByRole("combobox", { name: "接口协议" }).click();
  await page
    .getByRole("option", { name: "Anthropic Messages", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "测试连接", exact: true }),
  ).toBeDisabled();
  await expect(input).toHaveAttribute("placeholder", "输入服务商密钥");
  await input.fill(key);
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      JSON.stringify({ local: localStorage, session: sessionStorage }),
    ),
  ).not.toContain(key);
  await page.getByRole("button", { name: "清除密钥", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  expect(storedKey).toBe("");
  await expect(
    page.getByRole("button", { name: "测试连接", exact: true }),
  ).toBeDisabled();
});

test("settings loads from sidebar, saves hourly cadence and explains missing AI without storing credentials", async ({
  page,
  isMobile,
}) => {
  let settings = {
    ...HourlySettingsSchema.parse({}),
    hasApiKey: false,
    configured: false,
  };
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.route("**/api/v1/settings", async (route) => {
    if (route.request().method() === "POST")
      settings = { ...settings, ...route.request().postDataJSON() };
    await route.fulfill({ json: settings });
  });
  await page.goto("/overview");
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    page.getByText("未配置 AI，自动跳过报告生成。", { exact: true }),
  ).toBeVisible();
  const cadence = page.getByRole("combobox", { name: "生成间隔" });
  await expect(cadence).toContainText("1 小时");
  await cadence.click();
  await page.getByRole("option", { name: "2 小时", exact: true }).click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  expect(settings.intervalHours).toBe(2);
  await page.reload();
  await expect(cadence).toContainText("2 小时");
  for (const title of Object.values(REPORT_SECTIONS))
    await expect(page.getByText(title, { exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "apiKey",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("history expands a persisted Chinese hourly report and keeps it mounted during refresh", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: { now: new Date().toISOString(), machines: [], entries: [] },
    }),
  );
  await page.route("**/api/v1/hourly-reports?**", (route) =>
    route.fulfill({
      json: {
        entries: [
          {
            seq: 1,
            report: {
              machineId: "mac-studio",
              machineName: "Mac Studio",
              hour: "2026-09-19T09:00:00.000Z",
              generatedAt: "2026-09-19T10:05:00.000Z",
              templateVersion: TEMPLATE_VERSION,
              model: "test-model",
              provider: "custom",
              snapshots: 120,
              semanticRecords: 24,
              inputRecords: 80,
              inputHash: "hash",
              firstObservedAt: "2026-09-19T09:00:03.000Z",
              lastObservedAt: "2026-09-19T09:59:31.000Z",
              content: {
                ...Object.fromEntries(
                  Object.keys(REPORT_SECTIONS).map((k) => [
                    k,
                    "本小时完成接口集成，生产部署仍待核实。",
                  ]),
                ),
                evidenceIds: ["F1"],
              },
            },
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.goto("/history");
  const card = page.getByRole("article", { name: "Mac Studio 小时报告" });
  await expect(card).toContainText("120 次采集");
  await card.getByRole("button", { name: "展开报告" }).click();
  for (const title of Object.values(REPORT_SECTIONS))
    await expect(
      card.getByRole("heading", { name: title, exact: true }),
    ).toBeVisible();
  await card.evaluate((node) =>
    node.setAttribute("data-continuity", "original"),
  );
  await page.getByRole("button", { name: "刷新小时报告" }).click();
  await expect(card).toHaveAttribute("data-continuity", "original");
  await expect(
    card.getByRole("heading", { name: "判断依据与数据覆盖" }),
  ).toBeVisible();
});

test("hourly history exposes missing-hour progress, retry timing and last success", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: { now: new Date().toISOString(), machines: [], entries: [] },
    }),
  );
  const jobs = [
    {
      machineId: "mbp",
      machineName: "MBP",
      hour: "2026-09-21T07:00:00.000Z",
      status: "retrying",
      attempts: 2,
      completedParts: 12,
      totalParts: 20,
      stage: "model_final",
      error: "timeout",
      lastAttemptAt: Date.parse("2026-09-21T08:05:00Z"),
      retryAt: Date.parse("2026-09-21T08:10:00Z"),
      lastSuccessAt: "2026-09-21T06:05:00.000Z",
    },
  ];
  await page.route("**/api/v1/hourly-reports?**", (route) =>
    route.fulfill({ json: { entries: [], jobs, nextCursor: null } }),
  );
  await page.goto("/history");
  const state = page.getByRole("region", { name: "报告生成状态" });
  await expect(state).toContainText("1 个小时待生成");
  await expect(state).toContainText("等待重试");
  await expect(state).toContainText("12 / 20 份材料已整理");
  await expect(state).toContainText("已尝试 2 次");
  await expect(state).toContainText("生成报告：模型响应超时");
  await expect(state).toContainText("下次重试不早于");
  await expect(state).toContainText("最近成功");
  jobs[0] = { ...jobs[0], status: "discarded", error: "", retryAt: 0 };
  await page.getByRole("button", { name: "刷新小时报告" }).click();
  await expect(state).toContainText("当前无待生成小时");
  await expect(state).toContainText("1 个小时已取消（原始数据保留）");
  await expect(state).not.toContainText("等待重试");
  jobs[0] = {
    ...jobs[0],
    status: "complete",
    error: "",
    retryAt: 0,
    lastSuccessAt: "2026-09-21T08:12:00.000Z",
  };
  await page.getByRole("button", { name: "刷新小时报告" }).click();
  await expect(state).toContainText("当前无待生成小时");
  await expect(state).not.toContainText("等待重试");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test.describe("hourly history filter", () => {
  test.use({ timezoneId: "Asia/Shanghai" });

  for (const theme of ["dark", "light"] as const) {
    test(`${theme} calendar and hour menu follow the theme and filter the correct UTC bucket`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date("2026-09-20T04:00:00Z"));
      await page.addInitScript(
        (mode) => localStorage.setItem("theme", mode),
        theme,
      );
      await page.route("**/api/**", (route) =>
        route.fulfill({
          json: { now: new Date().toISOString(), machines: [], entries: [] },
        }),
      );
      let query = new URLSearchParams();
      await page.route("**/api/v1/hourly-reports?**", (route) => {
        query = new URL(route.request().url()).searchParams;
        return route.fulfill({ json: { entries: [], nextCursor: null } });
      });
      await page.goto("/history?machine=mac-one");
      const date = page.getByRole("button", { name: /^报告日期/ });
      const hour = page.getByRole("combobox", { name: "报告小时" });
      const clear = page.getByRole("button", { name: "清除时间筛选" });
      await expect(hour).toBeDisabled();
      await expect(clear).toBeDisabled();
      await date.click();
      const calendar = page.getByRole("dialog", { name: "选择报告日期" });
      await expect(calendar).toBeVisible();
      const calendarColor = await calendar.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      const channels = calendarColor.match(/\d+/g)?.map(Number) ?? [];
      expect(channels).toHaveLength(3);
      for (const channel of channels) {
        if (theme === "dark") expect(channel).toBeLessThan(100);
        else expect(channel).toBeGreaterThan(200);
      }
      const bounds = await calendar.boundingBox();
      if (!bounds) throw new Error("Calendar is not visible");
      expect(bounds.x).toBeGreaterThanOrEqual(0);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(
        await page.evaluate(() => innerWidth),
      );
      // Keyboard navigation must retain Basalt's accessible calendar behavior.
      await expect(
        calendar.getByRole("button", { name: "2026-09-20", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await expect(
        calendar.getByRole("button", { name: "2026-09-19", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowRight");
      await page.keyboard.press("Enter");
      await expect(calendar).toBeHidden();
      await expect(date).toContainText("2026");
      await expect
        .poll(() => query.get("hour"))
        .toBe("2026-09-19T16:00:00.000Z");
      await hour.click();
      const menu = page.getByRole("listbox");
      await expect(menu).toHaveCSS("background-color", calendarColor);
      await page.getByRole("option", { name: "06:00", exact: true }).click();
      await expect
        .poll(() => query.get("hour"))
        .toBe("2026-09-19T22:00:00.000Z");
      expect(query.get("machine")).toBe("mac-one");
      await expect(hour).toContainText("06:00");
      for (const icon of [
        page.locator(".lucide-calendar-days"),
        hour.locator("svg"),
      ]) {
        await expect(icon).toBeVisible();
        const size = await icon.boundingBox();
        expect(size?.width).toBeGreaterThanOrEqual(16);
        expect(size?.height).toBeGreaterThanOrEqual(16);
        if (theme === "dark")
          await expect(icon).not.toHaveCSS("color", "rgb(0, 0, 0)");
      }
      await hour.click();
      const menuBounds = await menu.boundingBox();
      if (!menuBounds) throw new Error("Hour menu is not visible");
      expect(menuBounds.y).toBeGreaterThanOrEqual(0);
      expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(
        await page.evaluate(() => innerHeight),
      );
      await page.getByRole("option", { name: "23:00", exact: true }).click();
      await expect
        .poll(() => query.get("hour"))
        .toBe("2026-09-20T15:00:00.000Z");
      await clear.click();
      await expect.poll(() => query.has("hour")).toBe(false);
      expect(query.get("machine")).toBe("mac-one");
      await expect(date).toContainText("选择日期");
      await expect(hour).toBeDisabled();
      await expect(clear).toBeDisabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
});
