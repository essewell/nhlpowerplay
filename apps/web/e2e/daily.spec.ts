import { expect, test, type Locator, type Page } from "@playwright/test";
import { t } from "../lib/copy.ts";
import { fillCopy } from "../lib/play/strings.ts";
import { axeViolations, tRegex } from "./support.ts";

/** Hard stop for the play loop (docs: max 120 calls). */
const MAX_CALLS = 120;
/** How long one screen may take to appear after the previous call. */
const SCREEN_TIMEOUT_MS = 20_000;
const POLL_MS = 100;
/** Characters of visible page text shown in a failure message. */
const SHEET_TEXT_CHARS = 700;

type Screen = "results" | "intro" | "faceoff" | "entry" | "breakout" | "shot" | "decision" | "celebration";

const exactName = (s: string): RegExp => new RegExp(`^${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);

async function sheetText(page: Page): Promise<string> {
  const text = await page.locator("body").innerText().catch(() => "(page not readable)");
  return text.replace(/\s+/g, " ").slice(0, SHEET_TEXT_CHARS);
}

/** Which screen is showing right now; polls until one is, or fails with the visible text. O(screens) per poll. */
async function currentScreen(page: Page, calls: number): Promise<Screen> {
  const probes: [Screen, () => Locator][] = [
    ["intro", () => page.getByRole("button", { name: exactName(t("home.daily.cta")) })],
    ["faceoff", () => page.getByRole("heading", { name: t("faceoff.title") })],
    ["entry", () => page.getByRole("heading", { name: t("entry.title") })],
    ["breakout", () => page.getByRole("heading", { name: fillCopy("breakout.title") })],
    ["shot", () => page.getByRole("heading", { level: 1, name: tRegex("shot.title") })],
    ["decision", () => page.getByRole("tablist", { name: t("pause.tabs") })],
    ["celebration", () => page.getByRole("button", { name: t("celebrate.continue") })],
  ];
  const deadline = Date.now() + SCREEN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (new URL(page.url()).pathname === "/results") return "results";
    for (const [name, loc] of probes) {
      if (await loc().isVisible()) return name;
    }
    await page.waitForTimeout(POLL_MS);
  }
  throw new Error(`No known play screen after ${SCREEN_TIMEOUT_MS} ms (calls made: ${calls}, url ${page.url()}). Visible text: ${await sheetText(page)}`);
}

async function clickFirstEnabled(group: Locator, what: string, page: Page): Promise<void> {
  const btn = group.locator("button:enabled:not([aria-label])").first();
  try {
    await btn.waitFor({ state: "visible", timeout: SCREEN_TIMEOUT_MS });
  } catch {
    throw new Error(`No enabled ${what} to pick. Visible text: ${await sheetText(page)}`);
  }
  await btn.click();
}

/** Opening faceoff: first taker, first target, "Drop the puck". */
async function doFaceoff(page: Page): Promise<void> {
  await clickFirstEnabled(page.getByRole("group", { name: t("faceoff.taker.label") }), "faceoff taker", page);
  await clickFirstEnabled(page.getByRole("group", { name: t("faceoff.target.label") }), "faceoff target", page);
  await page.getByRole("button", { name: t("faceoff.cta") }).click();
}

/** Zone entry / breakout: one tap on the first enabled option. */
async function doMethod(page: Page): Promise<void> {
  await clickFirstEnabled(page.locator("section"), "call option", page);
}

/** Shot picker: first shot type + first target that together enable "Shoot", then Shoot. */
async function doShot(page: Page): Promise<void> {
  const types = page.getByRole("group", { name: t("shot.section.type") }).locator("button:enabled");
  const targets = page.getByRole("group", { name: t("shot.section.target") }).locator("button");
  const shoot = page.getByRole("button", { name: exactName(t("shot.cta")) });
  const typeCount = await types.count();
  for (let i = 0; i < typeCount; i += 1) {
    await types.nth(i).click();
    const corners = await targets.count();
    for (let j = 0; j < corners; j += 1) {
      if (!(await targets.nth(j).isEnabled())) continue;
      await targets.nth(j).click();
      if (await shoot.isVisible()) {
        await shoot.click();
        return;
      }
    }
  }
  throw new Error(`Shot picker offered no shot type + target combination. Visible text: ${await sheetText(page)}`);
}

/**
 * Decision pause. The first pause takes the PASS tab's first row; the next goes SHOOT so both paths run.
 * An empty PASS tab falls through to SHOOT.
 * Returns true when the call was a shot (the picker then takes over the next iteration).
 */
async function doDecision(page: Page, preferShoot: boolean): Promise<boolean> {
  const panelRows = page.getByRole("tabpanel").locator("button:enabled:not([aria-label])");
  if (!preferShoot) {
    await page.getByRole("tab", { name: t("pause.tab.pass") }).click();
    const first = panelRows.first();
    const appeared = await first.waitFor({ state: "visible", timeout: 5_000 }).then(() => true, () => false);
    if (appeared) {
      await first.click();
      return false;
    }
  }
  await page.getByRole("tab", { name: t("pause.tab.shoot") }).click();
  await page.getByRole("button", { name: fillCopy("play.shoot.open") }).click();
  return true;
}

test.describe("Daily, start to finish (390x844 touch)", () => {
  test("plays the Daily from Home to Results, then the Daily is locked", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: t("home.daily.cta") }).tap();
    await expect(page).toHaveURL(/\/play\/daily$/);

    // Press start.
    const start = page.getByRole("button", { name: exactName(t("home.daily.cta")) });
    await start.tap();
    await expect(start, "intro should leave after pressing start").toBeHidden();

    let calls = 0;
    let decisions = 0;
    let axeChecked = false;
    const visited: Screen[] = [];
    for (;;) {
      const screen = await currentScreen(page, calls);
      if (screen === "results") break;
      if (visited[visited.length - 1] !== screen) visited.push(screen);
      if (calls >= MAX_CALLS) {
        throw new Error(`Daily still running after ${MAX_CALLS} calls (screen: ${screen}). Visible text: ${await sheetText(page)}`);
      }
      switch (screen) {
        case "intro":
          throw new Error(`Back on the intro after starting. Visible text: ${await sheetText(page)}`);
        case "faceoff":
          await doFaceoff(page);
          calls += 1;
          break;
        case "entry":
        case "breakout":
          await doMethod(page);
          calls += 1;
          break;
        case "shot":
          await doShot(page);
          calls += 1;
          break;
        case "decision": {
          if (!axeChecked) {
            axeChecked = true;
            // Wait for the option rows so axe sees the real sheet, not the loading skeleton.
            await page.getByRole("tabpanel").locator("button:enabled").first().waitFor({ timeout: SCREEN_TIMEOUT_MS });
            expect.soft(await axeViolations(page), "axe on /play/daily (decision pause)").toEqual([]);
          }
          const shot = await doDecision(page, decisions % 2 === 1);
          decisions += 1;
          if (!shot) calls += 1;
          break;
        }
        case "celebration":
          await page.getByRole("button", { name: t("celebrate.continue") }).click();
          break;
      }
      // Let the click land before probing again (the next screen replaces this one).
      await page.waitForTimeout(POLL_MS);
    }

    test.info().annotations.push({ type: "screens visited", description: `${visited.join(" > ")} (${calls} calls)` });

    // Results: banner (goal / kill held / shorthanded goal), axe, and the URL contract.
    await expect(page).toHaveURL(/\/results\?mode=daily$/);
    const banner = page.getByText(
      new RegExp(`^(${[t("results.banner.goal"), t("results.banner.noGoal"), t("results.banner.shortie")].map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})$`),
    );
    await expect(banner).toBeVisible();
    expect.soft(await axeViolations(page), "axe on /results").toEqual([]);

    // Reload: the finished run is stored, so Results renders again.
    await page.reload();
    await expect(banner).toBeVisible();

    // Daily is locked: Home shows the played state, and /play/daily bounces back to Results.
    await page.goto("/");
    await expect(page.getByText(tRegex("home.daily.played"))).toBeVisible();
    await expect(page.getByRole("link", { name: t("home.daily.played.cta") })).toBeVisible();
    await expect(page.getByRole("link", { name: t("home.daily.cta") })).toHaveCount(0);
    await page.goto("/play/daily");
    await expect(page).toHaveURL(/\/results\?mode=daily$/);
  });
});
