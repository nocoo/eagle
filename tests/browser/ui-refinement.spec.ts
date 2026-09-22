import { expect, test } from "@playwright/test";
import { HourlySettingsSchema } from "../../src/shared/hourly.ts";
import { report } from "../fixtures.ts";

test.use({ timezoneId: "America/Los_Angeles" });

const now = "2026-09-20T20:05:06.000Z";
async function mockOverview(page: import("@playwright/test").Page) {
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            report: report("ui", now),
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
        entries: [],
        hours: [],
      },
    }),
  );
}

test("timezone defaults to UTC+8, persists and converts timestamps and report filters independently of browser timezone", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(now));
  await mockOverview(page);
  await page.route("**/api/v1/settings", (route) =>
    route.fulfill({
      json: {
        ...HourlySettingsSchema.parse({}),
        hasApiKey: false,
        configured: false,
      },
    }),
  );
  await page.goto("/");
  await expect(page.locator(".sync-caption")).toContainText("09/21 04:05:06");
  await page.goto("/settings");
  const zone = page.getByRole("combobox", { name: "显示时区" });
  await expect(zone).toContainText("UTC+08:00");
  await zone.click();
  await page.getByRole("option", { name: "UTC−05:00", exact: true }).click();
  await page.reload();
  await expect(zone).toContainText("UTC−05:00");
  let hour: string | null = null;
  await page.route("**/api/v1/hourly-reports?**", (route) => {
    hour = new URL(route.request().url()).searchParams.get("hour");
    return route.fulfill({ json: { entries: [], nextCursor: null } });
  });
  await page.goto("/history");
  await expect(page.locator(".sync-caption")).toContainText("09/20 15:05:06");
  await expect(
    page.getByText("筛选小时（UTC−05:00）", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /^报告日期/ }).click();
  await page.getByRole("button", { name: "2026-09-20", exact: true }).click();
  await expect.poll(() => hour).toBe("2026-09-20T05:00:00.000Z");
});

