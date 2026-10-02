import { expect, test } from "@playwright/test";
import { MachineTelemetrySchema } from "../../src/shared/schema.ts";
import { report, telemetry } from "../fixtures.ts";

test("resource chart defaults to six hours and switches windows without refetching", async ({
  page,
}) => {
  const now = "2026-10-03T04:00:00.000Z";
  await page.clock.install({ time: new Date(Date.parse(now) - 1000) });
  await page.clock.pauseAt(new Date(now));
  const snapshot = report("window-controls", now);
  let reads = 0;
  await page.route("**/api/**", (route) => {
    if (new URL(route.request().url()).pathname === "/api/v1/resources") {
      reads++;
      return route.fulfill({
        json: {
          retentionSeconds: 86400,
          samples: [-25, -24, -20, -12, -10, -6, -5, -1, 0, 1].map((hours) => ({
            observedAt: new Date(
              Date.parse(now) + hours * 3600000,
            ).toISOString(),
            intervalSeconds: 30,
            cpu: 25,
            memory: 75,
            load: [1, 2, 3],
          })),
        },
      });
    }
    return route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Window machine",
            report: snapshot,
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    });
  });
  await page.goto("/?machine=mac-one");
  const ranges = page.getByRole("radiogroup", { name: "资源历史时间范围" });
  await expect(
    ranges.getByRole("radio", { name: "6h", exact: true }),
  ).toBeChecked();
  const dots = page.locator(".resource-cpu-sample");
  await expect(dots).toHaveCount(4);
  await expect(
    page.getByRole("application", { name: "CPU、内存与负载历史" }),
  ).toContainText("06:00");
  await ranges.getByRole("radio", { name: "12h", exact: true }).click();
  await expect(dots).toHaveCount(6);
  await ranges.getByRole("radio", { name: "24h", exact: true }).click();
  await expect(dots).toHaveCount(8);
  await ranges.getByRole("radio", { name: "6h", exact: true }).click();
  await expect(dots).toHaveCount(4);
  expect(reads).toBe(1);
  await page.clock.runFor(5000);
  await expect(dots).toHaveCount(3);
  await page.setViewportSize({ width: 320, height: 844 });
  await expect
    .poll(async () => {
      const controls = await ranges.boundingBox();
      const card = await page.locator(".resource-history").boundingBox();
      return !!(
        controls &&
        card &&
        controls.x + controls.width <= card.x + card.width
      );
    })
    .toBe(true);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("resource usage bars have equal widths, preserve numbers and never fabricate unknown values", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const snapshot = report("resource-bars", now);
  const reading = MachineTelemetrySchema.parse(telemetry(now));
  let missing = false;
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json:
        new URL(route.request().url()).pathname === "/api/v1/resources"
          ? { retentionSeconds: 86400, samples: [] }
          : {
              now,
              machines: [
                {
                  id: "mac-one",
                  name: "Usage machine",
                  report: {
                    ...snapshot,
                    machine: {
                      ...snapshot.machine,
                      telemetry: {
                        ...reading,
                        resources:
                          missing && reading.resources
                            ? {
                                ...reading.resources,
                                cpuUsagePercent: null,
                                disk: null,
                              }
                            : reading.resources,
                      },
                    },
                  },
                  lastSeen: now,
                  receivedAt: now,
                  warning: null,
                },
              ],
            },
    }),
  );
  await page.goto("/?machine=mac-one");
  const resources = page.getByRole("region", { name: "机器资源", exact: true });
  for (const [name, percent] of [
    ["CPU 占用", "25"],
    ["内存占用", "75"],
    ["磁盘占用", "60"],
  ]) {
    await expect(
      resources.getByRole("progressbar", { name, exact: true }),
    ).toHaveAttribute("aria-valuenow", percent);
  }
  const widths = await resources
    .getByRole("progressbar")
    .evaluateAll((bars) =>
      bars.map((bar) => bar.getBoundingClientRect().width),
    );
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  await expect(resources).toContainText("12 / 16 GiB");
  await expect(resources).toContainText("200 GiB");
  await expect(resources).toContainText("75%");
  await expect(resources).toContainText("60%");
  await expect(
    resources.getByRole("progressbar", { name: "运行时间" }),
  ).toHaveCount(0);
  missing = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(
    resources.getByRole("progressbar", { name: "CPU 占用", exact: true }),
  ).toHaveCount(0);
  await expect(
    resources.getByRole("progressbar", { name: "磁盘占用", exact: true }),
  ).toHaveCount(0);
  await expect(
    resources.getByRole("progressbar", { name: "内存占用", exact: true }),
  ).toHaveAttribute("aria-valuenow", "75");
  await expect(resources).toContainText("未知");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
