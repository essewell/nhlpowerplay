/** Verifies the synthetic data the webServer command synced is in place; syncs it if not. Runs once. */
import { existsSync } from "node:fs";
import path from "node:path";
import { prepareSyntheticData, PUBLIC_DATA } from "./prepare-data.ts";

export default function globalSetup(): void {
  if (existsSync(path.join(PUBLIC_DATA, "schedule.json"))) return;
  if (prepareSyntheticData() !== 0) throw new Error("e2e: could not sync synthetic data into public/data");
}
