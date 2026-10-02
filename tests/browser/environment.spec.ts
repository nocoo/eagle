import { expect, test } from "@playwright/test";
import { report } from "../fixtures.ts";

test("local environment switch isolates reads, writes, identity and onboarding", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, { __EAGLE_LOCAL__: true });
  });
  const writes: string[] = [];
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const production = url.pathname.startsWith("/__local/prod/");
    const path = url.pathname.replace("/__local/prod", "");
    const environment = production ? "Prod" : "Local";
    if (route.request().method() !== "GET") writes.push(url.pathname);
    if (path === "/api/v1/me")
      return route.fulfill({
        json: {
          name: `${environment} viewer`,
          email: "",
          avatar: null,
          local: !production,
        },
      });
    if (path === "/api/v1/machines") {
      if (route.request().method() === "POST")
        return route.fulfill({
          status: 201,
          json: {
            machine: {
              id: "synthetic-new",
              name: "Synthetic new",
              enabled: true,
              source: "managed",
              credentialId: null,
              watchPorts: [],
            },
            token: "synthetic-environment-credential-not-real",
          },
        });
      return route.fulfill({ json: { machines: [], canIssue: true } });
    }
    if (path === "/api/v1/resources")
      return route.fulfill({ json: { retentionSeconds: 86400, samples: [] } });
    const now = new Date().toISOString();
    const value = report(`synthetic-${environment}`, now);
    return route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: `${environment} machine`,
            report: value,
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    });
  });
  await page.goto("/?machine=mac-one");
  const environments = page.getByRole("group", { name: "环境" });
  await expect(environments).toBeVisible();
  await expect(
    environments.getByRole("radio", { name: "Local", exact: true }),
  ).toBeChecked();
  await environments.getByRole("radio", { name: "Prod", exact: true }).click();
  await expect(page.locator("#eagle-content h1")).toHaveText("Prod machine");
  await page.goto("/connect");
  await page.getByLabel("机器 ID").fill("synthetic-new");
  await page.getByLabel("机器名称").fill("Synthetic new");
  await page.getByRole("button", { name: "创建并生成提示词" }).click();
  await expect(page.getByLabel("提示词预览")).toContainText(
    "https://eagle-ingest.hexly.ai",
  );
  expect(writes).toEqual(["/__local/prod/api/v1/machines"]);
  await page.keyboard.press("Escape");
  await environments.getByRole("radio", { name: "Local", exact: true }).click();
  await expect(page.locator("#eagle-content h1")).toHaveText("Local machine");
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});

test("failed production authentication never falls back and leaves Local accessible", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, { __EAGLE_LOCAL__: true });
  });
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 401, json: { error: "Sign in required" } }),
  );
  await page.goto("/");
  await page.evaluate(() =>
    sessionStorage.setItem("eagle-environment", "prod"),
  );
  await page.goto("/");
  await expect(
    page.getByText(
      "请在本机终端运行 cloudflared access login --quiet https://eagle.hexly.ai，然后重试。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("radio", { name: "Prod", exact: true }),
  ).toBeChecked();
  await page.route("**/api/**", (route) =>
    route.fulfill({ json: { now: new Date().toISOString(), machines: [] } }),
  );
  await page.getByRole("radio", { name: "Local", exact: true }).click();
  await expect(
    page.getByRole("radio", { name: "Local", exact: true }),
  ).toBeChecked();
  await expect(page.locator(".access-gate")).toHaveCount(0);
});

test("hosted dashboard cannot enable the local production gateway through storage", async ({
  page,
}) => {
  await page.addInitScript(() =>
    sessionStorage.setItem("eagle-environment", "local"),
  );
  const paths: string[] = [];
  await page.route("**/api/**", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      json: { now: new Date().toISOString(), machines: [] },
    });
  });
  await page.goto("/");
  await expect(page.locator("#eagle-content")).toBeVisible();
  await expect(page.getByRole("group", { name: "环境" })).toHaveCount(0);
  expect(paths.length).toBeGreaterThan(0);
  expect(paths.every((path) => path.startsWith("/api/"))).toBe(true);
});

test("blocked storage refuses a switch without changing the backend", async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.assign(window, { __EAGLE_LOCAL__: true });
    Storage.prototype.setItem = () => {
      throw new Error("Blocked");
    };
  });
  const paths: string[] = [];
  await page.route("**/api/**", (route) => {
    paths.push(new URL(route.request().url()).pathname);
    return route.fulfill({
      json: { now: new Date().toISOString(), machines: [] },
    });
  });
  await page.goto("/");
  await page.getByRole("radio", { name: "Prod", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "无法保存环境选择，请允许会话存储后重试。",
  );
  await expect(
    page.getByRole("radio", { name: "Local", exact: true }),
  ).toBeChecked();
  expect(paths.every((path) => path.startsWith("/api/"))).toBe(true);
});

test("environment changes isolate realtime sockets and drafts without replaying input", async ({
  page,
}) => {
  await page.addInitScript(() =>
    Object.assign(window, { __EAGLE_LOCAL__: true }),
  );
  const now = new Date().toISOString();
  await page.route("**/api/**", (route) =>
    route.fulfill({
      json: {
        now,
        machines: [
          {
            id: "mac-one",
            name: "Same machine",
            report: report("environment-stream", now),
            lastSeen: now,
            receivedAt: now,
            warning: null,
          },
        ],
      },
    }),
  );
  const connections: string[] = [];
  const inputs: string[] = [];
  const active = new Set<unknown>();
  await page.routeWebSocket("**/api/v1/realtime?*", (socket) => {
    active.add(socket);
    const path = new URL(socket.url()).pathname;
    connections.push(path);
    socket.send(
      JSON.stringify({ type: "status", online: true, control: false }),
    );
    socket.send(
      JSON.stringify({
        type: "topology",
        spaceId: "default:w1",
        subscriptionId: "environment-test",
        tabs: [
          {
            id: "tab",
            name: "Build",
            panes: [
              {
                id: "w1:p1",
                terminalId: "same-terminal",
                title: "Synthetic terminal",
                rect: { x: 0, y: 0, width: 1, height: 1 },
              },
            ],
          },
        ],
      }),
    );
    socket.onMessage((data) => {
      const message = JSON.parse(String(data));
      if (message.type === "control")
        socket.send(
          JSON.stringify({ type: "status", online: true, control: true }),
        );
      if (message.type === "input") {
        inputs.push(path);
        socket.send(
          JSON.stringify({
            type: "ack",
            seq: message.seq,
            status: "submitted",
          }),
        );
      }
    });
    socket.onClose(() => active.delete(socket));
  });
  await page.goto("/?machine=mac-one");
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  const input = page.getByLabel("发送到当前 Pane");
  await input.fill("Local-only draft");
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "Prod", exact: true }).click();
  await expect.poll(() => active.size).toBe(0);
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await expect(input).toHaveValue("");
  expect([...new Set(connections)]).toEqual([
    "/api/v1/realtime",
    "/__local/prod/api/v1/realtime",
  ]);
  expect(inputs).toEqual([]);
  await input.fill("Synthetic production command");
  await page.getByRole("button", { name: "发送并回车" }).click();
  await expect.poll(() => inputs).toEqual(["/__local/prod/api/v1/realtime"]);
  await page.keyboard.press("Escape");
  await page.getByRole("radio", { name: "Local", exact: true }).click();
  await expect.poll(() => active.size).toBe(0);
  await page.getByRole("button", { name: "查看 Eagle", exact: true }).click();
  await expect(input).toHaveValue("Local-only draft");
  expect(inputs).toEqual(["/__local/prod/api/v1/realtime"]);
});
