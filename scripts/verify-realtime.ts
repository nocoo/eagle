import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import { type AgentConfig, collect, sendReport } from "../agent/collector.ts";

const origin = process.env.EAGLE_VERIFY_ORIGIN || "https://eagle.dev.hexly.ai";
const config: AgentConfig = JSON.parse(
  await readFile(process.env.EAGLE_CONFIG || ".local/agent-dev.json", "utf8"),
);
const production = !origin.includes(".dev.");
const herdr = (...args: string[]) =>
  JSON.parse(execFileSync("herdr", args, { encoding: "utf8", timeout: 10000 }));
assert.equal(process.env.HERDR_ENV, "1", "Run from the project's Herdr pane");
const created = herdr(
  "pane",
  "split",
  "--current",
  "--direction",
  "right",
  "--ratio",
  "0.333",
  "--cwd",
  process.cwd(),
  "--no-focus",
).result.pane;
const browser = await chromium.launch();
try {
  const report = await collect(config);
  await sendReport(config.url, config.token, report);
  const space = report.spaces.find((s) =>
    s.tabs.some((t) => t.panes.some((p) => p.id === created.pane_id)),
  );
  assert(space);
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1050 },
  });
  if (production)
    await context.addCookies([
      {
        name: "CF_Authorization",
        value: (
          await readFile(
            process.env.EAGLE_ACCESS_JWT_FILE || ".local/access.jwt",
            "utf8",
          )
        ).trim(),
        domain: new URL(origin).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let opened = 0,
    closed = 0;
  page.on("websocket", (ws) => {
    if (!ws.url().includes("/api/v1/realtime?")) return;
    opened++;
    ws.on("close", () => closed++);
  });
  await page.goto(`${origin}/?machine=${encodeURIComponent(config.machineId)}`);
  await page
    .getByRole("button", { name: `查看 ${space.name}`, exact: true })
    .click();
  await page.getByRole("button", { name: "实时模式", exact: true }).click();
  await expect(page.getByRole("button", { name: "释放输入" })).toBeEnabled({
    timeout: 15000,
  });
  const pane = page.locator(".live-pane").filter({
    has: page.getByRole("button", {
      name: new RegExp(` · ${created.pane_id}$`),
    }),
  });
  await expect(pane.locator("pre")).not.toContainText("等待画面", {
    timeout: 15000,
  });
  await pane.getByRole("button").click();
  await expect(pane).toHaveAttribute("data-selected", "true");
  // Selecting another pane releases the default lease; reacquire only for our shell.
  if (await page.getByLabel("发送到当前 Pane", { exact: true }).isDisabled())
    await page.getByRole("button", { name: "接管输入" }).click();
  const marker = `EAGLE_REALTIME_${randomUUID().replaceAll("-", "")}`;
  // Only our newly created shell receives this harmless command. No other pane is controlled.
  await page
    .getByLabel("发送到当前 Pane", { exact: true })
    .fill(`printf '${marker}\\n'`);
  const sent = Date.now();
  await page.getByRole("button", { name: "发送并回车" }).click();
  await expect(pane.locator("pre")).toContainText(marker, { timeout: 15000 });
  await expect(page.getByText("已提交输入；请查看终端执行结果")).toBeVisible();
  // The marker must be output by the shell, not merely echoed on its command line.
  await expect
    .poll(async () =>
      (await pane.locator("pre").innerText())
        .split("\n")
        .some((line) => line.trim() === marker),
    )
    .toBe(true);
  const latencyMs = Date.now() - sent;
  await pane.screenshot({
    path: `.local/${production ? "production" : "local"}-realtime.png`,
  });
  await page.getByRole("button", { name: "当前任务", exact: true }).click();
  await expect.poll(() => closed).toBe(opened);
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "实时模式", exact: true }).click();
    await expect(page.locator(".live-pane").first()).toBeVisible();
    await page.getByRole("button", { name: "当前任务", exact: true }).click();
    await expect.poll(() => closed).toBe(opened);
  }
  assert.deepEqual(errors, []);
  const receipt = {
    origin,
    at: new Date().toISOString(),
    pane: created.pane_id,
    latencyMs,
    opened,
    closed,
    checks: [
      "real Herdr socket screens",
      "browser input to isolated shell",
      "shell output returned",
      "four subscriptions released",
      "no browser errors",
    ],
  };
  await writeFile(
    `.local/${production ? "production" : "local"}-realtime-verification.json`,
    JSON.stringify(receipt, null, 2),
  );
  console.log(JSON.stringify(receipt));
} finally {
  await browser.close();
  herdr("pane", "close", created.pane_id);
}
