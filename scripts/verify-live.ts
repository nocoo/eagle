import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { type AgentConfig, collect, sendReport } from "../agent/collector.ts";
import type { Overview } from "../src/shared/schema.ts";

const origin = process.env.EAGLE_VERIFY_ORIGIN || "https://eagle.dev.hexly.ai";
const config: AgentConfig = JSON.parse(
  await readFile(process.env.EAGLE_CONFIG || ".local/agent-dev.json", "utf8"),
);
const production = !origin.includes(".dev.");
const accessToken = production
  ? (
      await readFile(
        process.env.EAGLE_ACCESS_JWT_FILE || ".local/access.jwt",
        "utf8",
      )
    ).trim()
  : null;
const report = await collect(config);
await sendReport(config.url, config.token, report);
const duplicate = (await sendReport(config.url, config.token, report)) as {
  duplicate: boolean;
};
assert.equal(duplicate.duplicate, true);
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1050 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const anonymous = await context.request.get(`${origin}/api/v1/overview`, {
    maxRedirects: 0,
  });
  assert.equal(anonymous.status(), production ? 302 : 200);
  if (production) {
    assert.equal(
      new URL(anonymous.headers().location).hostname,
      "nocoo.cloudflareaccess.com",
    );
    assert(accessToken);
    await context.addCookies([
      {
        name: "CF_Authorization",
        value: accessToken,
        domain: new URL(origin).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  }
  await page.goto(`${origin}/overview`);
  await expect(page.getByLabel("访问令牌")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "当前态势" })).toBeVisible();
  const response = await context.request.get(`${origin}/api/v1/overview`);
  assert.equal(response.status(), 200);
  const overview = (await response.json()) as Overview;
  const machine = overview.machines.find((m) => m.id === config.machineId);
  assert(machine);
  assert(
    Date.parse(machine.report.capturedAt) >= Date.parse(report.capturedAt),
    "Live state must include this upload or a newer collector snapshot",
  );
  if (machine.report.reportId === report.reportId)
    assert.deepEqual(
      machine.report.machine.telemetry,
      report.machine.telemetry,
    );
  assert(report.machine.telemetry?.resources, "Real machine resources missing");
  assert.deepEqual(
    machine.report.spaces.map((s) => s.id).sort(),
    report.spaces.map((s) => s.id).sort(),
  );
  const prefix = origin.includes(".dev.") ? "local" : "production";
  await expect(page.locator(".space-card")).toHaveCount(0);
  await page.screenshot({
    animations: "disabled",
    path: `.local/${prefix}-fleet.png`,
  });
  await page.getByRole("button", { name: `打开机器 ${machine.name}` }).click();
  await expect(page.getByRole("region", { name: "当前工作态势" })).toHaveCount(
    0,
  );
  for (const space of report.spaces)
    await expect(
      page.getByRole("button", { name: `查看 ${space.name}`, exact: true }),
    ).toHaveCount(
      report.spaces.filter((candidate) => candidate.name === space.name).length,
    );
  const resources = page.getByRole("region", { name: "机器资源" }).first();
  await expect(resources).toContainText("CPU");
  await expect(resources).toContainText("GiB");
  for (const port of report.machine.telemetry.ports) {
    await expect(resources).toContainText(port.name);
    await expect(resources).toContainText(String(port.port));
  }
  assert(machine.revision > 0, "Expected durable machine revision");
  const currentCard = page
    .getByRole("region", { name: `${machine.name} 的工作空间` })
    .locator(".space-card")
    .first();
  await currentCard.evaluate((node) =>
    node.setAttribute("data-continuity", "original"),
  );
  const historyBefore = await (
    await context.request.get(
      `${origin}/api/v1/history?machine=${config.machineId}&limit=1`,
    )
  ).json();
  assert(
    historyBefore.entries.every(
      (entry: { report: { reportId: string } }) =>
        entry.report.reportId !== report.reportId,
    ),
  );
  const second = await collect(config);
  await sendReport(config.url, config.token, second);
  // The real daemon can upload again before the next browser poll.
  await expect
    .poll(
      async () =>
        Date.parse(
          (await page
            .locator(".machine-heading time")
            .getAttribute("datetime")) ?? "",
        ),
      { timeout: 12000 },
    )
    .toBeGreaterThanOrEqual(Date.parse(second.capturedAt));
  await expect(currentCard).toHaveAttribute("data-continuity", "original");
  const latest = (await (
    await context.request.get(`${origin}/api/v1/overview`)
  ).json()) as Overview;
  assert(
    (latest.machines.find((m) => m.id === config.machineId)?.revision ?? 0) >
      machine.revision,
  );
  const historyAfter = await (
    await context.request.get(
      `${origin}/api/v1/history?machine=${config.machineId}&limit=1`,
    )
  ).json();
  assert.deepEqual(
    historyAfter,
    historyBefore,
    "Current uploads must not append D1 history",
  );
  await currentCard.getByRole("button", { name: /^查看 / }).click();
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("Herdr 弱提示");
  await page.screenshot({
    animations: "disabled",
    path: `.local/${prefix}-detail.png`,
  });
  await page.keyboard.press("Escape");
  await page
    .getByRole("heading", { name: "Space 拓扑" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    animations: "disabled",
    path: `.local/${prefix}-desktop.png`,
  });
  await page.getByRole("button", { name: "查看最近历史" }).click();
  await expect(
    page.getByText("历史归档已暂停", { exact: false }),
  ).toBeVisible();
  if (historyAfter.entries.length) {
    await expect(
      page.getByText(`#${historyAfter.entries[0].seq}`, { exact: false }),
    ).toBeVisible();
  } else {
    await expect(
      page.getByText("暂无历史记录；当前状态可在总览查看。"),
    ).toBeVisible();
  }
  await page.getByRole("button", { name: "返回总览", exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    animations: "disabled",
    path: `.local/${prefix}-mobile.png`,
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  const storage = await page.evaluate(() => JSON.stringify(localStorage));
  assert(!accessToken || !storage.includes(accessToken));
  assert.deepEqual(errors, []);
  const result = {
    origin,
    checkedAt: new Date().toISOString(),
    machine: config.machineId,
    spaces: second.spaces.length,
    panes: second.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes)).length,
    reportId: second.reportId,
    checks: [
      production ? "anonymous Access redirect" : "local viewing without token",
      production ? "verified Access session" : "no login form",
      "real Herdr inventory in per-machine Durable Object",
      "real machine resources and configured TCP ports",
      "idempotent retry",
      "all Spaces rendered",
      "automatic refresh with stable DOM",
      "durable machine revision",
      "no new D1 history writes",
      "pane evidence",
      "legacy history remains readable",
      "desktop and mobile",
      "no browser errors",
    ],
  };
  await writeFile(
    `.local/${prefix}-verification.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
  await context.close();
} finally {
  await browser.close();
}
