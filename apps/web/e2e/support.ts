/**
 * Shared e2e helpers. Expected values come from the synthetic fixtures and lib/copy.ts at test time,
 * never from hard-coded strings or numbers. Runs in the Playwright runner (node), not the browser.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { t, type CopyKey } from "../lib/copy.ts";

const SCENARIO_DIR = path.resolve(import.meta.dirname, "..", "dev-fixtures", "scenarios");

export interface FixtureScenario {
  id: string;
  pp: string;
  pk: string;
}

/** The single synthetic scenario the Daily resolves to (the pool holds one). O(files). */
export function fixtureScenario(): FixtureScenario {
  const files = readdirSync(SCENARIO_DIR).filter((f) => f.endsWith(".synthetic.json"));
  if (files.length !== 1) throw new Error(`e2e: expected exactly 1 synthetic scenario, found ${files.length}`);
  const raw = JSON.parse(readFileSync(path.join(SCENARIO_DIR, files[0] as string), "utf8")) as {
    id: string;
    pp: { abbrev: string };
    pk: { abbrev: string };
  };
  return { id: raw.id, pp: raw.pp.abbrev, pk: raw.pk.abbrev };
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Anchored RegExp for a copy template with each `{var}` replaced by `.+?`. */
export function copyRegex(template: string, flags = ""): RegExp {
  const parts = template.split(/\{[A-Za-z][A-Za-z0-9]*\}/g).map(escapeRe);
  return new RegExp(`^${parts.join(".+?")}$`, flags);
}

/** Regex for a lib/copy.ts key whose variables are unknown at test time. */
export function tRegex(key: CopyKey): RegExp {
  // t() throws on a missing variable, so hand it a Proxy that echoes `{name}` back.
  const echo = new Proxy({}, { get: (_o, name) => `{${String(name)}}` }) as Record<string, string>;
  return copyRegex(t(key, echo));
}

/** axe with the gate's rule set; returns one line per violating node (rule, selector, summary). */
export async function axeViolations(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa"])
    .withRules(["color-contrast"])
    .analyze();
  return result.violations.flatMap((v) =>
    v.nodes.map(
      (n) => `${v.id} (${v.impact ?? "n/a"}): ${n.target.join(" ")} :: ${n.failureSummary?.split("\n").slice(0, 2).join(" ") ?? ""}`,
    ),
  );
}

export async function expectNoAxeViolations(page: Page): Promise<void> {
  expect(await axeViolations(page), "axe violations").toEqual([]);
}

export const STATIC_PATHS = ["/how-it-works", "/about", "/privacy", "/terms"] as const;
