import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { report } from "../fixtures.ts";

async function openWorkspace(
  page: Page,
  { online = true, grantControl = true } = {},
) {
  const now = new Date().toISOString();
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            report: report("compact-realtime", now),
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  let socket: WebSocketRoute;
  let controls = 0,
    inputs = 0,
    closed = 0;
  const sub = { spaceId: "default:w1", subscriptionId: "epoch" };
  const frame = (text = "Synthetic terminal output") =>
    socket.send(
      JSON.stringify({
        type: "frame",
        ...sub,
        paneId: "w1:p1",
        terminalId: "terminal",
        revision: 1,
        text,
        observedAt: now,
      }),
    );
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    socket = ws;
    ws.send(JSON.stringify({ type: "status", online, control: false }));
    ws.send(
      JSON.stringify({
        type: "topology",
        ...sub,
        tabs: [
          {
            id: "tab",
            name: "Build",
            panes: [
              {
                id: "w1:p1",
                terminalId: "terminal",
                title:
                  "sample-repository-with-a-very-long-terminal-target-name",
                rect: { x: 0, y: 0, width: 1, height: 1 },
              },
            ],
          },
        ],
      }),
    );
    frame();
    ws.onMessage((data) => {
      const m = JSON.parse(String(data));
      if (m.type === "control") {
        controls++;
        if (grantControl)
          ws.send(
            JSON.stringify({ type: "status", online: true, control: true }),
          );
      }
      if (m.type === "release")
        ws.send(
          JSON.stringify({ type: "status", online: true, control: false }),
        );
      if (m.type === "input") inputs++;
    });
    ws.onClose(() => closed++);
  });
  await page.goto("/overview");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  return {
    frame,
    status: (online: boolean, control: boolean) =>
      socket.send(JSON.stringify({ type: "status", online, control })),
    offline: () =>
      socket.send(
        JSON.stringify({ type: "status", online: false, control: false }),
      ),
    controls: () => controls,
    inputs: () => inputs,
    closed: () => closed,
  };
}

test("realtime is first and enables input by default after the control grant", async ({
  page,
}) => {
  const stream = await openWorkspace(page);
  const tabs = page
    .getByRole("group", { name: "工作区视图" })
    .getByRole("button");
  await expect(tabs.first()).toHaveText("实时模式");
  await expect(tabs.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".live-pane pre")).toContainText(
    "Synthetic terminal output",
  );
  await expect(page.getByRole("button", { name: "发送并回车" })).toBeDisabled();
  await expect(page.getByLabel("发送到当前 Pane")).toBeEnabled();
  expect(stream.controls()).toBe(1);
  expect(stream.inputs()).toBe(0);
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect.poll(stream.closed).toBe(1);
  await expect(page.getByText("Herdr 弱提示：done")).toBeVisible();
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await expect(tabs.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("发送到当前 Pane")).toBeEnabled();
  expect(stream.controls()).toBe(2);
  expect(stream.inputs()).toBe(0);
});

test("initial input waits for online and the server grant without retrying denied control", async ({
  page,
}) => {
  const stream = await openWorkspace(page, {
    online: false,
    grantControl: false,
  });
  const input = page.getByLabel("发送到当前 Pane");
  await expect(input).toBeDisabled();
  expect(stream.controls()).toBe(0);
  stream.status(true, false);
  await expect.poll(stream.controls).toBe(1);
  await expect(input).toBeDisabled();
  stream.status(true, false);
  stream.frame("Another viewer still controls this Space");
  await expect(page.locator(".live-pane pre")).toContainText("Another viewer");
  expect(stream.controls()).toBe(1);
  await expect(input).toBeDisabled();
  stream.status(true, true);
  await expect(input).toBeEnabled();
  expect(stream.inputs()).toBe(0);
});

