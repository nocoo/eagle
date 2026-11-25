import { expect, test } from "@playwright/test";
import pkg from "../../package.json" with { type: "json" };

test("Connect manages machines and generates a one-time onboarding prompt without browser persistence", async ({
  page,
}) => {
  let machines: {
    id: string;
    name: string;
    enabled: boolean;
    source: string;
    expiresAt: string;
  }[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/v1/machines" && request.method() === "GET")
      return route.fulfill({
        json: {
          machines,
          canIssue: true,
          machineGroups: { groups: [], assignments: {} },
        },
      });
    if (path === "/api/v1/machines") {
      machines = [
        {
          ...request.postDataJSON(),
          enabled: true,
          source: "managed",
          expiresAt: "2027-09-19T00:00:00Z",
        },
      ];
      return route.fulfill({
        status: 201,
        json: {
          machine: machines[0],
          token: "eag1.test-only-never-persisted-token",
        },
      });
    }
    if (path.endsWith("/revoke")) {
      machines[0].enabled = false;
      return route.fulfill({ json: { machine: machines[0] } });
    }
    return route.fulfill({
      json: {
        now: new Date().toISOString(),
        machines: [],
        pendingMachines: [],
        machineGroups: { groups: [], assignments: {} },
      },
    });
  });
  await page.goto("/connect");
  await expect(page.getByRole("heading", { name: "添加机器" })).toBeVisible();
  await page.getByLabel("机器名称", { exact: true }).fill("Studio Mac");
  await page.getByLabel("机器 ID", { exact: true }).fill("studio-mac");
  await page.getByLabel("关注端口", { exact: true }).fill("Raven:7024");
  await page.getByRole("button", { name: "创建并生成提示词" }).click();
  await expect(page.getByRole("heading", { name: "接入提示词" })).toBeVisible();
  await expect(page.getByLabel("提示词预览")).toContainText(
    `npm install -g @nocoo/eagle-agent@${pkg.config.publishedAgentVersion} --registry=https://registry.npmjs.org`,
  );
  await expect(page.getByLabel("提示词预览")).not.toContainText(
    "eag1.test-only",
  );
  expect(
    await page.evaluate(() =>
      JSON.stringify({ ...localStorage, ...sessionStorage }),
    ),
  ).not.toContain("eag1.");
  await page.getByRole("button", { name: "关闭提示词" }).click();
  await page.getByRole("button", { name: "停用 Studio Mac" }).click();
  await page.getByRole("button", { name: "确认停用" }).click();
  await expect(page.getByText("已停用", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "重新启用 Studio Mac" }),
  ).toBeVisible();
});
