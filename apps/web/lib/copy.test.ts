import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { COPY, PENDING_COPY, PENDING_COPY_KEYS, hasCopy, pctValue, periodOrdinal, rawCopy, spotName, t } from "./copy.ts";
import { OZ_SPOTS } from "@powerplay/engine/constants.ts";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const COPY_MD = read("../../../docs/COPY.md");

/** COPY.md placeholders renamed in copy.ts so callers can pass plain identifiers. */
const RENAMES: Array<[string, string]> = [
  ["{m:ss}", "{clock}"],
  ["{L/R}", "{hand}"],
  ["{blocker/glove}", "{side}"],
];
const rename = (s: string) => RENAMES.reduce((acc, [from, to]) => acc.split(from).join(to), s);

/** Drop `[developer notes]` and trim; a cell that is only a note becomes "". */
const stripNotes = (cell: string) => cell.replace(/\s*\[[^\]]*\]/g, "").trim();

const SECTION_PREFIX: Array<[RegExp, string]> = [
  [/^## 1\./, ""],
  [/^### 4\.1/, "home."],
  [/^### 4\.2/, "pause."],
  [/^### 4\.3/, "shot."],
  [/^### 4\.4/, "results."],
  [/^## 10\./, ""],
];

/** Every `key | copy` table row and `- \`key\`: copy` bullet of the sections that carry keys. */
function parseCopyMd(md: string): Map<string, string> {
  const out = new Map<string, string>();
  let prefix: string | null = null;
  let setPlays = false;
  let lastBullet: string | null = null;
  for (const line of md.split(/\r?\n/)) {
    // An indented line right after a bullet is that bullet's wrapped text.
    if (lastBullet !== null && /^\s{2,}\S/.test(line) && !line.trimStart().startsWith("-")) {
      out.set(lastBullet, stripNotes(`${out.get(lastBullet) ?? ""} ${line.trim()}`));
      continue;
    }
    lastBullet = null;
    if (/^#{2,3} /.test(line)) {
      setPlays = /^### 5\.1/.test(line);
      const hit = SECTION_PREFIX.find(([re]) => re.test(line));
      prefix = hit ? hit[1] : null;
      continue;
    }
    const bullet = /^- `([A-Za-z][\w.]*)`: (.+)$/.exec(line);
    if (bullet?.[1] && bullet[2]) {
      out.set(bullet[1], stripNotes(bullet[2]));
      lastBullet = bullet[1];
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    const key = cells[1];
    if (!key || key === "Key" || /^-+$/.test(key) || !/^[A-Za-z][\w.]*$/.test(key)) continue;
    if (setPlays) {
      out.set(`${key}.name`, stripNotes(cells[2] ?? ""));
      out.set(`${key}.sub`, stripNotes(cells[3] ?? ""));
    } else if (prefix !== null) {
      out.set(`${prefix}${key}`, stripNotes(cells[2] ?? ""));
    }
  }
  return out;
}

/** Whitespace-collapsed, markdown-bold-free text of COPY.md for prose-section checks. */
const FLAT_MD = COPY_MD.replace(/\*\*/g, "").replace(/\[[^\]]*\]/g, "").replace(/\s+/g, " ").toLowerCase();
const flat = (s: string) => s.replace(/\s+/g, " ");

/** Rows that are config or developer notes in COPY.md, not strings the UI shows. */
const NOT_UI_COPY = new Set(["og.image", "robots"]);

test("every COPY.md key is present with the same text (placeholders renamed, notes dropped)", () => {
  const rows = parseCopyMd(COPY_MD);
  assert.ok(rows.size > 150, `expected a full COPY.md parse, got ${rows.size} rows`);
  const problems: string[] = [];
  for (const [key, text] of rows) {
    if (NOT_UI_COPY.has(key) || text === "") continue;
    const ours = (COPY as Record<string, string>)[key];
    if (ours === undefined) problems.push(`missing key ${key}`);
    else if (ours !== rename(text)) problems.push(`${key}: "${ours}" != COPY.md "${rename(text)}"`);
  }
  assert.deepEqual(problems, []);
});

test("prose sections (how, about, privacy, terms) match COPY.md text", () => {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(COPY)) {
    if (!/^(how|about|privacy|terms)\./.test(key)) continue;
    // Fragments split around markup (labels, link text) must still appear in COPY.md.
    if (!FLAT_MD.includes(flat(value).trim().toLowerCase())) problems.push(`${key}: "${value}" not found in COPY.md`);
  }
  assert.deepEqual(problems, []);
});

test("no digit-percent figures or four-digit years inside copy values (templates only)", () => {
  // COPY.md's own legend tooltip uses an illustrative worked example ("12.0% instead of 12.5%"), flagged
  // there as "illustrative, not data". It is the only allowed value with figures.
  const ALLOWED = new Set(["results.legend.info"]);
  const bad: string[] = [];
  for (const [key, value] of Object.entries({ ...COPY, ...PENDING_COPY })) {
    if (ALLOWED.has(key)) continue;
    if (/\d+(\.\d+)?\s*%/.test(value) || /\b(19|20)\d{2}\b/.test(value)) bad.push(`${key}: ${value}`);
  }
  assert.deepEqual(bad, []);
});

test("no emoji anywhere in copy (grade glyphs in the legend are the only symbols allowed)", () => {
  const emoji = /\p{Extended_Pictographic}/u;
  const allowed = new Set(["✓", "•", "▲", "✕"]);
  for (const [key, value] of Object.entries({ ...COPY, ...PENDING_COPY })) {
    for (const ch of value) {
      if (emoji.test(ch) && !allowed.has(ch)) assert.fail(`${key} contains emoji ${ch}`);
    }
  }
});

test("COPY and PENDING_COPY share no keys", () => {
  const shared = PENDING_COPY_KEYS.filter((k) => k in COPY);
  assert.deepEqual(shared, []);
});

test("PENDING_COPY.md lists exactly the PENDING_COPY keys with the same text", () => {
  const md = read("./PENDING_COPY.md");
  const listed = new Map<string, string>();
  for (const line of md.split(/\r?\n/)) {
    const m = /^\| ([A-Za-z][\w.]*) \| (.*) \| [^|]+ \|$/.exec(line);
    if (m?.[1] && m[2] !== undefined && m[1] !== "Key") listed.set(m[1], m[2].replace(/\\\|/g, "|"));
  }
  assert.deepEqual([...listed.keys()].sort(), [...PENDING_COPY_KEYS].sort());
  for (const [key, text] of listed) assert.equal(text, (PENDING_COPY as Record<string, string>)[key], key);
});

test("t: interpolates {vars}, numbers included, repeated placeholders all replaced", () => {
  assert.equal(t("daily.next", { h: 3, m: 7 }), "Next Daily in 3h 7m");
  assert.equal(t("shot.targets", { side: "glove" }), "Top left · glove · Top right · glove · Low blocker · 5-hole · Low glove");
  assert.equal(t("app.name"), "PowerPlay");
});

test("t: percent templates take pctValue (engine pct without the sign)", () => {
  assert.equal(t("pause.pass.row.pct", { pct: pctValue(0.123) }), "12% connects");
  assert.equal(t("pause.skate.row.pct", { pct: pctValue(0.001) }), "<1% keeps puck");
  assert.equal(pctValue(Number.NaN), "n/a");
  assert.equal(pctValue(1), "100");
  assert.equal(pctValue(0), "<1");
});

test("t: unknown key throws outside production, returns the key in production", () => {
  assert.throws(() => t("no.such.key" as never), /unknown key/);
  assert.throws(() => rawCopy("no.such.key" as never), /unknown key/);
  const prev = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  try {
    assert.equal(t("no.such.key" as never), "no.such.key");
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prev;
  }
});

test("t: missing variable throws outside production, keeps the placeholder in production", () => {
  assert.throws(() => t("daily.next", { h: 1 }), /needs variable "m"/);
  const prev = process.env.NODE_ENV;
  (process.env as Record<string, string | undefined>).NODE_ENV = "production";
  try {
    assert.equal(t("daily.next", { h: 1 }), "Next Daily in 1h {m}m");
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = prev;
  }
});

test("t: empty-string and zero variable values are used, not treated as missing", () => {
  assert.equal(t("daily.next", { h: 0, m: 0 }), "Next Daily in 0h 0m");
  assert.equal(t("pause.pass.row.title", { lastName: "" }), "");
});

test("t: extra vars are ignored; vars containing braces are not re-expanded", () => {
  assert.equal(t("home.streak", { n: "{n}", unused: 1 }), "{n}-day streak");
});

test("hasCopy guards data-driven keys", () => {
  assert.equal(hasCopy("app.name"), true);
  assert.equal(hasCopy("spot.slot"), true);
  assert.equal(hasCopy("toString"), false);
  assert.equal(hasCopy("__proto__"), false);
});

test("spotName covers all 14 engine spots with distinct display names", () => {
  const names = (Object.keys(OZ_SPOTS) as Array<keyof typeof OZ_SPOTS>).map((s) => spotName(s));
  assert.equal(names.length, 14);
  assert.equal(new Set(names).size, 14);
  assert.equal(spotName("point_left"), "Left point");
});

test("periodOrdinal: regulation, overtime and multi-overtime; rejects bad input", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(periodOrdinal), ["1st", "2nd", "3rd", "OT", "2OT", "3OT"]);
  for (const bad of [0, -1, 1.5, Number.NaN]) assert.throws(() => periodOrdinal(bad), /invalid period/);
});

test("meta titles stay inside COPY.md limits", () => {
  assert.ok(COPY["meta.title.home"].length <= 60);
  assert.ok(COPY["meta.description"].length <= 160);
  assert.ok(COPY["meta.title.page"].includes("{pageName}"));
});
