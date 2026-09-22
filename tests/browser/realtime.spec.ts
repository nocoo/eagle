import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";
import { report } from "../fixtures.ts";

test("Space realtime receives screens, gates input, and closes sockets on leaving", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const snapshot = report("live-ui", now);
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            report: snapshot,
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  let closed = 0,
    greetings = 0;
  let acknowledge = true;
  const inputs: unknown[] = [];
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    const sub = { spaceId: "default:w1", subscriptionId: "epoch" };
    ws.send(JSON.stringify({ type: "status", online: true, control: false }));
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
                id: "pane",
                terminalId: "terminal",
                title: "Codex",
                rect: { x: 0, y: 0, width: 1, height: 1 },
              },
            ],
          },
        ],
      }),
    );
    ws.send(
      JSON.stringify({
        type: "frame",
        ...sub,
        paneId: "pane",
        terminalId: "terminal",
        revision: 1,
        text: "ready from Herdr",
        observedAt: now,
      }),
    );
    ws.onMessage((data) => {
      const m = JSON.parse(String(data));
      if (m.type === "ping") greetings++;
      if (m.type === "control")
        ws.send(
          JSON.stringify({ type: "status", online: true, control: true }),
        );
      if (m.type === "input") {
        inputs.push(m);
        if (acknowledge)
          ws.send(
            JSON.stringify({ type: "ack", seq: m.seq, status: "submitted" }),
          );
      }
    });
    ws.onClose(() => closed++);
  });
  await page.goto("/overview");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(page.getByText("ready from Herdr")).toBeVisible();
  await expect.poll(() => greetings, { timeout: 1000 }).toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "发送并回车" })).toBeDisabled();
  await expect(page.getByLabel("发送到当前 Pane")).toBeEnabled();
  await page.getByLabel("发送到当前 Pane").fill("hello");
  await page.getByRole("button", { name: "发送并回车" }).click();
  await expect.poll(() => inputs.length).toBe(1);
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect.poll(() => closed).toBe(1);
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(page.getByText("ready from Herdr")).toBeVisible();
  acknowledge = false;
  await expect(page.getByLabel("发送到当前 Pane")).toBeEnabled();
  await page.getByLabel("发送到当前 Pane").fill("never-replay-this");
  await page.getByRole("button", { name: "发送并回车" }).click();
  await expect.poll(() => inputs.length).toBe(2);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => closed).toBe(2);
  await expect(
    page.getByText("连接中断，输入结果未知；不会自动重发"),
  ).toBeVisible();
  await page.evaluate(() => {
    Reflect.deleteProperty(document, "hidden");
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect(page.getByText("ready from Herdr")).toBeVisible();
  await expect(page.getByRole("button", { name: "发送并回车" })).toBeDisabled();
  expect(inputs.length).toBe(2);
  await page.keyboard.press("Escape");
  await expect.poll(() => closed).toBe(3);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("terminal replacement clears drafts and renewable lease reconnect never reclaims control", async ({
  page,
}) => {
  const now = new Date().toISOString();
  const snapshot = report("live-replacement", now);
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Mac One",
            report: snapshot,
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  let latest: import("@playwright/test").WebSocketRoute | undefined;
  let connections = 0,
    releases = 0,
    controls = 0,
    inputs = 0;
  const topology = (terminalId: string) =>
    JSON.stringify({
      type: "topology",
      spaceId: "default:w1",
      subscriptionId: `epoch-${connections}`,
      tabs: [
        {
          id: "t",
          name: "T",
          panes: [
            {
              id: "p",
              terminalId,
              title: "P",
              rect: { x: 0, y: 0, width: 1, height: 1 },
            },
          ],
        },
      ],
    });
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    latest = ws;
    connections++;
    ws.send(JSON.stringify({ type: "status", online: true, control: false }));
    ws.send(topology("original"));
    ws.onMessage((data) => {
      const m = JSON.parse(String(data));
      if (m.type === "input") inputs++;
      if (m.type === "release") releases++;
      if (m.type === "control") controls++;
      if (m.type === "control" || m.type === "release")
        ws.send(
          JSON.stringify({
            type: "status",
            online: true,
            control: m.type === "control",
          }),
        );
    });
  });
  await page.goto("/overview");
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(page.getByLabel("发送到当前 Pane")).toBeEnabled();
  await page.evaluate(() => window.dispatchEvent(new Event("pageshow")));
  await page.waitForTimeout(100);
  expect(connections).toBe(1);
  await page.getByLabel("发送到当前 Pane").fill("old-target-draft");
  assert(latest);
  latest.send(topology("replacement"));
  await expect(page.getByLabel("发送到当前 Pane")).toHaveValue("");
  await expect(page.getByLabel("发送到当前 Pane")).toBeDisabled();
  await expect.poll(() => releases).toBe(1);
  expect(controls).toBe(1);
  await page.getByRole("button", { name: "接管输入" }).click();
  await page.getByLabel("发送到当前 Pane").fill("lease-draft");
  latest.close({ code: 4002, reason: "Renew authorization" });
  await expect.poll(() => connections).toBe(2);
  await expect(page.getByRole("button", { name: "接管输入" })).toBeEnabled();
  await expect(page.getByLabel("发送到当前 Pane")).toBeDisabled();
  await expect(page.getByLabel("发送到当前 Pane")).toHaveValue("");
  expect(controls).toBe(2);
  expect(inputs).toBe(0);
});
