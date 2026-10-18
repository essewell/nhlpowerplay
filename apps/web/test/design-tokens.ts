/**
 * Parses colour tokens from docs/DESIGN.md and apps/web/app/globals.css and diffs them,
 * so the Tailwind theme cannot drift from the design doc. Test-only; no runtime use.
 *
 * Complexity: each parse is O(L) in input lines; compare is O(T) in token count.
 */

export type TokenMap = Map<string, string>;

const HEX = /#[0-9a-fA-F]{6}\b/;
const FILL_HEX = /\bfill\s+(#[0-9a-fA-F]{6})\b/i;
const CSS_COLOR = /^\s*--color-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/;

/**
 * Reads `| name | value | use |` rows. The first hex in the value cell is the token;
 * a `fill #HEX` part adds `<name>-fill` (DESIGN.md's `pp` row). Icon suffixes are ignored.
 * Rows without a hex (header, separator, non-colour rows) are skipped.
 */
export function parseDesignTokens(md: string): TokenMap {
  const out: TokenMap = new Map();
  for (const line of md.split(/\r?\n/)) {
    const cells = line.split("|").map((c) => c.trim());
    // A table row splits into ["", name, value, use, ""].
    if (cells.length < 4) continue;
    const name = cells[1];
    const value = cells[2];
    if (!name || !value) continue;
    const main = HEX.exec(value);
    if (!main) continue;
    const fill = FILL_HEX.exec(value);
    out.set(name, main[0].toUpperCase());
    if (fill?.[1]) out.set(`${name}-fill`, fill[1].toUpperCase());
  }
  return out;
}

/** Reads `--color-<name>: #HEX;` declarations. */
export function parseCssColors(css: string): TokenMap {
  const out: TokenMap = new Map();
  for (const line of css.split(/\r?\n/)) {
    const m = CSS_COLOR.exec(line);
    if (m?.[1] && m[2]) out.set(m[1], m[2].toUpperCase());
  }
  return out;
}

/** Every design token must exist in CSS with the same hex. Returns one message per problem. */
export function compareTokens(design: TokenMap, css: TokenMap): string[] {
  const problems: string[] = [];
  if (design.size === 0) problems.push("no tokens found in design doc");
  for (const [name, hex] of design) {
    const got = css.get(name);
    if (got === undefined) problems.push(`missing --color-${name} (design ${hex})`);
    else if (got !== hex) problems.push(`--color-${name} is ${got}, design says ${hex}`);
  }
  return problems;
}
