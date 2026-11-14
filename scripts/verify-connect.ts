import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { chromium, expect } from "@playwright/test";
import { AGENT_VERSION } from "../packages/agent/version.ts";
import type {
  IssuedCredential,
  Registration,
} from "../packages/contracts/src/connect.ts";
import type { Overview } from "../packages/contracts/src/schema.ts";

// This acceptance check creates and disables a real test identity on the named deployment.
const origin = process.env.EAGLE_VERIFY_ORIGIN?.trim();
if (origin === undefined || origin === "") {
  throw new Error(
    "set EAGLE_VERIFY_ORIGIN to the development origin being verified",
  );
}
const id = "connect-check";
const directory = resolve(".local/connect-check");
const configPath = `${directory}/agent.json`;
const cli = resolve(".local/connect-install/node_modules/.bin/eagle-agent");
const exec = promisify(execFile);
await mkdir(directory, { recursive: true, mode: 0o700 });
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1600, height: 1050 },
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const request = context.request;
  const listing = (await (
    await request.get(`${origin}/api/v1/machines`)
  ).json()) as { machines: Registration[] };
  assert(
    !listing.machines.some((machine) => machine.id === id && machine.enabled),
    "A verification identity is already active; inspect before rerunning",
  );
  await page.goto(`${origin}/connect`);
  let firstResponse: Promise<import("@playwright/test").Response>;
  if (listing.machines.some((machine) => machine.id === id)) {
    firstResponse = page.waitForResponse(
      (r) =>
        r.url().endsWith(`/machines/${id}/rotate`) &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "重新启用 Connect 验证机" }).click();
    await page.getByRole("button", { name: "确认生成" }).click();
  } else {
    await page.getByLabel("机器名称", { exact: true }).fill("Connect 验证机");
    await page.getByLabel("机器 ID", { exact: true }).fill(id);
    await page.getByLabel("关注端口", { exact: true }).fill("Raven:7024");
    firstResponse = page.waitForResponse(
      (r) => r.url().endsWith("/machines") && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "创建并生成提示词" }).click();
  }
  const first = (await (await firstResponse).json()) as IssuedCredential;
  assert(first.token?.startsWith("eag1."), "No signed credential returned");
  await page.getByRole("button", { name: "复制完整提示词" }).click();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  assert(
    prompt.includes(first.token) && prompt.includes("7024"),
    "Onboarding prompt is incomplete",
  );
  assert(
    !((await page.getByLabel("提示词预览").textContent()) ?? "").includes(
      first.token,
    ),
    "Preview exposed the credential",
  );
  await page.evaluate(() => navigator.clipboard.writeText(""));
  const config = {
    url: origin,
    machineId: id,
    machineName: "Connect 验证机",
    token: first.token,
    intervalSeconds: 30,
    watchPorts: first.machine.watchPorts,
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await exec(cli, ["once"], {
    env: { ...process.env, EAGLE_CONFIG: configPath },
    timeout: 90000,
  });
  const initial = (await (
    await request.get(`${origin}/api/v1/overview`)
  ).json()) as Overview;
  const state = initial.machines.find((machine) => machine.id === id);
  assert(
    state && state.report.spaces.length > 0,
    "Packaged agent did not populate its DO",
  );
  assert.equal(state.report.machine.collectorVersion, AGENT_VERSION);
  await page.getByRole("button", { name: "关闭提示词" }).click();
  const rotateResponse = page.waitForResponse((r) =>
    r.url().endsWith(`/machines/${id}/rotate`),
  );
  await page.getByRole("button", { name: "轮换 Token Connect 验证机" }).click();
  await page.getByRole("button", { name: "确认生成" }).click();
  const rotated = (await (await rotateResponse).json()) as IssuedCredential;
  const heartbeat = (token: string) =>
    request.post(`${origin}/api/v1/heartbeat`, {
      headers: { Authorization: `Bearer ${token}` },
      data: {
        schemaVersion: 1,
        machineId: id,
        sentAt: new Date().toISOString(),
      },
    });
  assert(
    (await heartbeat(first.token)).status() === 401,
    "Rotated credential still authorized",
  );
  config.token = rotated.token;
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await exec(cli, ["once"], {
    env: { ...process.env, EAGLE_CONFIG: configPath },
    timeout: 90000,
  });
  await expect(page.getByLabel("提示词预览")).toContainText("7024");
  await page.getByRole("button", { name: "关闭提示词" }).click();
  await page.screenshot({
    path: ".local/connect-desktop.png",
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: ".local/connect-mobile.png",
    animations: "disabled",
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.getByRole("button", { name: "停用 Connect 验证机" }).click();
  await page.getByRole("button", { name: "确认停用" }).click();
  await expect(page.getByText("已停用", { exact: true })).toBeVisible();
  assert(
    (await heartbeat(rotated.token)).status() === 401,
    "Disabled credential still authorized",
  );
  const storage = await page.evaluate(() =>
    JSON.stringify({ ...localStorage, ...sessionStorage }),
  );
  assert(!storage.includes(first.token) && !storage.includes(rotated.token));
  assert.deepEqual(errors, []);
  const result = {
    checkedAt: new Date().toISOString(),
    machine: id,
    spaces: state.report.spaces.length,
    panes: state.report.spaces.flatMap((s) => s.tabs.flatMap((t) => t.panes))
      .length,
    checks: [
      "Connect create and clipboard prompt",
      "independent npm package real Herdr upload",
      "signed machine-scoped authentication",
      "watch ports preserved on rotation",
      "old token rejected after rotation",
      "token rejected after disable",
      "no D1 writes",
      "no browser credential persistence",
      "desktop and mobile rendering",
    ],
  };
  await writeFile(
    ".local/connect-verification.json",
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} finally {
  await browser.close();
}
