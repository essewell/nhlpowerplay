/**
 * `pnpm data:sync`: validate every file in the pipeline export and copy it into apps/web/public/data.
 *
 * Usage: node apps/web/scripts/data-sync.ts [--from <exportDir>] [--to <publicDataDir>] [--report]
 *   defaults: <repo>/data-pipeline/data/export -> <repo>/apps/web/public/data
 *   --report: validate every file, cross-check, and print a summary (counts, rating-flag counts by
 *             reason, shape-fallback counts, grouped errors). Writes nothing. Exit 0 clean, 1 on errors.
 *
 * Contract:
 * - Every name in EXPORT_FILES must exist; `scenarios/` must hold >= 1 `*.json`; anything else
 *   (extra top-level file or dir, non-JSON or nested dir in scenarios/) is an error.
 * - Each file is parsed and passed to validateExportFile; the first failure aborts with
 *   "<file>: <error>" and exit code 1, before anything is written.
 * - Cross-file checks (checkExport) then run on the validated set, still before anything is
 *   written: every schedule.json scenario_id and endless_index.json id has scenarios/<id>.json;
 *   every scenario file is listed in endless_index.json (an orphan is an error); every scenario
 *   loads through the engine's loadScenario (export ratings + base rates, LOAD_OPTS). The first
 *   error refuses the sync, with a "+N more" count.
 * - The copy is atomic: files go to a temp sibling dir, then old -> backup, temp -> target, backup
 *   removed. If the swap fails the old data is restored. The validated bytes are the bytes written.
 * - manifest.json is deterministic (sorted paths, sha256, no timestamps): identical input gives an
 *   identical manifest.
 *
 * Single-threaded CLI; no shared state. Not engine code, so node:fs / node:crypto are fine here.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { indexAllRatings, loadScenario, type LoadOpts } from "../../../packages/engine/src/loader.ts";
import { err, ok, type Result } from "../../../packages/engine/src/result.ts";
import {
  EXPORT_FILES, validateExportFile, type BaseRatesFile, type EndlessIndexFile, type FaceoffRatingRow,
  type GoalieRatingRow, type PlaymakerRatingRow, type Scenario, type ScheduleFile, type ShooterRatingRow,
} from "../../../packages/engine/src/schema.ts";

export const SCENARIOS_DIR = "scenarios";
export const MANIFEST_NAME = "manifest.json";
export const GENERATED_FROM = "data-pipeline/data/export";
/** Engine options every scenario must load under (the defaults a new run starts with). */
export const LOAD_OPTS: LoadOpts = { formation: "umbrella", askEveryTouch: false };

export type ManifestFile = { path: string; bytes: number; sha256: string };
export type Manifest = {
  generated_from: string;
  files: ManifestFile[];
  counts: Record<string, number>;
};

/** Summary of a cross-checked export. All record keys are sorted (deterministic output). */
export type SyncReport = {
  counts: Record<string, number>;
  /** RatingFlag count by reason, over every scenario that loaded. */
  ratingFlags: Record<string, number>;
  /** ShapeFallback count by field, over every scenario that loaded. */
  shapeFallbacks: Record<string, number>;
};
export type CrossCheckResult = { errors: string[]; report: SyncReport };
/** Cross-file check over the validated values, keyed by relative path ("schedule.json", "scenarios/<id>.json"). */
export type CrossCheck = (files: ReadonlyMap<string, unknown>) => CrossCheckResult;

export type SyncOptions = {
  exportDir: string;
  outDir: string;
  expectedFiles: readonly string[];
  validate: (name: string, data: unknown) => Result<unknown>;
  crossCheck: CrossCheck;
  /** Test seam for the swap step; defaults to fs.renameSync. */
  rename?: (from: string, to: string) => void;
};

type Validated = { rel: string; bytes: Buffer; sha256: string; length: number | null; value: unknown };

