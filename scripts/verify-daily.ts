import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";
import {
  DailyContentSchema,
  DailySettingsSchema,
} from "../src/shared/daily.ts";

const origin = process.env.EAGLE_VERIFY_ORIGIN || "https://eagle.dev.hexly.ai";
const production = !origin.includes(".dev.");
const browser = await chromium.launch();
try {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1040 },
  });
  const anonymous = await context.request.get(`${origin}/api/v1/settings`, {
    maxRedirects: 0,
  });
  assert.equal(anonymous.status(), production ? 302 : 200);
  if (production) {
    const token = (
      await readFile(
        process.env.EAGLE_ACCESS_JWT_FILE || ".local/access.jwt",
        "utf8",
      )
    ).trim();
    await context.addCookies([
      {
        name: "CF_Authorization",
        value: token,
        domain: new URL(origin).hostname,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
  }
  const response = await context.request.get(`${origin}/api/v1/settings`);
  assert.equal(response.status(), 200);
  const settings = await response.json();
  assert(!Object.hasOwn(settings, "apiKey"));
  assert.equal(settings.schedule, "23:59");
  assert.equal(settings.timezone, "Asia/Shanghai");
  assert(!Object.hasOwn(settings, "intervalHours"));
  if (!settings.configured) {
    const run = await context.request.post(
      `${origin}/api/v1/daily-reports/run`,
      { data: {} },
    );
    assert.equal(run.status(), 200);
    assert.equal((await run.json()).skipped, "ai_not_configured");
  }
  const history = await context.request.get(
    `${origin}/api/v1/daily-reports?limit=12`,
  );
  assert.equal(history.status(), 200);
  const records = await history.json();
  assert(Array.isArray(records.entries));
  for (const entry of records.entries)
    DailyContentSchema.parse(entry.report.content);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${origin}/settings`);
  await expect(
    page.getByRole("switch", { name: "自动生成报告" }),
  ).toBeVisible();
  if (!settings.configured)
    await expect(
      page.getByText("未配置 AI，自动跳过报告生成。", { exact: true }),
    ).toBeVisible();
  let credentialSave = false;
  if (process.env.EAGLE_VERIFY_CREDENTIAL_SAVE === "1") {
    assert(
      !settings.hasApiKey,
      "Credential verification requires an unconfigured account",
    );
    const restore = Object.fromEntries(
      Object.keys(DailySettingsSchema.shape).map((key) => [key, settings[key]]),
    );
    const key = `eagle-verification-${crypto.randomUUID()}`;
    try {
      const enabled = page.getByRole("switch", { name: "自动生成报告" });
      if (await enabled.isChecked()) await enabled.click();
      await page.getByRole("combobox", { name: "提供商" }).click();
      await page.getByRole("option", { name: "自定义兼容服务" }).click();
      await page
        .getByLabel("模型", { exact: true })
        .fill("credential-verification-only");
      await page
        .getByLabel("API 地址", { exact: true })
        .fill("https://api.ai.example/v1");
      const input = page.getByLabel("API Key", { exact: true });
      await input.fill(key);
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "已保存", exact: true }),
      ).toBeVisible();
      await expect(input).toHaveValue("");
      const saved = await context.request.get(`${origin}/api/v1/settings`);
      const raw = await saved.text();
      assert(!raw.includes(key));
      assert.equal(JSON.parse(raw).hasApiKey, true);
      await page.reload();
      await expect(input).toHaveValue("");
      await expect(input).toHaveAttribute(
        "placeholder",
        "已配置，留空保留当前密钥",
      );
      await page.getByRole("button", { name: "清除密钥", exact: true }).click();
      await page.getByRole("button", { name: "保存设置", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "已保存", exact: true }),
      ).toBeVisible();
      assert.equal(
        (await (await context.request.get(`${origin}/api/v1/settings`)).json())
          .hasApiKey,
        false,
      );
      assert(
        !(await page
          .evaluate(() => JSON.stringify([localStorage, sessionStorage]))
          .then((value) => value.includes(key))),
      );
      credentialSave = true;
    } finally {
      const restored = await context.request.post(`${origin}/api/v1/settings`, {
        data: { ...restore, apiKey: null },
      });
      assert.equal(restored.status(), 200);
      await page.reload();
      await expect(
        page.getByRole("switch", { name: "自动生成报告" }),
      ).toBeVisible();
    }
  }
  const prefix = production ? "production" : "local";
  await page.screenshot({
    path: `.local/${prefix}-daily-settings.png`,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "最近历史", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "日报", exact: true }),
  ).toBeVisible();
  if (records.entries.length) {
    await page.getByRole("button", { name: "展开报告" }).first().click();
    const article = page.getByRole("article").first();
    await expect(article.locator(".daily-hour")).toHaveCount(24);
    const content = await article.textContent();
    await article.evaluate((element) =>
      element.setAttribute("data-eval-mounted", "yes"),
    );
    const refresh = page.getByRole("button", { name: "刷新日报" });
    await refresh.click();
    await expect(refresh).toBeEnabled();
    await expect(article).toHaveAttribute("data-eval-mounted", "yes");
    assert.equal(await article.textContent(), content);
  }
  await page.screenshot({
    path: `.local/${prefix}-daily-history.png`,
    animations: "disabled",
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: `.local/${prefix}-daily-mobile.png`,
    animations: "disabled",
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  const result = {
    origin,
    checkedAt: new Date().toISOString(),
    configured: settings.configured,
    schedule: settings.schedule,
    reports: records.entries.length,
    credentialSave,
    checks: [
      "viewer authentication",
      "secret absent from settings response",
      ...(settings.configured
        ? ["user AI configuration preserved"]
        : ["unconfigured generation skips"]),
      "D1 report query",
      "settings and history render",
      ...(records.entries.length
        ? ["all report sections render", "expanded report survives refresh"]
        : []),
      "mobile layout",
      "no browser errors",
    ],
  };
  await writeFile(
    `.local/${prefix}-daily-verification.json`,
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
} catch (error) {
  // Browser request errors may embed authentication headers; never print the raw exception.
  console.error(
    JSON.stringify({
      category: error instanceof Error ? error.name : "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  await browser.close();
}
