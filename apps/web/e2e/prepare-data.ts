/**
 * Playwright data prep: put the SYNTHETIC dev fixtures into apps/web/public/data before `next dev` starts.
 * Refuses to touch an existing public/data that holds real (non-synthetic) data, because global teardown
 * deletes the folder. Single-threaded CLI; O(fixture bytes).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { scanForSynthetic } from "../scripts/check-no-synthetic.ts";

export const WEB_ROOT = path.resolve(import.meta.dirname, "..");
export const PUBLIC_DATA = path.join(WEB_ROOT, "public", "data");

export function prepareSyntheticData(): number {
  if (existsSync(PUBLIC_DATA) && scanForSynthetic([PUBLIC_DATA]).offenders.length === 0) {
    console.error(`e2e: ${PUBLIC_DATA} exists and holds no synthetic marker (real data?). Refusing to replace it; the e2e teardown would delete it.`);
    return 1;
  }
  const run = spawnSync(process.execPath, [path.join(WEB_ROOT, "scripts", "data-dev.ts"), "--to", PUBLIC_DATA], {
    stdio: "inherit",
  });
  return run.status ?? 1;
}

if (import.meta.main) {
  process.exitCode = prepareSyntheticData();
}
