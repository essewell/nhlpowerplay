import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  checkExport, formatReport, groupErrors, reportExport, syncData, swapPaths, type SyncOptions,
} from "../scripts/data-sync.ts";
import { scanForSynthetic } from "../scripts/check-no-synthetic.ts";
import { err, ok, type Result } from "../../../packages/engine/src/result.ts";

const FIXTURES = fileURLToPath(new URL("../dev-fixtures/", import.meta.url));
const SCRIPT = fileURLToPath(new URL("../scripts/data-sync.ts", import.meta.url));

import { EXPORT_FILES, parseScenarioStrict, validateExportFile } from "../../../packages/engine/src/schema.ts";

/** Mechanics tests use a stub contract so they do not depend on the real schema. */
const STUB_FILES = [
  "base_rates.json", "endless_index.json", "faceoff_ratings.json", "goalie_ratings.json",
  "playmaker_ratings.json", "schedule.json", "shooter_ratings.json",
];
const stubValidate = (name: string, data: unknown): Result<unknown> =>
  typeof data === "object" && data !== null && (data as { bad?: unknown }).bad === true
    ? err(`stub rejects ${name}`)
    : ok(data);

function tempDir(t: { after: (fn: () => void) => void }): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pp-sync-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Build an export dir from dev-fixtures: drop the ".synthetic" suffix and the top-level flag. */
function buildExport(root: string): string {
  const exportDir = path.join(root, "export");
  mkdirSync(path.join(exportDir, "scenarios"), { recursive: true });
  const copy = (srcRel: string) => {
    const data = JSON.parse(readFileSync(path.join(FIXTURES, srcRel), "utf8"));
    if (data && typeof data === "object" && !Array.isArray(data)) delete data.synthetic;
    const dstRel = srcRel.replace(/\.synthetic\.json$/, ".json");
    writeFileSync(path.join(exportDir, dstRel), JSON.stringify(data));
  };
  for (const f of readdirSync(FIXTURES)) if (f.endsWith(".synthetic.json")) copy(f);
  for (const f of readdirSync(path.join(FIXTURES, "scenarios"))) copy(`scenarios/${f}`);
  return exportDir;
}

function setup(t: { after: (fn: () => void) => void }) {
  const root = tempDir(t);
  const exportDir = buildExport(root);
  const outDir = path.join(root, "public", "data");
  const opts: SyncOptions = { exportDir, outDir, expectedFiles: STUB_FILES, validate: stubValidate, crossCheck: checkExport };
  return { root, exportDir, outDir, opts };
}

/** Seed an existing public/data so tests can prove it survives a refused sync. */
function seedOld(outDir: string): void {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "old.json"), '"previous"');
}

const listTree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)).split(path.sep).join("/"))
    .sort();

// --- happy path ------------------------------------------------------------------------------

