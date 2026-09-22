import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { report } from "../fixtures.ts";

async function openTerminal(page: Page) {
  const now = new Date().toISOString();
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            report: report("terminal-view", now),
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  let socket: WebSocketRoute;
  let revision = 0;
  let terminalId = "terminal";
  const sub = { spaceId: "default:w1", subscriptionId: "epoch" };
  const topology = () =>
    socket.send(
      JSON.stringify({
        type: "topology",
        ...sub,
        tabs: [
          {
            id: "tab",
            name: "Build",
            panes: [
              {
                id: "pane",
                terminalId,
                title: "CLI",
                rect: { x: 0, y: 0, width: 1, height: 1 },
              },
            ],
          },
        ],
      }),
    );
  const frame = (
    text: string,
    runs?: { text: string; fg?: number; bold?: true }[],
  ) =>
    socket.send(
      JSON.stringify({
        type: "frame",
        ...sub,
        paneId: "pane",
        terminalId,
        revision: ++revision,
        text,
        ...(runs ? { runs } : {}),
        observedAt: now,
      }),
    );
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: "status", online: true, control: false }));
    topology();
    ws.onMessage(() => {});
  });
  await page.goto("/overview");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(page.locator(".live-pane pre")).toBeVisible();
  return {
    frame,
    replace: () => {
      terminalId = "replacement";
      topology();
    },
    offline: () =>
      socket.send(
        JSON.stringify({ type: "status", online: false, control: false }),
      ),
  };
}

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `output line ${i + 1}`).join("\n");
const distance = (page: Page) =>
  page
    .locator(".live-pane pre")
    .evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);

test("terminal output follows the bottom, pauses for history, and resumes explicitly", async ({
  page,
}) => {
  const stream = await openTerminal(page);
  stream.frame(lines(100));
  await expect.poll(() => distance(page)).toBeLessThan(3);
  stream.frame(lines(110));
  await expect(page.locator(".live-pane pre")).toContainText("output line 110");
  await expect.poll(() => distance(page)).toBeLessThan(3);
  await page.locator(".live-pane pre").evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  stream.frame(lines(120));
  await expect(
    page.getByRole("button", { name: "新输出，回到底部" }),
  ).toBeVisible();
  expect(
    await page.locator(".live-pane pre").evaluate((el) => el.scrollTop),
  ).toBe(0);
  await page.getByRole("button", { name: "新输出，回到底部" }).click();
  await expect.poll(() => distance(page)).toBeLessThan(3);
  stream.frame(lines(130));
  await expect.poll(() => distance(page)).toBeLessThan(3);
  await page.locator(".live-pane pre").evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  stream.replace();
  stream.frame(lines(90));
  await expect.poll(() => distance(page)).toBeLessThan(3);
});

test("safe colors render as text, and output activity is not a running-task claim", async ({
  page,
}) => {
  await page.clock.install();
  const stream = await openTerminal(page);
  const text = "PASS <img src=x onerror=alert(1)>";
  stream.frame(text, [
    { text: "PASS", fg: 2, bold: true },
    { text: text.slice(4) },
  ]);
  const pass = page
    .locator(".live-pane pre span")
    .filter({ hasText: /^PASS$/ });
  await expect(pass).toHaveCSS("color", "rgb(166, 227, 161)");
  await expect(pass).toHaveCSS("font-weight", "700");
  await expect(page.locator(".live-pane pre img")).toHaveCount(0);
  const activity = page.getByRole("button", { name: /终端输出：/ });
  await expect(activity).toHaveAttribute("aria-label", "终端输出：刚有新输出");
  await page.clock.fastForward(4000);
  await expect(activity).toHaveAttribute(
    "aria-label",
    "终端输出：已连接，等待新输出",
  );
  stream.frame(text, [
    { text: "PASS", fg: 2, bold: true },
    { text: text.slice(4) },
  ]);
  await page.clock.fastForward(100);
  await expect(activity).toHaveAttribute(
    "aria-label",
    "终端输出：已连接，等待新输出",
  );
  stream.offline();
  await expect(activity).toHaveAttribute("data-state", "offline");
});

test("terminal theme controls default colors and persists without reconnecting", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("theme", "light"));
  const stream = await openTerminal(page);
  stream.frame("default PASS", [
    { text: "default " },
    { text: "PASS", fg: 2, bold: true },
  ]);
  const screen = page.locator(".live-pane pre");
  await expect(screen).toHaveCSS("background-color", "rgb(250, 250, 250)");
  await expect(screen).toHaveCSS("color", "rgb(40, 44, 52)");
  await page.getByRole("combobox", { name: "终端配色" }).click();
  await page.getByRole("option", { name: "深色终端", exact: true }).click();
  await expect(screen).toHaveCSS("background-color", "rgb(30, 30, 46)");
  await expect(screen).toHaveCSS("color", "rgb(205, 214, 244)");
  await expect(screen).toContainText("default PASS");
  expect(
    await page.evaluate(() => localStorage.getItem("eagle-terminal-theme")),
  ).toBe("dark");
  await page.getByRole("combobox", { name: "终端配色" }).click();
  await page.getByRole("option", { name: "经典黑底", exact: true }).click();
  await expect(screen).toHaveCSS("background-color", "rgb(0, 0, 0)");
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "终端配色" })).toContainText(
    "经典黑底",
  );
  await expect(page.getByRole("button", { name: "发送并回车" })).toBeDisabled();
});

test("terminal theme works when browser storage is blocked", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Storage.prototype.setItem = () => {
      throw new Error("Blocked");
    };
    Storage.prototype.getItem = () => {
      throw new Error("Blocked");
    };
  });
  const stream = await openTerminal(page);
  stream.frame("output");
  await page.getByRole("combobox", { name: "终端配色" }).click();
  await page.getByRole("option", { name: "浅色终端", exact: true }).click();
  await expect(page.locator(".live-pane pre")).toHaveCSS(
    "background-color",
    "rgb(250, 250, 250)",
  );
  await expect(page.getByText("配色仅在本次打开时有效")).toBeVisible();
});

for (const theme of ["dark", "light"]) {
  test(`${theme} terminal preview keeps ANSI styling, reduced motion and bounded layout`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(
      (value) => localStorage.setItem("theme", value),
      theme,
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    const stream = await openTerminal(page);
    const runs = [
      { text: "EAGLE  /  LIVE TERMINAL\n", fg: 14, bold: true as const },
      { text: "main  •  synthetic preview\n\n", fg: 8 },
      { text: "❯ npm run check\n\n", fg: 15 },
      {
        text: "  ✓  identity and origin checks\n  ✓  secrets stay redacted\n  ✓  terminal follow mode\n",
        fg: 2,
      },
      { text: "\n  ⚠  deployment not requested\n", fg: 11 },
      {
        text: "\n  Tests    86 passed\n  Output   watching for changes\n",
        fg: 6,
      },
    ];
    stream.frame(runs.map((run) => run.text).join(""), runs);
    await expect(page.locator(".live-pane pre")).toContainText(
      "watching for changes",
    );
    await expect(page.locator(".live-output-status")).toHaveCSS(
      "animation-name",
      "none",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const status = await page
      .getByRole("button", { name: /终端输出：/ })
      .boundingBox();
    const input = await page
      .getByLabel("发送到当前 Pane", { exact: true })
      .boundingBox();
    expect(status && input && status.y < input.y).toBeTruthy();
    await page.locator(".space-sheet").screenshot({
      path: testInfo.outputPath(`terminal-${theme}.png`),
      animations: "disabled",
    });
  });
}
