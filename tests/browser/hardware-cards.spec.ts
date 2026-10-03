import { expect, test } from "@playwright/test";
import { report, telemetry } from "../fixtures.ts";

for (const theme of ["light", "dark"]) {
  test(`${theme} hardware cards show six honest read-only metrics`, async ({
    page,
    isMobile,
  }) => {
    await page.addInitScript(
      (theme) => localStorage.setItem("theme", theme),
      theme,
    );
    const now = new Date().toISOString();
    const snapshot = report("hardware-cards", now);
    const sample = {
      ...telemetry(now),
      sampleIntervalSeconds: 30,
      temperature: {
        status: "available",
        celsius: 68,
        source: "macmon",
        observedAt: now,
      },
      network: {
        state: "connected",
        source: "macos-reachability",
        observedAt: now,
      },
      vpn: { state: "connected", source: "macos-vpn", observedAt: now },
      hardware: {
        observedAt: now,
        source: "macmon",
        gpuUsagePercent: 4,
        gpuTemperatureCelsius: 62,
        fans: [
          { rpm: 1350, maxRpm: 5400 },
          { rpm: 1450, maxRpm: 5800 },
        ],
        memory: { totalBytes: 16 * 1024 ** 3, usedBytes: 8 * 1024 ** 3 },
        swapUsedBytes: 1024 ** 3,
      },
      traffic: {
        observedAt: now,
        source: "netstat-physical",
        sampleMs: 500,
        downloadBytesPerSecond: 3072,
        uploadBytesPerSecond: 2048,
      },
    };
    let missing = false;
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
                  report: {
                    ...snapshot,
                    machine: {
                      ...snapshot.machine,
                      telemetry: missing ? telemetry(now) : sample,
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
    const region = page.getByRole("region", { name: "机器资源", exact: true });
    await expect(region.locator(".resource-metric-card")).toHaveCount(6);
    await expect(region).toContainText("68°C");
    await expect(region).toContainText("62°C");
    await expect(region).toContainText("1,450");
    await expect(region).toContainText("8 / 16 GiB");
    await expect(region).toContainText("↓ 3 KiB/s");
    await expect(region).toContainText("↑ 2 KiB/s");
    await expect(region).toContainText("VPN 已连接");
    await expect(
      region.getByRole("progressbar", { name: "风扇转速比例" }),
    ).toHaveAttribute("aria-valuenow", "25");
    await expect(
      region.getByRole("progressbar", { name: "GPU 占用", exact: true }),
    ).toHaveAttribute("aria-valuenow", "4");
    await expect(
      region.getByRole("button", { name: /强冷|降温|自动$/ }),
    ).toHaveCount(0);
    const bars = await region
      .getByRole("progressbar")
      .evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().width),
      );
    expect(Math.max(...bars) - Math.min(...bars)).toBeLessThan(1);
    const help = region.getByRole("button", { name: "风扇说明" });
    await help.scrollIntoViewIfNeeded();
    if (isMobile) await help.tap();
    else await help.hover();
    await expect(page.getByRole("tooltip")).toContainText("不控制风扇");
    await page.keyboard.press("Escape");
    await help.blur();
    missing = true;
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(region.locator('[data-metric="fan"]')).toContainText("未知");
    await expect(
      region.getByRole("progressbar", { name: "风扇转速比例" }),
    ).toHaveCount(0);
    await expect(
      region.getByRole("progressbar", { name: "GPU 占用", exact: true }),
    ).toHaveCount(0);
    for (const width of [390, 320, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
    }
  });
}
