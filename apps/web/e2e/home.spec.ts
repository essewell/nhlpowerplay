import { expect, test } from "@playwright/test";
import { t } from "../lib/copy.ts";
import { fixtureScenario, STATIC_PATHS, tRegex } from "./support.ts";

const MENU_LINKS = [
  { key: "nav.howItWorks", path: "/how-it-works" },
  { key: "nav.about", path: "/about" },
  { key: "footer.link.privacy", path: "/privacy" },
  { key: "footer.link.terms", path: "/terms" },
] as const;

test.describe("Home", () => {
  test("renders the Daily card from the data files", async ({ page }) => {
    const sc = fixtureScenario();
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 2, name: tRegex("home.daily.eyebrow") })).toBeVisible();
    await expect(page.getByText(t("home.daily.badge"))).toBeVisible();
    await expect(page.getByText(sc.pp, { exact: true })).toBeVisible();
    await expect(page.getByText(sc.pk, { exact: true })).toBeVisible();
    await expect(page.getByText(t("home.daily.yourBench"), { exact: true })).toBeVisible();
    await expect(page.getByText(t("home.daily.killing"), { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: t("home.daily.cta") })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(`^${t("home.tile.daily.title")}`) })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(`^${t("home.tile.endless.title")}`) })).toBeVisible();
  });

  test("menu sheet opens and closes (button, Escape)", async ({ page }) => {
    await page.goto("/");
    const menu = page.getByRole("button", { name: t("home.menu") });
    const dialog = page.getByRole("dialog", { name: t("home.menu") });
    await expect(dialog).toBeHidden();
    await menu.click();
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: t("action.close") }).click();
    await expect(dialog).toBeHidden();
    await menu.click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  });

  for (const link of MENU_LINKS) {
    test(`menu link ${link.path} navigates`, async ({ page }) => {
      await page.goto("/");
      await page.getByRole("button", { name: t("home.menu") }).click();
      await page.getByRole("dialog").getByRole("link", { name: t(link.key), exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${link.path}$`));
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    });
  }

  test("footer links on a static page reach every static page", async ({ page }) => {
    for (const link of MENU_LINKS) {
      await page.goto("/about");
      const nav = page.getByRole("navigation", { name: t("footer.nav.label") });
      await nav.getByRole("link", { name: t(link.key), exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${link.path}$`));
    }
  });

  test("footer carries the non-affiliation notice on Home and every static page", async ({ page }) => {
    for (const p of ["/", ...STATIC_PATHS]) {
      await page.goto(p);
      await expect(page.getByText(t("footer.notice")), p).toBeVisible();
    }
  });
});