const SCENARIO_REL_RE = /^scenarios\/([^/]+)\.json$/;
const REPORT_SHOWN_ERRORS = 5;

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Temp and backup dirs live next to outDir so renames stay on one volume. */
export function swapPaths(outDir: string): { tmp: string; backup: string } {
  const parent = path.dirname(outDir);
  const base = path.basename(outDir);
  return { tmp: path.join(parent, `.${base}.sync-tmp`), backup: path.join(parent, `.${base}.sync-old`) };
}

/**
 * List the export and check its file set. O(n log n) in the number of files (sort).
 * Returns relative POSIX paths, top-level files first then scenarios, each group sorted.
 */
export function listExport(exportDir: string, expectedFiles: readonly string[]): Result<string[]> {
  if (!existsSync(exportDir)) return err(`${exportDir}: export directory not found`);
  let top;
  try {
    top = readdirSync(exportDir, { withFileTypes: true });
  } catch (e) {
    return err(`${exportDir}: cannot read export directory: ${errMessage(e)}`);
  }
  const expected = new Set(expectedFiles);
  const present = new Map(top.map((d) => [d.name, d]));

  for (const name of [...expected].sort()) {
    const entry = present.get(name);
    if (!entry) return err(`${name}: required export file is missing`);
    if (!entry.isFile()) return err(`${name}: expected a file`);
  }
  const scenariosEntry = present.get(SCENARIOS_DIR);
  if (!scenariosEntry) return err(`${SCENARIOS_DIR}/: required directory is missing`);
  if (!scenariosEntry.isDirectory()) return err(`${SCENARIOS_DIR}: expected a directory`);
  for (const name of [...present.keys()].sort()) {
    if (name !== SCENARIOS_DIR && !expected.has(name)) {
      return err(`${name}: unexpected entry in export (not in EXPORT_FILES)`);
    }
  }

  let scenarioEntries;
  try {
    scenarioEntries = readdirSync(path.join(exportDir, SCENARIOS_DIR), { withFileTypes: true });
  } catch (e) {
    return err(`${SCENARIOS_DIR}/: cannot read: ${errMessage(e)}`);
  }
  const scenarioFiles: string[] = [];
  for (const d of scenarioEntries) {
    const rel = `${SCENARIOS_DIR}/${d.name}`;
    if (!d.isFile()) return err(`${rel}: unexpected non-file entry in ${SCENARIOS_DIR}/`);
    if (!d.name.endsWith(".json")) return err(`${rel}: unexpected non-JSON file in ${SCENARIOS_DIR}/`);
    scenarioFiles.push(rel);
  }
  if (scenarioFiles.length === 0) return err(`${SCENARIOS_DIR}/: no scenario files`);
  return ok([...[...expected].sort(), ...scenarioFiles.sort()]);
}

