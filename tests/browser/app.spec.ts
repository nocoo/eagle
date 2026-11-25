import { expect, test } from "@playwright/test";
import { MachineTelemetrySchema } from "../../packages/contracts/src/schema.ts";
import { report, telemetry } from "../fixtures.ts";

test.beforeEach(async ({ page }) => {
  await page.routeWebSocket("**/api/v1/realtime?*", (ws) => {
    ws.send(JSON.stringify({ type: "status", online: false, control: false }));
  });
});

test("global overview summarizes the fleet, opens a machine, and handles refresh errors", async ({
  page,
}) => {
  let fail = false;
  const now = new Date().toISOString();
  const snapshot = MachineTelemetrySchema.parse(telemetry(now));
  const machines = ["One", "Two"].map((name) => {
    const value = report(`fleet-${name}`, now);
    value.spaces[0].name = `${name} Space`;
    value.machine.telemetry = snapshot;
    return {
      id: name.toLowerCase(),
      name: `Mac ${name}`,
      report: value,
      lastSeen: now,
      receivedAt: now,
      warning: null,
    };
  });
  await page.route("**/api/**", (route) => {
    if (fail)
      return route.fulfill({ status: 503, json: { error: "unavailable" } });
    return route.fulfill({ json: { now, machines } });
  });
  await page.goto("/overview");
  await expect(page.getByRole("region", { name: "全部机器" })).toBeVisible();
  await expect(page.getByText("2/2 台机器在线")).toBeVisible();
  await page.getByRole("button", { name: "打开机器 Mac One" }).click();
  await expect(page.locator(".space-card")).toHaveCount(1);
  await expect(page.locator(".space-card")).toContainText("One Space");
  await expect(page.getByRole("region", { name: "机器资源" })).toContainText(
    "25%",
  );
  fail = true;
  await page.getByRole("button", { name: "刷新", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("连接中断");
  await expect(page.locator(".space-card")).toHaveCount(1);
});

test("Access expiry offers SSO without a token field", async ({ page }) => {
  await page.route("**/api/**", (route) =>
    route.fulfill({ status: 401, json: { error: "Access required" } }),
  );
  await page.goto("/overview");
  await expect(
    page.getByRole("button", { name: "通过 Cloudflare Access 继续" }),
  ).toBeVisible();
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);
});
