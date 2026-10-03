import { expect, test } from "@playwright/test";
import { MachineTelemetrySchema } from "../../src/shared/schema.ts";
import { report, telemetry } from "../fixtures.ts";

const now = "2026-10-02T01:00:00.000Z";
test("resource history times out, preserves samples and allows retry", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now));
  await page.addInitScript(() => {
    AbortSignal.timeout = (milliseconds) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("Timed out", "TimeoutError")),
        milliseconds,
      );
      return controller.signal;
    };
  });
  let stalled = false;
  let reads = 0;
  const value = report("synthetic-resource-timeout", now);
  value.machine.telemetry = MachineTelemetrySchema.parse(telemetry(now));
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/resources") {
      reads++;
      if (stalled) return;
      return route.fulfill({
        json: {
          retentionSeconds: 86400,
          samples: [
            {
              observedAt: now,
              intervalSeconds: 30,
              cpu: 25,
              memory: 75,
              load: [1, 2, 3],
            },
          ],
        },
      });
    }
    if (path === "/api/v1/me")
      return route.fulfill({
        json: {
          name: "Synthetic viewer",
          email: "",
          avatar: null,
          local: true,
        },
      });
    return route.fulfill({
      json: {
        now,
        machines: [
          {
            id: value.machine.id,
            name: value.machine.name,
            report: value,
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    });
  });
  await page.goto(`/?machine=${value.machine.id}`);
  const chart = page.getByRole("group", { name: "CPU、内存与负载历史" });
  const refresh = page.getByRole("button", { name: "刷新资源历史" });
  await expect(chart).toBeVisible();
  stalled = true;
  await refresh.click();
  await expect.poll(() => reads).toBe(2);
  await page.clock.runFor(14999);
  await expect(refresh).toBeDisabled();
  await page.clock.runFor(1);
  await expect(page.getByRole("alert")).toContainText("历史更新失败");
  await expect(chart).toBeVisible();
  await expect(refresh).toBeEnabled();
  stalled = false;
  await refresh.click();
  await expect.poll(() => reads).toBe(3);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(refresh).toBeEnabled();
});

