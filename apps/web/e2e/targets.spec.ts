import { expect, test, type Page } from "@playwright/test";
import { t } from "../lib/copy.ts";
import { STATIC_PATHS } from "./support.ts";

/** 44 CSS px (docs/DESIGN.md). Sub-pixel layout can report 43.99, so allow 0.5 px. */
const MIN = 43.5;
const INTERACTIVE = "a[href], button, input, select, textarea, summary, [role=button], [role=tab], [role=link]";

/**
 * Explicit exception: an inline text link that sits inside running prose (<p>, <li>, <dd>) next to other
 * text (WCAG 2.5.8 inline exemption). Everything else, including a link that is the whole content of its
 * paragraph, must be >= 44x44. Exceptions are reported as test annotations.
 */
async function measure(page: Page): Promise<{ small: string[]; inline: string[]; count: number }> {
  return page.evaluate(
    ({ selector, min }) => {
      const small: string[] = [];
      const inline: string[] = [];
      let count = 0;
      const label = (el: Element): string => {
        const text = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40);
        return `${el.tagName.toLowerCase()}[${text}]`;
      };
      for (const el of Array.from(document.querySelectorAll(selector))) {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        if (r.width === 0 || r.height === 0 || cs.visibility === "hidden" || el.closest("dialog:not([open])")) continue;
        count += 1;
        if (r.width >= min && r.height >= min) continue;
        const block = el.closest("p, li, dd");
        const own = el.textContent?.trim() ?? "";
        const isInline = el.tagName === "A" && block !== null && (block.textContent?.trim().length ?? 0) > own.length;
        const text = `${label(el)} ${Math.round(r.width)}x${Math.round(r.height)}`;
        (isInline ? inline : small).push(text);
      }
      return { small, inline, count };
    },
    { selector: INTERACTIVE, min: MIN },
  );
}

for (const p of ["/", ...STATIC_PATHS]) {
  test(`touch targets >= 44x44 on ${p}`, async ({ page }, info) => {
    await page.goto(p);
    if (p === "/") await page.getByRole("link", { name: t("home.daily.cta") }).waitFor();
    else await page.getByRole("heading", { level: 1 }).waitFor();
    const m = await measure(page);
    expect(m.count, "interactive elements found").toBeGreaterThan(0);
    for (const i of m.inline) info.annotations.push({ type: "inline-link exception", description: i });
    expect(m.small, "targets under 44x44").toEqual([]);
  });
}

test("touch targets >= 44x44 inside the open menu sheet", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: t("home.menu") }).click();
  await page.getByRole("dialog").waitFor();
  const m = await measure(page);
  expect(m.small, "targets under 44x44").toEqual([]);
});
