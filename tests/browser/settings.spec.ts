import { expect, test } from "@playwright/test";
import {
  DailySettingsSchema,
  TEMPLATE_VERSION,
} from "../../src/shared/daily.ts";

test("AI key can be saved, retained, tested and cleared without returning or persisting its plaintext", async ({
  page,
}) => {
  const key = "browser-only-test-key";
  let storedKey = "";
  let settings = {
    ...DailySettingsSchema.parse({
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

test("settings loads from sidebar, saves daily enablement and explains missing AI without storing credentials", async ({
  page,
  isMobile,
}) => {
  let settings = {
    ...DailySettingsSchema.parse({}),
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
  await expect(
    page.getByText("北京时间每天 23:59 启动，每台机器一天一份。", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("combobox", { name: "生成间隔" })).toHaveCount(0);
  const enabled = page.getByRole("switch", { name: "自动生成报告" });
  await enabled.click();
  await page.getByRole("button", { name: "保存设置", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "已保存", exact: true }),
  ).toBeVisible();
  expect(settings.enabled).toBe(false);
  await page.reload();
  await expect(enabled).not.toBeChecked();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(
    "apiKey",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

const dailyReport = {
  machineId: "mac-studio",
  machineName: "Mac Studio",
  date: "2026-09-19",
  timezone: "Asia/Shanghai",
  cutoff: "2026-09-19T15:59:00.000Z",
  generatedAt: "2026-09-19T16:01:00.000Z",
  templateVersion: TEMPLATE_VERSION,
  model: "test-model",
  provider: "custom",
  snapshots: 120,
  semanticRecords: 24,
  inputHash: "hash",
  coverage: Array.from({ length: 24 }, (_, hour) => ({
    hour,
    snapshots: hour === 9 ? 120 : 0,
    semanticRecords: hour === 9 ? 24 : 0,
    inputRecords: hour === 9 ? 50 : 0,
    retainedRecords: hour === 9 ? 5 : 0,
    omittedRecords: hour === 9 ? 45 : 0,
    excerptedRecords: 0,
    firstObservedAt: null,
    lastObservedAt: null,
  })),
  content: {
    overview: "今日完成接口集成，生产部署仍待核实。",
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      summary: hour === 9 ? "完成接口集成，部署待核实。" : "无采集数据。",
      evidenceIds: hour === 9 ? ["H09-F1"] : [],
    })),
    nextSteps: ["核对生产部署。"],
  },
};

test("daily history shows 24 compact hour rows, preserves expansion and paginates by date", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { machines: [], entries: [] } }),
  );
  let reads = 0;
  await page.route("**/api/v1/daily-reports?**", (route) => {
    reads++;
    const next = new URL(route.request().url()).searchParams.has("before");
    return route.fulfill({
      json: {
        entries: [
          {
            seq: next ? 2 : 1,
            report: {
              ...dailyReport,
              date: next ? "2026-09-18" : "2026-09-19",
            },
          },
        ],
        nextCursor: next ? null : "2026-09-19|1",
      },
    });
  });
  await page.goto("/history");
  const card = page.getByRole("article", {
    name: "Mac Studio 2026-09-19 日报",
  });
  await expect(card).toContainText("120 次采集");
  await expect(card).toContainText("23:59");
  if ((page.viewportSize()?.width ?? 1000) < 600) {
    const bounds = await card.boundingBox();
    const action = await card
      .getByRole("button", { name: "展开报告" })
      .boundingBox();
    expect((action?.y ?? 0) - (bounds?.y ?? 0)).toBeLessThan(40);
  }
  await card.getByRole("button", { name: "展开报告" }).click();
  await expect(card.locator(".daily-hour")).toHaveCount(24);
  await expect(card).toContainText("09:00");
  await expect(card).toContainText("23:00");
  await expect(card).toContainText("抽样");
  await card.evaluate((node) =>
    node.setAttribute("data-continuity", "original"),
  );
  await page.getByRole("button", { name: "刷新日报" }).click();
  await expect.poll(() => reads).toBe(2);
  await expect(card).toHaveAttribute("data-continuity", "original");
  await expect(card.locator(".daily-hour")).toHaveCount(24);
  await page.getByRole("button", { name: "加载更多日报" }).click();
  await expect(page.getByRole("article")).toHaveCount(2);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("daily failures show a manual retry and refresh the persisted result", async ({
  page,
}) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { machines: [], entries: [] } }),
  );
  let complete = false;
  await page.route("**/api/v1/daily-reports?**", (route) =>
    route.fulfill({
      json: {
        entries: [],
        jobs: [
          {
            machineId: "mbp",
            machineName: "MBP",
            date: "2026-09-21",
            status: complete ? "complete" : "failed",
            attempts: 1,
            stage: "model",
            error: complete ? null : "invalid_output",
            lastAttemptAt: "2026-09-21T15:59:00Z",
            lastSuccessAt: complete ? "2026-09-21T16:01:00Z" : null,
          },
        ],
        nextCursor: null,
      },
    }),
  );
  await page.route("**/api/v1/daily-reports/run", (route) => {
    expect(route.request().postDataJSON()).toEqual({
      machine: "mbp",
      date: "2026-09-21",
    });
    complete = true;
    return route.fulfill({ json: { results: [{ generated: true }] } });
  });
  await page.goto("/history");
  const state = page.getByRole("region", { name: "报告生成状态" });
  await expect(state).toContainText("格式或长度校验失败");
  await state.getByRole("button", { name: "重试日报" }).click();
  await expect(state).toHaveCount(0);
  await expect(state.getByRole("button", { name: "重试日报" })).toHaveCount(0);
});

test.describe("daily history filter", () => {
  test.use({ timezoneId: "America/Los_Angeles" });
  for (const theme of ["dark", "light"] as const) {
    test(`${theme} calendar uses the Beijing date regardless of display timezone`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(new Date("2026-09-20T00:30:00Z"));
      await page.addInitScript(
        (mode) => localStorage.setItem("theme", mode),
        theme,
      );
      await page.route("**/api/**", (route) =>
        route.fulfill({ json: { machines: [], entries: [] } }),
      );
      let query = new URLSearchParams();
      await page.route("**/api/v1/daily-reports?**", (route) => {
        query = new URL(route.request().url()).searchParams;
        return route.fulfill({ json: { entries: [], nextCursor: null } });
      });
      await page.goto("/history?machine=mac-one");
      const date = page.getByRole("button", { name: /^报告日期/ });
      const clear = page.getByRole("button", { name: "清除时间筛选" });
      await expect(clear).toBeDisabled();
      await expect(
        page.getByRole("combobox", { name: "报告小时" }),
      ).toHaveCount(0);
      await date.click();
      const calendar = page.getByRole("dialog", { name: "选择报告日期" });
      await expect(calendar).toBeVisible();
      const color = await calendar.evaluate(
        (node) => getComputedStyle(node).backgroundColor,
      );
      for (const channel of color.match(/\d+/g)?.map(Number) ?? []) {
        if (theme === "dark") expect(channel).toBeLessThan(100);
        else expect(channel).toBeGreaterThan(200);
      }
      const bounds = await calendar.boundingBox();
      expect(bounds?.x).toBeGreaterThanOrEqual(0);
      expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(
        await page.evaluate(() => innerWidth),
      );
      await expect(
        calendar.getByRole("button", { name: "2026-09-20", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.press("Enter");
      await expect.poll(() => query.get("date")).toBe("2026-09-19");
      expect(query.get("machine")).toBe("mac-one");
      await clear.click();
      await expect.poll(() => query.has("date")).toBe(false);
      await expect(clear).toBeDisabled();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    });
  }
});