test("environment resources retain Space, show bounded dual axes and honest missing/offline evidence", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now));
  let fail = false;
  let unauthorized = false;
  let revision = 1;
  const value = report("synthetic-resource-ui", now);
  value.machine.name = "Synthetic resource machine";
  const snapshot = {
    ...telemetry(now),
    sampleIntervalSeconds: 30,
    slowIntervalSeconds: 300,
    diskObservedAt: "2026-10-02T00:58:00.000Z",
    network: {
      state: "connected",
      source: "macos-reachability",
      observedAt: now,
    },
    vpn: { state: "unknown", source: "macos-vpn", observedAt: now },
    temperature: {
      status: "unavailable",
      celsius: null,
      source: "unsupported",
      observedAt: "2026-10-02T00:58:00.000Z",
    },
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/v1/resources") {
      if (unauthorized) return route.fulfill({ status: 401, json: {} });
      if (fail) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({
        json: {
          retentionSeconds: 86400,
          samples: [
            {
              observedAt: "2026-10-02T00:56:00.000Z",
              intervalSeconds: 30,
              cpu: 0,
              memory: 70,
              load: [120, 10, 8],
            },
            {
              observedAt: "2026-10-02T00:56:30.000Z",
              intervalSeconds: 30,
              cpu: null,
              memory: 72,
              load: [90, 12, 9],
            },
            {
              observedAt: now,
              intervalSeconds: 30,
              cpu: 25,
              memory: 75,
              load: [80, 20, 10],
            },
          ],
        },
      });
    }
    if (path === "/api/v1/me")
      return route.fulfill({
        json: {
          name: "Synthetic viewer",
          email: "",
          avatar: null,
          local: true,
        },
      });
    return route.fulfill({
      json: {
        now: new Date().toISOString(),
        machines: [
          {
            id: "mac-one",
            name: value.machine.name,
            report: {
              ...value,
              machine: { ...value.machine, telemetry: snapshot },
            },
            lastSeen: now,
            receivedAt: now,
            warning: null,
            revision,
          },
        ],
      },
    });
  });
  await page.goto("/?machine=mac-one");
  await expect(
    page.getByRole("heading", { name: "01 Space 拓扑" }),
  ).toBeVisible();
  const environment = page.getByRole("region", {
    name: "环境资源",
    exact: true,
  });
  await expect(environment).toBeVisible();
  await expect(
    environment.getByRole("heading", { name: "02 环境资源" }),
  ).toBeVisible();
  await expect(environment).toContainText("VPN 未知");
  await expect(environment).toContainText("不可用");
  const help = environment.getByRole("button", { name: "资源时间序列说明" });
  await help.scrollIntoViewIfNeeded();
  await help.click();
  await page.clock.runFor(1);
  await expect(page.getByRole("tooltip")).toContainText("30 秒");
  await expect(page.getByRole("tooltip")).toContainText("300 秒");
  await expect(page.getByRole("tooltip")).toContainText(
    "Load 1/5/15 分钟 · 右轴虚线",
  );
  await expect(page.getByRole("tooltip")).toContainText("磁盘不入图");
  await page.keyboard.press("Escape");
  const chart = environment.getByRole("group", { name: "CPU、内存与负载历史" });
  await expect(chart).toBeVisible();
  const percentAxis = chart.getByText("100%", { exact: true });
  const loadAxis = chart.getByText("Load", { exact: true });
  await expect(percentAxis).toBeVisible();
  await expect(loadAxis).toBeVisible();
  const percentBox = await percentAxis.boundingBox();
  const loadBox = await loadAxis.boundingBox();
  expect(percentBox && loadBox && percentBox.x < loadBox.x).toBe(true);
  await expect(
    chart.locator(".resource-load-1 path.recharts-line-curve"),
  ).toHaveAttribute("stroke-dasharray", "6 4");
  await expect(
    chart.locator(".resource-cpu path.recharts-line-curve"),
  ).not.toHaveAttribute("stroke-dasharray");
  const cpuDots = chart.locator(".resource-cpu-sample");
  const memoryDots = chart.locator(".resource-memory-sample");
  await expect(cpuDots).toHaveCount(2);
  await expect(cpuDots.first()).toBeVisible();
  await expect(cpuDots.last()).toBeVisible();
  await expect(memoryDots).toHaveCount(1);
  await expect(memoryDots).toBeVisible();
  await page.clock.runFor(180000);
  await expect(environment).toContainText("历史快照");
  await expect(environment).toContainText("上次网络");
  await expect(cpuDots).toHaveCount(2);
  await expect(cpuDots.last()).toBeVisible();
  fail = true;
  await environment.getByRole("button", { name: "刷新资源历史" }).click();
  await expect(environment).toContainText("历史更新失败");
  await expect(chart).toBeVisible();
  unauthorized = true;
  revision++;
  await environment.getByRole("button", { name: "刷新资源历史" }).click();
  await expect(environment).toContainText("重新登录");
  await expect(chart).toHaveCount(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("resource history stays scoped to the selected machine and does not refetch on unchanged overview polls", async ({
  page,
  isMobile,
}) => {
  await page.clock.install({ time: new Date(now) });
  await page.clock.pauseAt(new Date(now));
  let release: (() => void) | undefined;
  let reads = 0;
  let bObserved = now;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/v1/resources") {
      reads++;
      if (url.searchParams.get("machine") === "a") await pending;
      return route.fulfill({
        json: {
          retentionSeconds: 86400,
          samples:
            url.searchParams.get("machine") === "a"
              ? [
                  {
                    observedAt: now,
                    intervalSeconds: 30,
                    cpu: 99,
                    memory: 99,
                    load: [99, 99, 99],
                  },
                ]
              : [],
        },
      });
    }
    if (url.pathname === "/api/v1/me")
      return route.fulfill({
        json: {
          name: "Synthetic viewer",
          email: "",
          avatar: null,
          local: true,
        },
      });
    return route.fulfill({
      json: {
        now,
        machines: ["a", "b"].map((id) => {
          const value = report(`synthetic-${id}`, now);
          value.machine.id = id;
          return {
            id,
            name: `Synthetic ${id}`,
            report: {
              ...value,
              machine: {
                ...value.machine,
                telemetry: telemetry(id === "b" ? bObserved : now),
              },
            },
            lastSeen: now,
            receivedAt: now,
            warning: null,
          };
        }),
      },
    });
  });
  await page.goto("/?machine=a");
  await expect(page.getByText("正在读取资源历史…")).toBeVisible();
  if (isMobile) await page.getByRole("button", { name: "展开导航" }).click();
  await page.getByRole("button", { name: "Synthetic b", exact: true }).click();
  await expect(page.getByText("尚无资源历史 · 等待采样")).toBeVisible();
  release?.();
  await page.clock.runFor(15000);
  await expect(
    page.getByRole("group", { name: "CPU、内存与负载历史" }),
  ).toHaveCount(0);
  expect(reads).toBe(2);
  bObserved = new Date(Date.parse(now) + 30000).toISOString();
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect.poll(() => reads).toBe(3);
});
