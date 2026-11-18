import { expect, test } from "@playwright/test";
import { expectUI } from "lintapple/playwright";

test("public shell renders at phone and desktop widths", async ({ page }, testInfo) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toContainText("Stay in the terminal");
  await expect(page.getByRole("region", { name: "How a2a works" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Start in your project folder." })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy command" })).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy command" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain(`--url ${new URL(page.url()).origin}`);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await expectUI(page, testInfo);
});

test("the former dashboard has no public page", async ({ request }) => {
  expect((await request.get("/workspaces")).status()).toBe(404);
  expect((await request.get("/join")).status()).toBe(404);
  expect((await request.get("/w/demo")).status()).toBe(404);
});
