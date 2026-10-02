import { expect, test } from "@playwright/test";
import { DailySettingsSchema } from "../../src/shared/daily.ts";
import { report } from "../fixtures.ts";

test.use({ reducedMotion: "reduce" });

const now = "2026-09-20T20:05:06.000Z";
const routes = [
  ["/?machine=mac-one", "Mac One"],
  ["/overview", "全局总览"],
  ["/connect", "Connect"],
  ["/history", "最近历史"],
  ["/settings", "设置"],
] as const;

for (const [path, title] of routes) {
  test(`${title} keeps mobile page actions beside the title without empty header rows`, async ({
    page,
    isMobile,
  }) => {
    await page.clock.install({ time: new Date(now) });
    await page.clock.pauseAt(new Date(now));
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    let failed = false;
    let stale = false;
    let refreshes = 0;
    await page.route("**/api/**", (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (pathname === "/api/v1/resources")
        return route.fulfill({
          json: { retentionSeconds: 86400, samples: [] },
        });
      if (pathname === "/api/v1/overview") {
        refreshes++;
        if (failed)
          return route.fulfill({ status: 503, json: { error: "unavailable" } });
      }
      return route.fulfill({
        json:
          pathname === "/api/v1/settings"
            ? {
                ...DailySettingsSchema.parse({}),
                hasApiKey: false,
                configured: false,
              }
            : {
                now,
                machines:
                  pathname === "/api/v1/machines"
                    ? []
                    : [
                        {
                          id: "mac-one",
                          name: stale
                            ? "Mac One With A Very Long Machine Name"
                            : "Mac One",
                          report: report(
                            "header",
                            stale ? "2026-09-20T19:05:06.000Z" : now,
                          ),
                          lastSeen: now,
                          receivedAt: now,
                          warning: null,
                        },
                      ],
                canIssue: true,
                entries: [],
                hours: [],
              },
      });
    });
    await page.goto(path);
    const header = page.locator("#eagle-content header").first();
    const refresh = header.getByRole("button", { name: "刷新", exact: true });
    const navigation = header.getByRole("button", {
      name:
        path.includes("machine") || path === "/overview"
          ? "查看最近历史"
          : "返回总览",
    });
    await expect(header.getByRole("heading", { name: title })).toBeVisible();
    await expect(refresh).toBeEnabled();
    for (const width of isMobile ? [390, 320] : [1280]) {
      await page.setViewportSize({ width, height: 844 });
      if (width === 320)
        await page.getByRole("button", { name: "切换主题" }).click();
      const box = await header.boundingBox();
      expect(box).not.toBeNull();
      if (isMobile) {
        await expect(page.getByText("工作台", { exact: true })).toBeHidden();
        expect(box?.height).toBeLessThanOrEqual(40);
        for (const button of [refresh, navigation]) {
          const action = await button.boundingBox();
          expect(action?.y).toBeGreaterThanOrEqual(box?.y ?? 0);
          expect((action?.y ?? 0) + (action?.height ?? 0)).toBeLessThanOrEqual(
            (box?.y ?? 0) + 40,
          );
          expect(action?.width).toBeGreaterThanOrEqual(36);
          expect(action?.height).toBeGreaterThanOrEqual(36);
        }
        await expect(page.locator(".sync-caption")).toBeHidden();
        expect(
          await header.evaluate((node) => {
            let next = node.nextElementSibling;
            while (next && next.getBoundingClientRect().height === 0)
              next = next.nextElementSibling;
            return next
              ? next.getBoundingClientRect().top -
                  node.getBoundingClientRect().bottom
              : 0;
          }),
        ).toBeLessThanOrEqual(12);
        if (path.includes("machine")) {
          await expect(header.getByText("在线", { exact: true })).toBeVisible();
          await expect(
            header.getByText("1 Spaces", { exact: true }),
          ).toBeHidden();
        } else await expect(header.locator("p")).toBeHidden();
        if (path === "/connect")
          expect(
            (await page.locator(".connect-steps").boundingBox())?.height,
          ).toBeLessThanOrEqual(64);
      } else {
        await expect(header.locator("p")).toBeVisible();
        await expect(refresh).toHaveText("刷新");
      }
      expect(
        await page
          .locator("#eagle-content")
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`page-${width}.png`),
      });
    }
    if (path.includes("machine")) {
      stale = true;
      await refresh.click();
      await expect(header.getByText("采集过期", { exact: true })).toBeVisible();
      await expect(header.getByRole("heading")).toHaveText(
        "Mac One With A Very Long Machine Name",
      );
      if (isMobile) {
        expect((await header.boundingBox())?.height).toBeLessThanOrEqual(40);
        await expect(navigation).toBeInViewport({ ratio: 1 });
        expect(
          await header.evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
      }
      await page.screenshot({
        path: test.info().outputPath("stale-machine.png"),
      });
    }
    const previous = refreshes;
    failed = true;
    await refresh.click();
    await expect.poll(() => refreshes).toBeGreaterThan(previous);
    await expect(page.getByRole("alert")).toContainText("连接中断");
    await navigation.focus();
    await navigation.press("Enter");
    await expect(page).toHaveURL(
      path.includes("machine") || path === "/overview"
        ? /\/history/
        : /\/overview/,
    );
  });
}
