import { expect, test } from "@playwright/test";
import { MachineTelemetrySchema } from "../../src/shared/schema.ts";
import { report, telemetry } from "../fixtures.ts";

test("machine card explanations stay in accessible top-right help controls", async ({
  page,
  isMobile,
}) => {
  const now = new Date().toISOString();
  const snapshot = report("card-help", now);
  snapshot.machine.telemetry = MachineTelemetrySchema.parse({
    ...telemetry(now),
    resources: { ...telemetry(now).resources, loadAverage: [1, 2, 3] },
    sampleIntervalSeconds: 30,
    slowIntervalSeconds: 300,
  });
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: new URL(route.request().url()).pathname.endsWith("/resources")
        ? { retentionSeconds: 86400, samples: [] }
        : {
            now,
            machines: [
              {
                id: "mac-one",
                name: "Synthetic machine",
                report: snapshot,
                lastSeen: now,
                receivedAt: now,
                warning: null,
              },
            ],
          },
    }),
  );
  await page.goto("/?machine=mac-one");
  for (const [card, label, explanation] of [
    [".environment-status", "环境状态说明", "网络表示系统路径"],
    [".resource-history", "资源时间序列说明", "磁盘不入图"],
    [".activity-card", "最近变化说明", "各机器最近一次任务或拓扑变化"],
    [".coverage-card", "证据覆盖说明", "覆盖表示存在记录"],
  ]) {
    const container = page.locator(card);
    await expect(container).not.toContainText(explanation);
    const help = container.getByRole("button", { name: label, exact: true });
    await expect(help).toBeVisible();
    await help.scrollIntoViewIfNeeded();
    const bounds = await container.boundingBox();
    const trigger = await help.boundingBox();
    expect(
      bounds && trigger && bounds.x + bounds.width - trigger.x - trigger.width,
    ).toBeLessThan(25);
    expect(bounds && trigger && trigger.y - bounds.y).toBeLessThan(25);
    if (isMobile) await help.tap();
    else await help.hover();
    await expect(page.getByRole("tooltip")).toContainText(explanation);
    await page.keyboard.press("Escape");
    await help.blur();
    await page.mouse.move(0, 0);
    await help.focus();
    await expect(page.getByRole("tooltip")).toContainText(explanation);
    await page.keyboard.press("Escape");
    await help.blur();
  }
  await expect(
    page.getByRole("heading", { name: "01 Space 拓扑", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "02 环境资源", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "03 运行脉搏", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("尚无资源历史 · 等待采样")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("wide machine layouts grow the resources and pulse column instead of shrinking it", async ({
  page,
}) => {
  const now = new Date().toISOString();
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Synthetic machine",
            report: report("wide-card", now),
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/?machine=mac-one");
  const aside = page.locator(".dashboard-aside");
  const medium = await aside.boundingBox();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await expect
    .poll(async () => (await aside.boundingBox())?.width ?? 0)
    .toBeGreaterThan(440);
  const wide = await aside.boundingBox();
  expect(wide && medium && wide.width > medium.width).toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect
    .poll(() =>
      page.evaluate(() => {
        const spaces = document
          .querySelector(".dashboard-spaces")
          ?.getBoundingClientRect();
        const resources = document
          .querySelector(".dashboard-resources")
          ?.getBoundingClientRect();
        const pulse = document
          .querySelector(".dashboard-aside")
          ?.getBoundingClientRect();
        return Boolean(
          spaces &&
            resources &&
            pulse &&
            spaces.bottom <= resources.top &&
            resources.bottom <= pulse.top,
        );
      }),
    )
    .toBe(true);
});
