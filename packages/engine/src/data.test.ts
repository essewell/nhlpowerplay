/**
 * Step 3 gate (docs/KICKOFF.md): "all exported files validate; a scenario loads in a unit test",
 * run over the committed synced data in apps/web/public/data (written by `pnpm data:sync`).
 *
 * If that directory is missing, one SKIPPED test says so. Set POWERPLAY_DATA_DIR to point the
 * gate at another synced directory (e.g. a scratch sync) without touching public/data.
 *
 * Reads files with node:fs (tests only; engine source never does). The data is read, validated and
 * rating-indexed once per process, so the whole file is O(total bytes + S x load) for S scenarios.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { indexAllRatings, loadScenario, type LoadOpts, type RatingIndexes } from "./loader.ts";
import type { Result } from "./result.ts";
import {
  EXPORT_FILES, validateExportFile, type BaseRatesFile, type EndlessIndexFile, type FaceoffRatingRow,
  type GoalieRatingRow, type PlaymakerRatingRow, type Scenario, type ScheduleFile, type ShooterRatingRow,
} from "./schema.ts";
import { autoPlay, initRun, type Policy } from "./sim.ts";

const DATA_DIR = process.env.POWERPLAY_DATA_DIR
  ?? fileURLToPath(new URL("../../../apps/web/public/data/", import.meta.url));
const MANIFEST = "manifest.json";
const OPTS: LoadOpts = { formation: "umbrella", askEveryTouch: false };
/** Scenarios that get a full autoPlay smoke run (the rest only load + initRun). */
const SMOKE_SCENARIOS = 20;
/** Upper bound on calls per smoke run; a run normally ends well before this. */
const SMOKE_MAX_CALLS = 500;

type ManifestFile = { path: string; bytes: number; sha256: string };
type Loaded = {
  manifest: { files: ManifestFile[] };
  values: Map<string, unknown>;
  scenarios: Scenario[];
  baseRates: BaseRatesFile;
  indexes: RatingIndexes;
};

function val<T>(r: Result<T>, what: string): T {
  if (!r.ok) assert.fail(`${what}: ${r.error}`);
  return r.value;
}

/** All files under dir as sorted POSIX relative paths. O(n log n). */
function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => path.relative(dir, path.join(d.parentPath, d.name)).split(path.sep).join("/"))
    .sort();
}

let cache: Loaded | null = null;
/** Read + validate every manifest file once and index the ratings once. O(total bytes + N). */
function load(): Loaded {
  if (cache !== null) return cache;
  const manifest = JSON.parse(readFileSync(path.join(DATA_DIR, MANIFEST), "utf8")) as Loaded["manifest"];
  const values = new Map<string, unknown>();
  for (const f of manifest.files) {
    const data: unknown = JSON.parse(readFileSync(path.join(DATA_DIR, ...f.path.split("/")), "utf8"));
    values.set(f.path, val(validateExportFile(f.path, data), "validateExportFile"));
  }
  const get = <T>(name: string): T => {
    const v = values.get(name);
    if (v === undefined) assert.fail(`${name} is not in ${MANIFEST}`);
    return v as T;
  };
  const indexes = val(indexAllRatings({
    shooter: get<ShooterRatingRow[]>("shooter_ratings.json"),
    goalie: get<GoalieRatingRow[]>("goalie_ratings.json"),
    faceoff: get<FaceoffRatingRow[]>("faceoff_ratings.json"),
    playmaker: get<PlaymakerRatingRow[]>("playmaker_ratings.json"),
  }), "indexAllRatings");
  const scenarios = [...values].filter(([rel]) => rel.startsWith(`${EXPORT_FILES.scenariosDir}/`))
    .map(([, v]) => v as Scenario);
  cache = { manifest, values, scenarios, baseRates: get<BaseRatesFile>("base_rates.json"), indexes };
  return cache;
}

const firstOption: Policy = (options) => {
  const o = options[0];
  if (o === undefined) assert.fail("autoPlay offered no options");
  return o.call;
};

if (!existsSync(DATA_DIR)) {
  test("Step 3 gate over synced data", { skip: "no synced data: run pnpm data:sync" }, () => {});
} else {
  test("data: the synced file set is exactly the manifest plus manifest.json", () => {
    const { manifest } = load();
    const listed = manifest.files.map((f) => f.path);
    assert.deepEqual(listFiles(DATA_DIR), [...listed, MANIFEST].sort());
    for (const f of EXPORT_FILES.files) assert.ok(listed.includes(f), `${f} missing from ${MANIFEST}`);
    assert.ok(load().scenarios.length > 0, "no scenarios");
  });

  test("data: manifest sha256 and byte counts match every file", () => {
    for (const f of load().manifest.files) {
      const bytes = readFileSync(path.join(DATA_DIR, ...f.path.split("/")));
      assert.equal(bytes.length, f.bytes, `${f.path}: byte count`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), f.sha256, `${f.path}: sha256`);
    }
  });

  test("data: every file validates and every schedule / endless id has a scenario file", () => {
    const { values, scenarios } = load();
    const ids = new Set(scenarios.map((s) => s.id));
    for (const row of values.get("schedule.json") as ScheduleFile) {
      assert.ok(ids.has(row.scenario_id), `schedule ${row.date}: no scenario ${row.scenario_id}`);
    }
    const endless = values.get("endless_index.json") as EndlessIndexFile;
    for (const id of endless) assert.ok(ids.has(id), `endless_index: no scenario ${id}`);
    const listed = new Set(endless);
    for (const id of ids) assert.ok(listed.has(id), `orphan scenario ${id}`);
  });

  test("data: every scenario loads through loadScenario and initRun accepts it", () => {
    const { scenarios, indexes, baseRates } = load();
    for (const sc of scenarios) {
      const loaded = val(loadScenario(sc, indexes, baseRates, OPTS), `scenario ${sc.id}: loadScenario`);
      val(initRun(loaded.input), `scenario ${sc.id}: initRun`);
    }
  });

  test("data: loading the same scenario twice is deterministic", () => {
    const { scenarios, indexes, baseRates } = load();
    const sc = scenarios[0];
    assert.ok(sc !== undefined);
    const a = val(loadScenario(sc, indexes, baseRates, OPTS), "first load");
    const b = val(loadScenario(sc, indexes, baseRates, OPTS), "second load");
    assert.deepEqual(a, b);
    assert.deepEqual(val(initRun(a.input), "initRun a"), val(initRun(b.input), "initRun b"));
  });

  test(`data: autoPlay with a first-option policy runs the first ${SMOKE_SCENARIOS} scenarios without error`, () => {
    const { scenarios, indexes, baseRates } = load();
    for (const sc of scenarios.slice(0, SMOKE_SCENARIOS)) {
      const { input } = val(loadScenario(sc, indexes, baseRates, OPTS), `scenario ${sc.id}: loadScenario`);
      const start = val(initRun(input), `scenario ${sc.id}: initRun`);
      val(autoPlay(start, input, firstOption, SMOKE_MAX_CALLS), `scenario ${sc.id}: autoPlay`);
    }
  });
}
