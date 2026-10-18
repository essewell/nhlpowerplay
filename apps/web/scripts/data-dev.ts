/**
 * `pnpm data:dev`: put the SYNTHETIC dev fixtures into apps/web/public/data so `pnpm dev` has data
 * before the real pipeline export is synced. It builds a temp export dir from apps/web/dev-fixtures
 * (drops the ".synthetic" file-name suffix, keeps the scenario's `"synthetic": true` marker) and runs
 * the real data-sync over it, so the files are validated and cross-checked like a real export.
 *
 * The marker is deliberate: apps/web "prebuild" (check-no-synthetic.ts, over public/) fails any
 * production build while this data is present. Delete public/data (or run `pnpm data:sync` with the
 * real export) before building.
 *
 * Usage: node apps/web/scripts/data-dev.ts [--to <publicDataDir>]
 * Single-threaded CLI; no shared state. O(fixture bytes).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const SUFFIX = ".synthetic.json";

/** Build <root>/export from the fixtures; returns its path. Scenario files keep their marker. O(files). */
export function buildDevExport(fixturesDir: string, root: string): string {
  const exportDir = path.join(root, "export");
  mkdirSync(path.join(exportDir, "scenarios"), { recursive: true });
  const copy = (rel: string): void => {
    const dst = rel.endsWith(SUFFIX) ? `${rel.slice(0, -SUFFIX.length)}.json` : rel;
    writeFileSync(path.join(exportDir, dst), readFileSync(path.join(fixturesDir, rel)));
  };
  for (const f of readdirSync(fixturesDir)) if (f.endsWith(SUFFIX)) copy(f);
  for (const f of readdirSync(path.join(fixturesDir, "scenarios"))) {
    if (f.endsWith(SUFFIX)) copy(`scenarios/${f}`);
  }
  return exportDir;
}

function main(argv: string[]): number {
  const { values } = parseArgs({ args: argv, options: { to: { type: "string" } } });
  const webRoot = path.resolve(import.meta.dirname, "..");
  const outDir = path.resolve(values.to ?? path.join(webRoot, "public", "data"));
  const tmp = mkdtempSync(path.join(tmpdir(), "pp-data-dev-"));
  try {
    const exportDir = buildDevExport(path.join(webRoot, "dev-fixtures"), tmp);
    const sync = spawnSync(
      process.execPath,
      [path.join(import.meta.dirname, "data-sync.ts"), "--from", exportDir, "--to", outDir],
      { stdio: "inherit" },
    );
    if (sync.status !== 0) return sync.status ?? 1;
    console.log(`data-dev: SYNTHETIC data in ${outDir}. Production builds will refuse it; delete it before building.`);
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
