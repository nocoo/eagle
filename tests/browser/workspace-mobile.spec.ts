import { expect, test } from "@playwright/test";
import { fixture } from "./workspace-fixtures.ts";

test("mobile workspace tabs switch in place and never carry drafts into another workspace", async ({
  page,
}, testInfo) => {
  const source = await fixture(page);
  await page.goto("/?machine=one");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  await expect(page.getByRole("region", { name: "工作区快照" })).toHaveCount(0);
  const input = page.getByLabel("发送到当前 Pane");
  await expect(input).toBeEnabled();
  await input.fill("local draft, never sent");
  const picker = page.getByRole("combobox", { name: "选择工作区" });
  await expect(picker).toContainText("Build Workspace");
  expect(
    await picker
      .locator("span")
      .first()
      .evaluate((element) => element.getBoundingClientRect().width),
  ).toBeGreaterThan(100);
  await picker.click();
  await page
    .getByRole("option", { name: "Build Workspace", exact: true })
    .click();
  await expect(input).toHaveValue("local draft, never sent");
  expect(source.opened()).toBe(1);
  await picker.click();
  await expect(page.getByRole("textbox", { name: "搜索工作区" })).toHaveCount(
    0,
  );
  await page
    .getByRole("option", { name: "Review Workspace", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await expect(input).toBeEnabled();
  await expect.poll(source.closed).toBe(1);
  await expect(picker).toContainText("Review Workspace");
  await expect(input).toHaveValue("");
  await expect.poll(source.opened).toBe(2);
  expect(source.inputs()).toBe(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator(".space-sheet").screenshot({
    path: testInfo.outputPath("workspace-mobile.png"),
    animations: "disabled",
  });
  await page.getByRole("button", { name: "关闭工作区", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("mobile selects from a scrollable workspace dropdown without search", async ({
  page,
}, testInfo) => {
  const source = await fixture(page, false, 20);
  await page.goto("/");
  await page
    .getByRole("button", { name: "查看 Build Workspace", exact: true })
    .click();
  const picker = page.getByRole("combobox", { name: "选择工作区" });
  await picker.click();
  await expect(page.getByRole("textbox", { name: "搜索工作区" })).toHaveCount(
    0,
  );
  await expect(page.getByRole("option")).toHaveCount(20);
  await page
    .locator(".workspace-picker")
    .screenshot({ path: testInfo.outputPath("workspace-picker-mobile.png") });
  await page.getByRole("option", { name: "Workspace 20", exact: true }).click();
  await expect(picker).toContainText("Workspace 20");
  await expect(picker).toBeFocused();
  await expect.poll(source.opened).toBe(2);
  expect(source.inputs()).toBe(0);
});
