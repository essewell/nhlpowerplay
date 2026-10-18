/**
 * `pnpm data:sync`: validate every file in the pipeline export and copy it into apps/web/public/data.
 *
 * Usage: node apps/web/scripts/data-sync.ts [--from <exportDir>] [--to <publicDataDir>]
 *   defaults: <repo>/data-pipeline/data/export -> <repo>/apps/web/public/data
 *
 * Contract:
 * - Every name in EXPORT_FILES must exist; `scenarios/` must hold >= 1 `*.json`; anything else
 *   (extra top-level file or dir, non-JSON or nested dir in scenarios/) is an error.
 * - Each file is parsed and passed to validateExportFile; the first failure aborts with
 *   "<file>: <error>" and exit code 1, before anything is written.
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
import { err, ok, type Result } from "../../../packages/engine/src/result.ts";
import { EXPORT_FILES, validateExportFile } from "../../../packages/engine/src/schema.ts";

export const SCENARIOS_DIR = "scenarios";
export const MANIFEST_NAME = "manifest.json";
export const GENERATED_FROM = "data-pipeline/data/export";

export type ManifestFile = { path: string; bytes: number; sha256: string };
export type Manifest = {
  generated_from: string;
  files: ManifestFile[];
  counts: Record<string, number>;
};

export type SyncOptions = {
  exportDir: string;
  outDir: string;
  expectedFiles: readonly string[];
  validate: (name: string, data: unknown) => Result<unknown>;
  /** Test seam for the swap step; defaults to fs.renameSync. */
  rename?: (from: string, to: string) => void;
};

type Validated = { rel: string; bytes: Buffer; sha256: string; length: number | null };

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

/** Read, parse and validate every file; stops at the first error. O(total bytes). */
function validateAll(
  exportDir: string,
  rels: readonly string[],
  validate: SyncOptions["validate"],
): Result<Validated[]> {
  const out: Validated[] = [];
  for (const rel of rels) {
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
    out.push({
      rel,
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      length: Array.isArray(data) ? data.length : null,
    });
  }
  return ok(out);
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

/** Validate the whole export, then copy it atomically. O(total bytes + n log n). */
export function syncData(opts: SyncOptions): Result<Manifest> {
  const listed = listExport(opts.exportDir, opts.expectedFiles);
  if (!listed.ok) return err(listed.error);
  const validated = validateAll(opts.exportDir, listed.value, opts.validate);
  if (!validated.ok) return err(validated.error);
  const manifest = buildManifest(validated.value);
  const written = writeAtomically(opts.outDir, validated.value, manifest, opts.rename ?? renameSync);
  if (!written.ok) return err(written.error);
  return ok(manifest);
}

function main(argv: string[]): number {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { from: { type: "string" }, to: { type: "string" } } }));
  } catch (e) {
    console.error(`data-sync: ${errMessage(e)}\nusage: node apps/web/scripts/data-sync.ts [--from <exportDir>] [--to <publicDataDir>]`);
    return 2;
  }
  const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
  const exportDir = path.resolve(values.from ?? path.join(repoRoot, GENERATED_FROM));
  const outDir = path.resolve(values.to ?? path.join(repoRoot, "apps", "web", "public", "data"));
  const res = syncData({ exportDir, outDir, expectedFiles: EXPORT_FILES.files, validate: validateExportFile });
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