test("happy path: copies every file and writes a manifest with sha256 + counts", (t) => {
  const { exportDir, outDir, opts } = setup(t);
  const res = syncData(opts);
  assert.ok(res.ok, res.ok ? "" : res.error);
  const scenario = "scenarios/zz-synthetic-demo-5on4.json";
  assert.deepEqual(listTree(outDir), [...STUB_FILES, "manifest.json", scenario].sort());
  const manifest = JSON.parse(readFileSync(path.join(outDir, "manifest.json"), "utf8"));
  assert.equal(manifest.generated_from, "data-pipeline/data/export");
  assert.deepEqual(manifest.files.map((f: { path: string }) => f.path), [...STUB_FILES, scenario]);
  for (const f of manifest.files) {
    const bytes = readFileSync(path.join(exportDir, f.path));
    assert.equal(f.bytes, bytes.length);
    assert.equal(f.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.deepEqual(readFileSync(path.join(outDir, f.path)), bytes);
  }
  assert.deepEqual(manifest.counts, {
    scenarios: 1, base_rates: 42, endless_index: 1, faceoff_ratings: 2, goalie_ratings: 1,
    playmaker_ratings: 1, schedule: 1, shooter_ratings: 2,
  });
});

test("happy path replaces existing data entirely (stale files removed)", (t) => {
  const { outDir, opts } = setup(t);
  seedOld(outDir);
  assert.ok(syncData(opts).ok);
  assert.ok(!existsSync(path.join(outDir, "old.json")));
});

test("synced output from de-flagged fixtures passes the synthetic guard", (t) => {
  const { outDir, opts } = setup(t);
  assert.ok(syncData(opts).ok);
  assert.deepEqual(scanForSynthetic([outDir]).offenders, []);
});

// --- refusals (each leaves existing public/data untouched) -----------------------------------

test("missing required file is refused and existing data is untouched", (t) => {
  const { exportDir, outDir, opts } = setup(t);
  seedOld(outDir);
  rmSync(path.join(exportDir, "goalie_ratings.json"));
  const res = syncData(opts);
  assert.deepEqual(res, { ok: false, error: "goalie_ratings.json: required export file is missing" });
  assert.deepEqual(listTree(outDir), ["old.json"]);
});

test("invalid file (validator error) aborts with file + error; existing data untouched", (t) => {
  const { exportDir, outDir, opts } = setup(t);
  seedOld(outDir);
  writeFileSync(path.join(exportDir, "scenarios", "broken.json"), '{"bad":true}');
  const res = syncData(opts);
  assert.deepEqual(res, { ok: false, error: "scenarios/broken.json: stub rejects scenarios/broken.json" });
  assert.deepEqual(listTree(outDir), ["old.json"]);
  assert.deepEqual(readdirSync(path.dirname(outDir)), ["data"]);
});

test("malformed JSON is refused with the file name", (t) => {
  const { exportDir, outDir, opts } = setup(t);
  seedOld(outDir);
  writeFileSync(path.join(exportDir, "schedule.json"), "[{");
  const res = syncData(opts);
  assert.ok(!res.ok && res.error.startsWith("schedule.json: invalid JSON:"), JSON.stringify(res));
  assert.deepEqual(listTree(outDir), ["old.json"]);
});

test("unexpected extra top-level file is rejected", (t) => {
  const { exportDir, outDir, opts } = setup(t);
  writeFileSync(path.join(exportDir, "extra.json"), "[]");
  const res = syncData(opts);
  assert.deepEqual(res, { ok: false, error: "extra.json: unexpected entry in export (not in EXPORT_FILES)" });
  assert.ok(!existsSync(outDir));
});

test("unexpected top-level directory is rejected", (t) => {
  const { exportDir, opts } = setup(t);
  mkdirSync(path.join(exportDir, "old_scenarios"));
  const res = syncData(opts);
  assert.ok(!res.ok && res.error.startsWith("old_scenarios:"), JSON.stringify(res));
});

test("non-JSON or nested dir inside scenarios/ is rejected", (t) => {
  const { exportDir, opts } = setup(t);
  writeFileSync(path.join(exportDir, "scenarios", "notes.txt"), "x");
  let res = syncData(opts);
  assert.ok(!res.ok && res.error.includes("scenarios/notes.txt: unexpected non-JSON"), JSON.stringify(res));
  rmSync(path.join(exportDir, "scenarios", "notes.txt"));
  mkdirSync(path.join(exportDir, "scenarios", "nested"));
  res = syncData(opts);
  assert.ok(!res.ok && res.error.includes("scenarios/nested: unexpected non-file"), JSON.stringify(res));
});

test("empty scenarios/ and missing scenarios/ are refused", (t) => {
  const { exportDir, opts } = setup(t);
  rmSync(path.join(exportDir, "scenarios"), { recursive: true });
  assert.deepEqual(syncData(opts), { ok: false, error: "scenarios/: required directory is missing" });
  mkdirSync(path.join(exportDir, "scenarios"));
  assert.deepEqual(syncData(opts), { ok: false, error: "scenarios/: no scenario files" });
});

test("missing export directory is refused", (t) => {
  const { root, opts } = setup(t);
  const res = syncData({ ...opts, exportDir: path.join(root, "nope") });
  assert.ok(!res.ok && res.error.endsWith("export directory not found"));
});

test("first error wins: validation stops at the first bad file in sorted order", (t) => {
  const { exportDir, opts } = setup(t);
  writeFileSync(path.join(exportDir, "schedule.json"), '{"bad":true}');
  writeFileSync(path.join(exportDir, "scenarios", "a.json"), '{"bad":true}');
  const seen: string[] = [];
  const res = syncData({ ...opts, validate: (n, d) => (seen.push(n), stubValidate(n, d)) });
  assert.ok(!res.ok && res.error.startsWith("schedule.json:"));
  assert.ok(!seen.includes("scenarios/a.json"), "kept validating after the first error");
});

// --- determinism + atomicity ------------------------------------------------------------------

test("manifest is byte-identical across two runs over identical data", (t) => {
  const { outDir, opts } = setup(t);
  assert.ok(syncData(opts).ok);
  const first = readFileSync(path.join(outDir, "manifest.json"));
  assert.ok(syncData(opts).ok);
  assert.deepEqual(readFileSync(path.join(outDir, "manifest.json")), first);
  assert.doesNotMatch(first.toString(), /20\d\d-\d\d-\d\dT/, "manifest must not carry a timestamp");
});

test("atomic swap leaves no temp or backup dirs behind", (t) => {
  const { outDir, opts } = setup(t);
  seedOld(outDir);
  assert.ok(syncData(opts).ok);
  assert.deepEqual(readdirSync(path.dirname(outDir)), ["data"]);
});

test("swap failure restores the previous data and removes the temp dir", (t) => {
  const { outDir, opts } = setup(t);
  seedOld(outDir);
  const { tmp } = swapPaths(outDir);
  const res = syncData({
    ...opts,
    rename: (from, to) => {
      if (from === tmp) throw new Error("simulated EPERM");
      return renameSync(from, to);
    },
  });
  assert.ok(!res.ok && res.error.includes("previous data restored: simulated EPERM"), JSON.stringify(res));
  assert.deepEqual(listTree(outDir), ["old.json"]);
  assert.deepEqual(readdirSync(path.dirname(outDir)), ["data"]);
});

test("stale temp dir and orphaned backup from a crashed run are recovered", (t) => {
  const { outDir, opts } = setup(t);
  const { tmp, backup } = swapPaths(outDir);
  mkdirSync(tmp, { recursive: true });
  writeFileSync(path.join(tmp, "junk.json"), "1");
  mkdirSync(backup, { recursive: true });
  writeFileSync(path.join(backup, "old.json"), '"previous"');
  // A refused run touches nothing on disk.
  writeFileSync(path.join(opts.exportDir, "extra.json"), "[]");
  assert.ok(!syncData(opts).ok);
  assert.deepEqual(readdirSync(path.dirname(outDir)).sort(), [path.basename(backup), path.basename(tmp)].sort());
  // The next good run restores the orphaned backup first, then swaps; no leftovers.
  rmSync(path.join(opts.exportDir, "extra.json"));
  assert.ok(syncData(opts).ok);
  assert.deepEqual(readdirSync(path.dirname(outDir)), ["data"]);
  const tree = listTree(outDir);
  assert.ok(!tree.includes("junk.json") && !tree.includes("old.json"), tree.join(","));
});

// --- CLI -------------------------------------------------------------------------------------

test("CLI: unknown flag exits 2 with usage", () => {
  const r = spawnSync(process.execPath, [SCRIPT, "--bogus"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage:/);
});

test("CLI: refused sync prints file + error and exits 1", (t) => {
  const { exportDir, outDir } = setup(t);
  rmSync(path.join(exportDir, "schedule.json"));
  const r = spawnSync(process.execPath, [SCRIPT, "--from", exportDir, "--to", outDir], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /REFUSED[\s\S]*schedule\.json/);
  assert.ok(!existsSync(outDir));
});

// --- real schema (packages/engine/src/schema.ts) -------------------------------------------

test("schema: every dev fixture validates and the CLI syncs them", (t) => {
  const { exportDir, outDir } = setup(t);
  assert.deepEqual([...EXPORT_FILES.files].sort(), STUB_FILES, "dev fixtures must cover EXPORT_FILES");
  const r = spawnSync(process.execPath, [SCRIPT, "--from", exportDir, "--to", outDir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(path.join(outDir, "manifest.json")));
});

test("schema: a structurally wrong file is refused by the real validator", (t) => {
  const { exportDir, outDir } = setup(t);
  writeFileSync(path.join(exportDir, "base_rates.json"), '[{"scope":42}]');
  const res = syncData({ exportDir, outDir, expectedFiles: EXPORT_FILES.files, validate: validateExportFile, crossCheck: checkExport });
  assert.ok(!res.ok && res.error.startsWith("base_rates.json: [0].scope:"), JSON.stringify(res));
  assert.ok(!res.error.startsWith("base_rates.json: base_rates.json:"), "error prefixed twice");
  assert.ok(!existsSync(outDir));
});


test("schema: each dev fixture validates on its own (including ScenarioStrict fields)", () => {
  for (const f of readdirSync(FIXTURES).filter((n) => n.endsWith(".synthetic.json"))) {
    const data = JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8"));
    const res = validateExportFile(f.replace(/\.synthetic\.json$/, ".json"), data);
    assert.ok(res.ok, res.ok ? "" : res.error);
  }
  const scen = JSON.parse(readFileSync(path.join(FIXTURES, "scenarios", "zz-synthetic-demo-5on4.synthetic.json"), "utf8"));
  assert.equal(scen.synthetic, true, "scenario fixture must carry the synthetic flag");
  const res = parseScenarioStrict(scen);
  assert.ok(res.ok, res.ok ? "" : res.error);
});

test("schema: a scenario whose id does not match its file name is refused", (t) => {
  const { exportDir, outDir } = setup(t);
  const src = path.join(exportDir, "scenarios", "zz-synthetic-demo-5on4.json");
  renameSync(src, path.join(exportDir, "scenarios", "renamed.json"));
  const res = syncData({ exportDir, outDir, expectedFiles: EXPORT_FILES.files, validate: validateExportFile, crossCheck: checkExport });
  assert.ok(!res.ok && res.error.includes("does not match the file name"), JSON.stringify(res));
});

// --- cross-file checks (real schema + checkExport) ------------------------------------------

const DEMO_ID = "zz-synthetic-demo-5on4";
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The real contract over an export dir built from the dev fixtures. */
function realSetup(t: { after: (fn: () => void) => void }) {
  const s = setup(t);
  const opts: SyncOptions = { ...s.opts, expectedFiles: EXPORT_FILES.files, validate: validateExportFile, crossCheck: checkExport };
  const readJson = (rel: string): Json => JSON.parse(readFileSync(path.join(s.exportDir, rel), "utf8"));
  const writeJson = (rel: string, data: unknown) => writeFileSync(path.join(s.exportDir, rel), JSON.stringify(data));
  /** Add a scenario derived from the demo (and list it in endless_index unless told not to). */
  const addScenario = (id: string, mut: (sc: Json) => void = () => {}, listInEndless = true) => {
    const sc = readJson(`scenarios/${DEMO_ID}.json`);
    sc.id = id;
    mut(sc);
    writeJson(`scenarios/${id}.json`, sc);
    if (listInEndless) writeJson("endless_index.json", [...(readJson("endless_index.json") as unknown as string[]), id]);
  };
  return { ...s, opts, readJson, writeJson, addScenario };
}

test("cross-check happy path: dev fixtures sync with the real validator + engine load", (t) => {
  const { outDir, opts } = realSetup(t);
  const res = syncData(opts);
  assert.ok(res.ok, res.ok ? "" : res.error);
  assert.ok(existsSync(path.join(outDir, "manifest.json")));
});

test("cross-check: a schedule scenario_id without a scenario file is refused; nothing written", (t) => {
  const { outDir, opts, writeJson } = realSetup(t);
  seedOld(outDir);
  writeJson("schedule.json", [
    { date: "2099-01-01", scenario_id: DEMO_ID },
    { date: "2099-01-02", scenario_id: "zz-no-such-scenario" },
  ]);
  const res = syncData(opts);
  assert.deepEqual(res, {
    ok: false,
    error: "schedule.json: [1] 2099-01-02: scenario_id \"zz-no-such-scenario\" has no scenarios/zz-no-such-scenario.json",
  });
  assert.deepEqual(listTree(outDir), ["old.json"]);
});

test("cross-check: an endless_index id without a scenario file is refused", (t) => {
  const { outDir, opts, writeJson } = realSetup(t);
  writeJson("endless_index.json", [DEMO_ID, "zz-ghost"]);
  const res = syncData(opts);
  assert.deepEqual(res, { ok: false, error: "endless_index.json: [1]: id \"zz-ghost\" has no scenarios/zz-ghost.json" });
  assert.ok(!existsSync(outDir));
});

test("cross-check: an orphan scenario file (not in endless_index) is refused", (t) => {
  const { outDir, opts, addScenario } = realSetup(t);
  addScenario("zz-synthetic-orphan", () => {}, false);
  const res = syncData(opts);
  assert.deepEqual(res, { ok: false, error: "scenarios/zz-synthetic-orphan.json: orphan scenario: not listed in endless_index.json" });
  assert.ok(!existsSync(outDir));
});

test("cross-check: a scenario the engine rejects (4v3, PP penalty, no bench) is refused with id + engine message", (t) => {
  const { outDir, opts, addScenario } = realSetup(t);
  // Schema-valid: 2 PK minors + 1 PP minor = 4v3. When the PP minor ends the PP needs a 5th skater,
  // but only 4 are on ice and the bench is empty: the loader must refuse it.
  addScenario("zz-synthetic-short-4v3", (s) => {
    s.state.strength = "4v3";
    s.state.pp_remaining_s = 100;
    s.state.penalties = [
      { side: "pk", player_id: 9900101, kind: "minor", remaining_s: 100, queued: false },
      { side: "pk", player_id: 9900102, kind: "minor", remaining_s: 110, queued: false },
      { side: "pp", player_id: 9900005, kind: "minor", remaining_s: 50, queued: false },
    ];
    s.state.goalie_pulled = false;
    s.pp.skaters = s.pp.skaters.slice(0, 4);
    s.pp.bench = [];
    s.pk.skaters = s.pk.skaters.slice(0, 3);
  });
  const res = syncData(opts);
  assert.ok(!res.ok, "sync should be refused");
  assert.ok(res.error.startsWith("scenarios/zz-synthetic-short-4v3.json: engine rejected the scenario: "), res.error);
  assert.match(res.error, /reaches 5 PP skaters but only 4 are listed/);
  assert.ok(!existsSync(outDir));
});

test("cross-check: several errors report the first plus a +N more count", (t) => {
  const { opts, writeJson } = realSetup(t);
  writeJson("endless_index.json", [DEMO_ID, "zz-ghost-a", "zz-ghost-b"]);
  const res = syncData(opts);
  assert.deepEqual(res, {
    ok: false,
    error: "endless_index.json: [1]: id \"zz-ghost-a\" has no scenarios/zz-ghost-a.json (+1 more cross-file error(s))",
  });
});

test("checkExport: report counts flags by reason and shape fallbacks by field", (t) => {
  const { opts, addScenario } = realSetup(t);
  // An older-shape scenario: no penalties / goalie_pulled / bench -> three flagged fallbacks.
  addScenario("zz-synthetic-old-shape", (s) => {
    delete s.state.penalties;
    delete s.state.goalie_pulled;
    delete s.pp.bench;
  });
  const r = reportExport(opts);
  assert.deepEqual(r.validationErrors, []);
  assert.deepEqual(r.crossErrors, []);
  assert.ok(r.report !== null);
  assert.equal(r.report.counts.scenarios, 2);
  assert.equal(r.report.counts.scenarios_loaded, 2);
  assert.deepEqual(r.report.shapeFallbacks, { bench: 1, goalie_pulled: 1, penalties: 1 });
  // Hand is never in the export: one flag per PP skater (5 each) and per goalie (1 each).
  assert.equal(r.report.ratingFlags.unknown_shoot_hand, 10);
  assert.equal(r.report.ratingFlags.unknown_catch_hand, 2);
  assert.deepEqual(Object.keys(r.report.ratingFlags), Object.keys(r.report.ratingFlags).sort(), "keys sorted");
});

test("checkExport: a validated set missing a top-level file is an error, not a crash", () => {
  const r = checkExport(new Map());
  assert.equal(r.errors.length, EXPORT_FILES.files.length);
  assert.match(r.errors[0] ?? "", /not in the validated set/);
});

test("reportExport collects every validation error (not just the first) and skips cross-checks", (t) => {
  const { opts, writeJson } = realSetup(t);
  writeJson("base_rates.json", [{ scope: 42 }]);
  writeJson("schedule.json", [{ date: "2099-02-30", scenario_id: DEMO_ID }]);
  const r = reportExport(opts);
  assert.equal(r.validationErrors.length, 2);
  assert.ok(r.validationErrors[0]?.startsWith("base_rates.json:"));
  assert.ok(r.validationErrors[1]?.startsWith("schedule.json:"));
  assert.equal(r.report, null);
  assert.match(formatReport(r), /cross-file checks: skipped/);
});

test("groupErrors strips scenario file names and sorts by frequency", () => {
  const g = groupErrors([
    "scenarios/a.json: state: bad thing; scenarios/a.json: pp: other",
    "scenarios/b.json: state: bad thing",
    "schedule.json: [0].date: nope",
  ]);
  assert.deepEqual(g, [["scenarios/*: state: bad thing", 2], ["schedule.json: [0].date: nope", 1]]);
});

test("CLI --report: prints the summary, exits 0 and writes nothing", (t) => {
  const { exportDir, outDir } = realSetup(t);
  const r = spawnSync(process.execPath, [SCRIPT, "--report", "--from", exportDir, "--to", outDir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /counts: .*scenarios=1/);
  assert.match(r.stdout, /rating flags by reason: .*unknown_shoot_hand=5/);
  assert.match(r.stdout, /shape fallbacks by field: \(none\)/);
  assert.match(r.stdout, /nothing written/);
  assert.ok(!existsSync(outDir), "report mode must not create the output dir");
  assert.ok(!existsSync(path.dirname(outDir)), "nor its parent, temp or backup dirs");
});

test("CLI --report on a broken export exits 1, leaves existing data untouched", (t) => {
  const { exportDir, outDir, writeJson } = realSetup(t);
  seedOld(outDir);
  writeJson("endless_index.json", [DEMO_ID, "zz-ghost"]);
  const r = spawnSync(process.execPath, [SCRIPT, "--report", "--from", exportDir, "--to", outDir], { encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /cross-file errors: 1/);
  assert.match(r.stdout, /zz-ghost/);
  assert.deepEqual(listTree(outDir), ["old.json"]);
  assert.deepEqual(readdirSync(path.dirname(outDir)), ["data"]);
});
