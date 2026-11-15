import { expect, test } from "@playwright/test";
import { expectUI } from "lintapple/playwright";

test("public shell renders at phone and desktop widths", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("share the picture");
  await expect(page.getByRole("region", { name: "How a2a works" })).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await expectUI(page, testInfo);
});