for (const theme of ["dark", "light"] as const) {
  test(`${theme} workspace is an animated overlay; live terminals scroll internally and the composer stays visible`, async ({
    page,
    isMobile,
  }) => {
    await page.addInitScript(
      (value) => localStorage.setItem("theme", value),
      theme,
    );
    await mockOverview(page);
    let closed = 0;
    const inputs: unknown[] = [];
    await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
      const sub = { spaceId: "default:w1", subscriptionId: "ui" };
      ws.send(JSON.stringify({ type: "status", online: true, control: false }));
      ws.send(
        JSON.stringify({
          type: "topology",
          ...sub,
          tabs: ["Build", "Review"].map((name, index) => ({
            id: name,
            name,
            panes: [0, 1].map((p) => ({
              id: `${index}-${p}`,
              terminalId: `${index}-${p}`,
              title: `Terminal ${index}-${p}`,
              rect: { x: p / 2, y: 0, width: 0.5, height: 1 },
            })),
          })),
        }),
      );
      for (const id of ["0-0", "0-1", "1-0", "1-1"])
        ws.send(
          JSON.stringify({
            type: "frame",
            ...sub,
            paneId: id,
            terminalId: id,
            revision: 1,
            text: Array.from(
              { length: 180 },
              (_, n) => `line ${n} · ${"terminal output ".repeat(8)}`,
            ).join("\n"),
            observedAt: now,
          }),
        );
      ws.onMessage((data) => {
        const message = JSON.parse(String(data));
        if (message.type === "control" || message.type === "release")
          ws.send(
            JSON.stringify({
              type: "status",
              online: true,
              control: message.type === "control",
            }),
          );
        if (message.type === "input") {
          inputs.push(message);
          ws.send(
            JSON.stringify({
              type: "ack",
              seq: message.seq,
              status: "submitted",
            }),
          );
        }
      });
      ws.onClose(() => closed++);
    });
    await page.goto("/?machine=mac-one");
    const island = await page.locator("#eagle-content").boundingBox();
    await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
    const sheet = page.getByRole("dialog", { name: "Eagle", exact: true });
    await expect(sheet).toBeVisible();
    await expect(sheet).not.toHaveCSS("animation-name", "none");
    expect(await page.locator("#eagle-content").boundingBox()).toEqual(island);
    await expect(page.locator(".live-pane pre").first()).toContainText(
      "line 179",
    );
    await page.getByRole("button", { name: "当前任务", exact: true }).click();
    await expect.poll(() => closed).toBe(1);
    await sheet.screenshot({ path: test.info().outputPath("workspace.png") });
    const before = await sheet.boundingBox();
    await page.getByRole("button", { name: "实时模式", exact: true }).click();
    await expect(page.locator(".live-pane pre").first()).toContainText(
      "line 179",
    );
    await expect
      .poll(async () => (await sheet.boundingBox())?.width ?? 0)
      .toBe(before?.width);
    const composer = page.getByLabel("发送到当前 Pane", { exact: true });
    await expect(composer).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole("button", { name: "发送并回车" }),
    ).toBeInViewport({ ratio: 1 });
    expect(
      await sheet.evaluate(
        (node) => node.scrollHeight <= node.clientHeight + 1,
      ),
    ).toBe(true);
    const terminal = page.locator(".live-pane pre").first();
    expect(
      await terminal.evaluate((node) => node.scrollHeight > node.clientHeight),
    ).toBe(true);
    await expect(terminal).toHaveCSS(
      "background-color",
      theme === "dark" ? "rgb(30, 30, 46)" : "rgb(250, 250, 250)",
    );
    await terminal.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
    });
    await expect(composer).toBeInViewport({ ratio: 1 });
    await expect(composer).toBeEnabled();
    await composer.fill("printf hello");
    await composer.press("Enter");
    await expect.poll(() => inputs.length).toBe(1);
    await expect(composer).toHaveValue("");
    await composer.fill("draft for current terminal");
    await sheet.screenshot({ path: test.info().outputPath("terminal.png") });
    await page.getByRole("combobox", { name: "实时标签页" }).click();
    await page.getByRole("option", { name: "Review", exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "当前终端" }),
    ).toContainText("1-0");
    await expect(composer).toBeInViewport({ ratio: 1 });
    await expect(composer).toBeDisabled();
    await expect(composer).toHaveValue("");
    await page.setViewportSize({ width: isMobile ? 390 : 1280, height: 460 });
    await expect(composer).toBeInViewport({ ratio: 1 });
    await expect(
      page.getByRole("button", { name: "发送并回车" }),
    ).toBeInViewport({ ratio: 1 });
    expect(
      await sheet.evaluate(
        (node) => node.scrollHeight <= node.clientHeight + 1,
      ),
    ).toBe(true);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(sheet).toHaveCSS("animation-name", "none");
    await page.getByRole("button", { name: "关闭工作区" }).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => closed).toBe(2);
  });
}

test("malformed realtime frames close the browser socket without exceptions or retry loops", async ({
  page,
}) => {
  await mockOverview(page);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let closed = 0;
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    ws.onClose(() => closed++);
    ws.send("invalid-json");
  });
  await page.goto("/?machine=mac-one");
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect.poll(() => closed, { timeout: 2000 }).toBe(1);
  expect(errors).toEqual([]);
  await expect(page.getByRole("button", { name: "接管输入" })).toBeDisabled();
});

test("calendar today and half-hour archive boundaries follow the selected timezone", async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date(now));
  await page.addInitScript(() =>
    localStorage.setItem("eagle-timezone-offset", "330"),
  );
  await mockOverview(page);
  let hour: string | null = null;
  await page.route("**/api/v1/hourly-reports?**", (route) => {
    hour = new URL(route.request().url()).searchParams.get("hour");
    return route.fulfill({ json: { entries: [], nextCursor: null } });
  });
  await page.goto("/history");
  await page.getByRole("button", { name: /^报告日期/ }).click();
  const today = page.getByRole("button", { name: "2026-09-21", exact: true });
  await expect(today).toBeFocused();
  await today.click();
  await expect(page.getByRole("combobox", { name: "报告小时" })).toContainText(
    "00:30",
  );
  await expect.poll(() => hour).toBe("2026-09-20T19:00:00.000Z");
});
