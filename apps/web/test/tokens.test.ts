import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compareTokens, parseCssColors, parseDesignTokens } from "./design-tokens.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const MD = [
  "| Token | Value | Use |",
  "| --- | --- | --- |",
  "| bg | #0B1220 | Page ground |",
  "| pp | #9CCBFF / fill #13305A | Your skaters |",
  "| grade-best | #2E9E6B + ✓ | Best call |",
].join("\n");

test("real globals.css matches every DESIGN.md colour token", () => {
  const design = parseDesignTokens(read("../../../docs/DESIGN.md"));
  const css = parseCssColors(read("../app/globals.css"));
  assert.ok(design.size >= 18, `expected the full token table, got ${design.size}`);
  assert.deepEqual(compareTokens(design, css), []);
});

test("parses plain, fill and icon-suffixed rows; skips header and separator", () => {
  const t = parseDesignTokens(MD);
  assert.deepEqual([...t.entries()], [
    ["bg", "#0B1220"],
    ["pp", "#9CCBFF"],
    ["pp-fill", "#13305A"],
    ["grade-best", "#2E9E6B"],
  ]);
});

test("edge: missing CSS token is reported", () => {
  const css = parseCssColors("--color-bg: #0B1220;\n--color-pp: #9CCBFF;\n--color-grade-best: #2E9E6B;");
  assert.deepEqual(compareTokens(parseDesignTokens(MD), css), ["missing --color-pp-fill (design #13305A)"]);
});

test("edge: hex mismatch is reported", () => {
  const css = parseCssColors(
    "--color-bg: #000000;\n--color-pp: #9CCBFF;\n--color-pp-fill: #13305A;\n--color-grade-best: #2E9E6B;",
  );
  assert.deepEqual(compareTokens(parseDesignTokens(MD), css), ["--color-bg is #000000, design says #0B1220"]);
});

test("edge: hex comparison is case-insensitive", () => {
  const css = parseCssColors(
    "--color-bg: #0b1220;\n--color-pp: #9ccbff;\n--color-pp-fill: #13305a;\n--color-grade-best: #2e9e6b;",
  );
  assert.deepEqual(compareTokens(parseDesignTokens(MD), css), []);
});

test("edge: empty design doc is an error, not a silent pass", () => {
  assert.deepEqual(compareTokens(parseDesignTokens(""), parseCssColors("--color-bg: #0B1220;")), [
    "no tokens found in design doc",
  ]);
});

test("edge: CRLF line endings and non-colour CSS vars", () => {
  const t = parseDesignTokens(MD.replaceAll("\n", "\r\n"));
  assert.equal(t.get("pp-fill"), "#13305A");
  const css = parseCssColors("  --radius-sm: 10px;\r\n  --color-bg: #0B1220;\r\n");
  assert.deepEqual([...css.entries()], [["bg", "#0B1220"]]);
});

test("edge: rows without a hex (e.g. prose tables) are ignored", () => {
  const t = parseDesignTokens("| Type | Barlow Condensed | headings |\n| radius | 10 | cards |");
  assert.equal(t.size, 0);
});
