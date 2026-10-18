import { test } from "node:test";
import assert from "node:assert/strict";
import { meterPercent, nextTabIndex, splitTemplate } from "../components/ui/logic.ts";
import { cx } from "../components/ui/cx.ts";
import { formatLegalDate, isProductionDeploy, SITE_CONFIG } from "./site.ts";

test("meterPercent: clamps to 0..100 and rounds", () => {
  assert.equal(meterPercent(0), 0);
  assert.equal(meterPercent(1), 100);
  assert.equal(meterPercent(0.126), 13);
  assert.equal(meterPercent(-0.5), 0);
  assert.equal(meterPercent(7), 100);
});

test("meterPercent: non-finite input draws an empty meter", () => {
  for (const bad of [Number.NaN, Infinity, -Infinity]) assert.equal(meterPercent(bad), 0);
});

test("nextTabIndex: arrows wrap, Home and End jump", () => {
  assert.equal(nextTabIndex(0, "ArrowRight", 4), 1);
  assert.equal(nextTabIndex(3, "ArrowRight", 4), 0);
  assert.equal(nextTabIndex(0, "ArrowLeft", 4), 3);
  assert.equal(nextTabIndex(2, "Home", 4), 0);
  assert.equal(nextTabIndex(1, "End", 4), 3);
});

test("nextTabIndex: unhandled keys, empty list and bad index return null", () => {
  assert.equal(nextTabIndex(0, "Enter", 4), null);
  assert.equal(nextTabIndex(0, "ArrowRight", 0), null);
  assert.equal(nextTabIndex(4, "ArrowRight", 4), null);
  assert.equal(nextTabIndex(-1, "Home", 4), null);
  assert.equal(nextTabIndex(0.5, "Home", 4), null);
});

test("nextTabIndex: a single tab stays put", () => {
  assert.equal(nextTabIndex(0, "ArrowRight", 1), 0);
  assert.equal(nextTabIndex(0, "ArrowLeft", 1), 0);
});

test("splitTemplate: slots become parts, other braces stay text", () => {
  assert.deepEqual(splitTemplate("Questions: {contactEmail}", ["contactEmail"]), [
    { text: "Questions: " },
    { slot: "contactEmail" },
  ]);
  assert.deepEqual(splitTemplate("Last updated: {date} / {other}", ["date"]), [
    { text: "Last updated: " },
    { slot: "date" },
    { text: " / {other}" },
  ]);
  assert.deepEqual(splitTemplate("no slots", ["date"]), [{ text: "no slots" }]);
  assert.deepEqual(splitTemplate("", ["date"]), []);
  assert.deepEqual(splitTemplate("{a}{a}", ["a"]), [{ slot: "a" }, { slot: "a" }]);
});

test("cx drops falsy parts", () => {
  assert.equal(cx("a", false, null, undefined, "b"), "a b");
  assert.equal(cx(), "");
});

test("formatLegalDate: valid ISO formats, null/garbage give null (placeholder shown)", () => {
  assert.equal(formatLegalDate(null), null);
  assert.equal(formatLegalDate("not a date"), null);
  assert.equal(formatLegalDate("2026-13-45"), null);
  assert.match(formatLegalDate("2026-03-05") ?? "", /March/);
});

test("SITE_CONFIG ships unset so the legal pages show visible TODOs (LAUNCH go/no-go)", () => {
  assert.equal(SITE_CONFIG.contactEmail, null);
  assert.equal(SITE_CONFIG.legalUpdated, null);
});

test("isProductionDeploy matches next.config.ts: only unset or production indexes", () => {
  assert.equal(isProductionDeploy({}), true);
  assert.equal(isProductionDeploy({ CONTEXT: "production" }), true);
  assert.equal(isProductionDeploy({ CONTEXT: "deploy-preview" }), false);
  assert.equal(isProductionDeploy({ CONTEXT: "branch-deploy" }), false);
  assert.equal(isProductionDeploy({ CONTEXT: "dev" }), false);
});
