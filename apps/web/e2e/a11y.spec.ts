import { test } from "@playwright/test";
import { t } from "../lib/copy.ts";
import { expectNoAxeViolations, STATIC_PATHS } from "./support.ts";

test.describe("axe: wcag2a, wcag2aa, color-contrast", () => {
  test("/ (daily card loaded)", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: t("home.daily.cta") }).waitFor();
    await expectNoAxeViolations(page);
  });

  test("/ with the menu sheet open", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: t("home.menu") }).click();
    await page.getByRole("dialog").waitFor();
    await expectNoAxeViolations(page);
  });

  for (const p of STATIC_PATHS) {
    test(p, async ({ page }) => {
      await page.goto(p);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await expectNoAxeViolations(page);
    });
  }
});