test("releasing default input control is respected until manual reacquisition", async ({
  page,
}) => {
  const stream = await openWorkspace(page);
  const input = page.getByLabel("发送到当前 Pane");
  await expect(input).toBeEnabled();
  await page.getByRole("button", { name: "释放输入", exact: true }).click();
  await expect(input).toBeDisabled();
  stream.status(true, false);
  stream.frame("Still viewing after release");
  await expect(page.locator(".live-pane pre")).toContainText("Still viewing");
  expect(stream.controls()).toBe(1);
  await page.getByRole("button", { name: "接管输入", exact: true }).click();
  await expect(input).toBeEnabled();
  expect(stream.controls()).toBe(2);
  expect(stream.inputs()).toBe(0);
});

test("idle Codex footer is compacted only in the displayed terminal", async ({
  page,
}) => {
  const stream = await openWorkspace(page);
  const screen = page.locator(".live-pane pre");
  await expect(screen).toBeVisible();
  stream.frame(
    "Actual output\n\n› Ask Codex to do anything\n\n  gpt-6-astra max · ~/workspace/demo · Main [default]\n\n",
  );
  await expect(screen).toHaveText(
    "Actual output\n\ngpt-6-astra max · ~/workspace/demo",
  );
  await expect(screen).not.toContainText("Ask Codex");
  await expect(screen).toHaveCSS("padding-bottom", "0px");
  expect(await screen.textContent()).not.toMatch(/\n$/);
  stream.frame(
    "Actual output\n› fix this bug\n  gpt-6-astra max · ~/workspace/demo · Main [default]",
  );
  await expect(screen).toContainText("› fix this bug");
  expect(
    await screen.evaluate((el) =>
      Number.parseFloat(getComputedStyle(el).paddingBottom),
    ),
  ).toBeGreaterThan(0);
  expect(stream.controls()).toBe(1);
  expect(stream.inputs()).toBe(0);
});

test("output status is an accessible icon on the target row, including failures", async ({
  page,
}, testInfo) => {
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const stream = await openWorkspace(page);
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  const row = page.locator(".live-composer-meta");
  const icon = row.getByRole("button", { name: /终端输出：/ });
  await expect(icon).toHaveAttribute("aria-label", "终端输出：刚有新输出");
  expect(await icon.innerText()).toBe("");
  await expect(icon).toHaveCSS("animation-name", "none");
  const geometry = await row.evaluate((el) => {
    const nodes = [
      el.querySelector("button"),
      el.querySelector("label"),
      el.querySelector("label .mono"),
      el.querySelector(".live-control-mode"),
    ];
    return {
      height: el.getBoundingClientRect().height,
      centers: nodes.map((node) => {
        if (!node) throw new Error("Missing compact row element");
        const r = node.getBoundingClientRect();
        return r.y + r.height / 2;
      }),
      overflow: el.scrollWidth > el.clientWidth,
    };
  });
  expect(geometry.height).toBeLessThanOrEqual(26);
  expect(
    Math.max(...geometry.centers) - Math.min(...geometry.centers),
  ).toBeLessThan(2);
  expect(geometry.overflow).toBe(false);
  await page.locator(".space-sheet").screenshot({
    path: testInfo.outputPath("compact-realtime-online.png"),
    animations: "disabled",
  });
  await icon.focus();
  await expect(page.getByRole("tooltip")).toContainText("刚有新输出");
  await page.clock.fastForward(4000);
  await expect(icon).toHaveAttribute(
    "aria-label",
    "终端输出：已连接，等待新输出",
  );
  stream.frame();
  await page.clock.fastForward(100);
  await expect(icon).toHaveAttribute(
    "aria-label",
    "终端输出：已连接，等待新输出",
  );
  stream.offline();
  await expect(icon).toHaveAttribute("data-state", "offline");
  await expect(icon).toHaveAttribute("aria-label", /等待本机实时服务/);
  expect(stream.inputs()).toBe(0);
  await page.locator(".space-sheet").screenshot({
    path: testInfo.outputPath("compact-realtime.png"),
    animations: "disabled",
  });
});
