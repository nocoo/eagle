import { expect, test } from "@playwright/test";
import { fixture } from "./workspace-fixtures.ts";

test("root selects the first machine, switches workspaces, and isolates terminal drafts", async ({
  page,
}) => {
  const source = await fixture(page);
  await page.goto("/");
  await expect(page).toHaveURL(/machine=one/);
  await expect(page.locator(".space-card")).toHaveCount(2);

  await page.getByRole("button", { name: "全局总览", exact: true }).click();
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page.locator(".fleet-machine")).toHaveCount(2);

  const open = async (machine: string, space: string) => {
    await page.goto(`/?machine=${machine}`);
    await page
      .getByRole("button", { name: `查看 ${space}`, exact: true })
      .click();
  };
  const input = page.getByLabel("发送到当前 Pane");
  await open("one", "Build Workspace");
  await input.fill("machine one first pane");
  await page.getByRole("combobox", { name: "当前终端" }).click();
  await page
    .getByRole("option", { name: "Terminal 1-2 · w1:p2", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await input.fill("machine one second pane");
  await open("two", "Build Workspace");
  await expect(input).toHaveValue("");
  await open("one", "Build Workspace");
  await expect(input).toHaveValue("machine one first pane");
  expect(source.inputs()).toBe(0);
});
