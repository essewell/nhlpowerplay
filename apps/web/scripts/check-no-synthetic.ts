/**
 * Synthetic-data guard. Fails (exit 1) if any scanned file is a dev fixture (*.synthetic.json) or
 * contains the `"synthetic": true` marker, so invented data can never ship in a build.
 *
 * Usage: node scripts/check-no-synthetic.ts [dir ...]
 *   default dirs: apps/web/public and apps/web/.next (relative to this script, not the cwd).
 * Missing directories are reported and skipped (public/ may not exist yet; .next only after a build).
 *
 * Single-threaded CLI; no shared state. Wired as apps/web "prebuild" (public) and "postbuild" (.next).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

export const SYNTHETIC_SUFFIX = ".synthetic.json";
/** Matches `"synthetic":true` and `"synthetic": true` (any JSON whitespace around the colon). */
export const SYNTHETIC_MARKER = /"synthetic"\s*:\s*true\b/;

/** Only these are read as text; others are checked by name only (binary caches, images, fonts). */
const TEXT_EXTENSIONS = new Set([
  ".json", ".js", ".mjs", ".cjs", ".html", ".txt", ".rsc", ".body", ".meta", ".map", ".csv", ".md",
]);
/** Webpack/turbopack persistent caches can hold stale dev-build content; they are never deployed. */
const SKIPPED_DIR_NAMES = new Set(["cache", "node_modules"]);

export type Offender = { file: string; reason: "synthetic filename" | "synthetic marker" };
export type ScanReport = { offenders: Offender[]; missing: string[]; scannedFiles: number };

/**
 * Recursively scan `dirs`. O(total bytes of text files + number of entries); iterative DFS so deep
 * trees cannot overflow the stack. Output order is sorted for stable messages.
 */
export function scanForSynthetic(dirs: readonly string[]): ScanReport {
  const offenders: Offender[] = [];
  const missing: string[] = [];
  let scannedFiles = 0;

  for (const root of dirs) {
    let rootStat;
    try {
      rootStat = statSync(root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        missing.push(root);
        continue;
      }
      throw e;
    }
    const stack: string[] = rootStat.isDirectory() ? [root] : [];
    const files: string[] = rootStat.isDirectory() ? [] : [root];
    while (stack.length > 0) {
      const dir = stack.pop() as string;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (!SKIPPED_DIR_NAMES.has(entry.name)) stack.push(full);
        } else if (entry.isFile()) {
          files.push(full);
        }
      }
    }
    for (const file of files) {
      scannedFiles++;
      const name = path.basename(file).toLowerCase();
      if (name.endsWith(SYNTHETIC_SUFFIX)) {
        offenders.push({ file, reason: "synthetic filename" });
        continue;
      }
      if (TEXT_EXTENSIONS.has(path.extname(name)) && SYNTHETIC_MARKER.test(readFileSync(file, "utf8"))) {
        offenders.push({ file, reason: "synthetic marker" });
      }
    }
  }
  offenders.sort((a, b) => a.file.localeCompare(b.file));
  return { offenders, missing, scannedFiles };
}

function main(argv: readonly string[]): number {
  const webRoot = path.resolve(import.meta.dirname, "..");
  const dirs = argv.length > 0
    ? argv.map((d) => path.resolve(d))
    : [path.join(webRoot, "public"), path.join(webRoot, ".next")];
  const report = scanForSynthetic(dirs);
  for (const m of report.missing) console.log(`check-no-synthetic: ${m} does not exist, skipped`);
  if (report.offenders.length > 0) {
    console.error(`check-no-synthetic: FAILED, ${report.offenders.length} synthetic file(s) would ship:`);
    for (const o of report.offenders) console.error(`  ${o.file} (${o.reason})`);
    console.error("Dev fixtures (*.synthetic.json) must never be bundled. Remove them and run `pnpm data:sync`.");
    return 1;
  }
  console.log(`check-no-synthetic: OK (${report.scannedFiles} file(s) scanned)`);
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