/** Read, parse and validate one file. O(file bytes). */
function validateOne(exportDir: string, rel: string, validate: SyncOptions["validate"]): Result<Validated> {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path.join(exportDir, ...rel.split("/")));
  } catch (e) {
    return err(`${rel}: cannot read: ${errMessage(e)}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(bytes.toString("utf8"));
  } catch (e) {
    return err(`${rel}: invalid JSON: ${errMessage(e)}`);
  }
  const res = validate(rel, data);
  // schema.ts errors already read "<file>: <path>: <message>"; do not prefix twice.
  if (!res.ok) return err(res.error.startsWith(`${rel}: `) ? res.error : `${rel}: ${res.error}`);
  return ok({
    rel,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    length: Array.isArray(data) ? data.length : null,
    value: res.value,
  });
}

/**
 * Validate every listed file. O(total bytes).
 * stopAtFirst: return right after the first error (sync); otherwise collect every file's error (report).
 */
function validateAll(exportDir: string, rels: readonly string[], validate: SyncOptions["validate"],
  stopAtFirst: boolean): { files: Validated[]; errors: string[] } {
  const files: Validated[] = [];
  const errors: string[] = [];
  for (const rel of rels) {
    const one = validateOne(exportDir, rel, validate);
    if (one.ok) {
      files.push(one.value);
    } else {
      errors.push(one.error);
      if (stopAtFirst) break;
    }
  }
  return { files, errors };
}

/** O(1). */
function bump(rec: Record<string, number>, key: string): void {
  rec[key] = (rec[key] ?? 0) + 1;
}

/** Copy with keys sorted so printed / serialised reports are deterministic. O(k log k). */
function sortedRecord(rec: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(rec).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The real cross-file check. Expects the values validateExportFile returned (typed schema output).
 * Collects every error (sync reports the first). O(F + N + S x load) for F files, N rating rows
 * (indexed once) and S scenarios; each scenario load is O(1) per rating lookup.
 */
export function checkExport(files: ReadonlyMap<string, unknown>): CrossCheckResult {
  const errors: string[] = [];
  const counts: Record<string, number> = {};
  const ratingFlags: Record<string, number> = {};
  const shapeFallbacks: Record<string, number> = {};
  const report = (): SyncReport => ({
    counts: sortedRecord(counts), ratingFlags: sortedRecord(ratingFlags), shapeFallbacks: sortedRecord(shapeFallbacks),
  });

  const missing = EXPORT_FILES.files.filter((f) => !files.has(f));
  if (missing.length > 0) {
    return { errors: missing.map((f) => `${f}: not in the validated set; cannot cross-check`), report: report() };
  }
  const schedule = files.get("schedule.json") as ScheduleFile;
  const endless = files.get("endless_index.json") as EndlessIndexFile;
  const baseRates = files.get("base_rates.json") as BaseRatesFile;
  const tables = {
    shooter: files.get("shooter_ratings.json") as ShooterRatingRow[],
    goalie: files.get("goalie_ratings.json") as GoalieRatingRow[],
    faceoff: files.get("faceoff_ratings.json") as FaceoffRatingRow[],
    playmaker: files.get("playmaker_ratings.json") as PlaymakerRatingRow[],
  };

  const scenarios = new Map<string, Scenario>();
  for (const [rel, value] of files) {
    const id = SCENARIO_REL_RE.exec(rel)?.[1];
    if (id !== undefined) scenarios.set(id, value as Scenario);
  }
  const ids = [...scenarios.keys()].sort();
  counts.scenarios = ids.length;
  counts.schedule = schedule.length;
  counts.endless_index = endless.length;
  counts.base_rates = baseRates.length;
  for (const [k, rows] of Object.entries(tables)) counts[`${k}_ratings`] = rows.length;

  schedule.forEach((row, i) => {
    if (!scenarios.has(row.scenario_id)) {
      errors.push(`schedule.json: [${i}] ${row.date}: scenario_id "${row.scenario_id}" has no ${EXPORT_FILES.scenarioFile(row.scenario_id)}`);
    }
  });
  endless.forEach((id, i) => {
    if (!scenarios.has(id)) errors.push(`endless_index.json: [${i}]: id "${id}" has no ${EXPORT_FILES.scenarioFile(id)}`);
  });
  const listed = new Set(endless);
  for (const id of ids) {
    if (!listed.has(id)) errors.push(`${EXPORT_FILES.scenarioFile(id)}: orphan scenario: not listed in endless_index.json`);
  }

  const idx = indexAllRatings(tables);
  if (!idx.ok) {
    errors.push(`ratings: ${idx.error}`);
    return { errors, report: report() };
  }
  let loaded = 0;
  let withMissing = 0;
  for (const id of ids) {
    const sc = scenarios.get(id);
    if (sc === undefined) continue;
    const r = loadScenario(sc, idx.value, baseRates, LOAD_OPTS);
    if (!r.ok) {
      errors.push(`${EXPORT_FILES.scenarioFile(id)}: engine rejected the scenario: ${r.error}`);
      continue;
    }
    loaded++;
    for (const f of r.value.flags) bump(ratingFlags, f.reason);
    for (const f of r.value.fallbacks) bump(shapeFallbacks, f.field);
    if (r.value.flags.some((f) => f.reason === "missing")) withMissing++;
  }
  counts.scenarios_loaded = loaded;
  counts.scenarios_with_missing_rating = withMissing;
  return { errors, report: report() };
}

/** O(n): files keep the listing order (already sorted); counts keys are sorted. */
export function buildManifest(files: readonly Validated[]): Manifest {
  const counts: Record<string, number> = {
    [SCENARIOS_DIR]: files.filter((f) => f.rel.startsWith(`${SCENARIOS_DIR}/`)).length,
  };
  const topLevel = files
    .filter((f) => !f.rel.includes("/") && f.length !== null)
    .map((f) => [f.rel.replace(/\.json$/, ""), f.length as number] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of topLevel) counts[k] = v;
  return {
    generated_from: GENERATED_FROM,
    files: files.map((f) => ({ path: f.rel, bytes: f.bytes.length, sha256: f.sha256 })),
    counts,
  };
}

/** Write to the temp sibling then swap it into place. On failure the previous outDir is kept. */
function writeAtomically(outDir: string, files: readonly Validated[], manifest: Manifest, rename: NonNullable<SyncOptions["rename"]>): Result<void> {
  const { tmp, backup } = swapPaths(outDir);
  try {
    mkdirSync(path.dirname(outDir), { recursive: true });
    // A crash between "old -> backup" and "tmp -> target" leaves only the backup: restore it first.
    if (!existsSync(outDir) && existsSync(backup)) renameSync(backup, outDir);
    rmSync(tmp, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
    mkdirSync(path.join(tmp, SCENARIOS_DIR), { recursive: true });
    for (const f of files) writeFileSync(path.join(tmp, ...f.rel.split("/")), f.bytes);
    writeFileSync(path.join(tmp, MANIFEST_NAME), `${JSON.stringify(manifest, null, 2)}\n`);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    return err(`writing ${tmp} failed: ${errMessage(e)}`);
  }

  const hadOld = existsSync(outDir);
  try {
    if (hadOld) rename(outDir, backup);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    return err(`moving old ${outDir} aside failed (left unchanged): ${errMessage(e)}`);
  }
  try {
    rename(tmp, outDir);
  } catch (e) {
    const swapError = errMessage(e);
    try {
      if (hadOld) renameSync(backup, outDir);
    } catch (restoreError) {
      return err(`swap failed (${swapError}) AND restore failed (${errMessage(restoreError)}); previous data is in ${backup}`);
    }
    rmSync(tmp, { recursive: true, force: true });
    return err(`swap into ${outDir} failed, previous data restored: ${swapError}`);
  }
  rmSync(backup, { recursive: true, force: true });
  return ok(undefined);
}

/** First error plus a count of the rest. O(1). */
function firstWithMore(errors: readonly string[], what: string): string {
  return errors.length > 1 ? `${errors[0]} (+${errors.length - 1} more ${what})` : `${errors[0]}`;
}

/** Validate the whole export, cross-check it, then copy it atomically. O(total bytes + n log n + S x load). */
export function syncData(opts: SyncOptions): Result<Manifest> {
  const listed = listExport(opts.exportDir, opts.expectedFiles);
  if (!listed.ok) return err(listed.error);
  const validated = validateAll(opts.exportDir, listed.value, opts.validate, true);
  const firstInvalid = validated.errors[0];
  if (firstInvalid !== undefined) return err(firstInvalid);
  const cross = opts.crossCheck(new Map(validated.files.map((f) => [f.rel, f.value])));
  if (cross.errors.length > 0) return err(firstWithMore(cross.errors, "cross-file error(s)"));
  const manifest = buildManifest(validated.files);
  const written = writeAtomically(opts.outDir, validated.files, manifest, opts.rename ?? renameSync);
  if (!written.ok) return err(written.error);
  return ok(manifest);
}

export type ExportReport = {
  /** Files listed in the export (0 when the listing itself failed). */
  listed: number;
  /** The listing error, or one entry per file that failed validation (every file, not just the first). */
  validationErrors: string[];
  /** Cross-file errors. Empty, with `report` null, when validation failed: cross-checks need the full set. */
  crossErrors: string[];
  report: SyncReport | null;
};

/** --report: validate every file and cross-check. Never writes. O(total bytes + S x load). */
export function reportExport(opts: Omit<SyncOptions, "outDir" | "rename">): ExportReport {
  const listed = listExport(opts.exportDir, opts.expectedFiles);
  if (!listed.ok) return { listed: 0, validationErrors: [listed.error], crossErrors: [], report: null };
  const validated = validateAll(opts.exportDir, listed.value, opts.validate, false);
  if (validated.errors.length > 0) {
    return { listed: listed.value.length, validationErrors: validated.errors, crossErrors: [], report: null };
  }
  const cross = opts.crossCheck(new Map(validated.files.map((f) => [f.rel, f.value])));
  return { listed: listed.value.length, validationErrors: [], crossErrors: cross.errors, report: cross.report };
}

/**
 * Errors grouped by their first issue with the scenario file name stripped, most frequent first
 * (ties by text). O(E log E).
 */
export function groupErrors(errors: readonly string[]): [string, number][] {
  const groups: Record<string, number> = {};
  for (const e of errors) {
    const first = e.split("; ")[0] ?? e;
    bump(groups, first.replace(/^scenarios\/[^:]+: /, "scenarios/*: ").replace(/scenario [A-Za-z0-9_-]+: /, ""));
  }
  return Object.entries(groups).sort(([ka, a], [kb, b]) => b - a || ka.localeCompare(kb));
}

/** Human-readable report. O(E log E + keys). */
export function formatReport(r: ExportReport): string {
  const lines: string[] = [`data-sync report: ${r.listed} file(s) listed`];
  const fmt = (rec: Record<string, number>): string =>
    Object.keys(rec).length === 0 ? "(none)" : Object.entries(rec).map(([k, v]) => `${k}=${v}`).join(" ");
  const errorBlock = (title: string, errors: readonly string[]): void => {
    lines.push(`  ${title}: ${errors.length}`);
    for (const e of errors.slice(0, REPORT_SHOWN_ERRORS)) lines.push(`    - ${e}`);
    if (errors.length > REPORT_SHOWN_ERRORS) lines.push(`    ... ${errors.length - REPORT_SHOWN_ERRORS} more`);
    lines.push("  grouped by first issue:");
    for (const [k, n] of groupErrors(errors).slice(0, REPORT_SHOWN_ERRORS)) lines.push(`    ${n} x ${k}`);
  };
  if (r.validationErrors.length > 0) {
    errorBlock("validation errors", r.validationErrors);
    lines.push("  cross-file checks: skipped (fix validation errors first)");
  } else {
    if (r.report !== null) {
      lines.push(`  counts: ${fmt(r.report.counts)}`);
      lines.push(`  rating flags by reason: ${fmt(r.report.ratingFlags)}`);
      lines.push(`  shape fallbacks by field: ${fmt(r.report.shapeFallbacks)}`);
    }
    if (r.crossErrors.length > 0) errorBlock("cross-file errors", r.crossErrors);
    else lines.push("  cross-file errors: 0");
  }
  lines.push("  (report mode: nothing written)");
  return lines.join("\n");
}

const USAGE = "usage: node apps/web/scripts/data-sync.ts [--from <exportDir>] [--to <publicDataDir>] [--report]";

function main(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { from: { type: "string" }, to: { type: "string" }, report: { type: "boolean" } },
    }));
  } catch (e) {
    console.error(`data-sync: ${errMessage(e)}\n${USAGE}`);
    return 2;
  }
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const exportDir = path.resolve(values.from ?? path.join(repoRoot, GENERATED_FROM));
  const outDir = path.resolve(values.to ?? path.join(repoRoot, "apps", "web", "public", "data"));
  const contract = { exportDir, expectedFiles: EXPORT_FILES.files, validate: validateExportFile, crossCheck: checkExport };
  if (values.report === true) {
    const r = reportExport(contract);
    console.log(formatReport(r));
    return r.validationErrors.length + r.crossErrors.length === 0 ? 0 : 1;
  }
  const res = syncData({ ...contract, outDir });
  if (!res.ok) {
    console.error(`data-sync: REFUSED, nothing copied.\n  ${res.error}`);
    return 1;
  }
  const counts = Object.entries(res.value.counts).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`data-sync: OK, ${res.value.files.length} file(s) ${exportDir} -> ${outDir}\n  ${counts}`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
