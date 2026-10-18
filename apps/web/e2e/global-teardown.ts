/** Synthetic data must never remain in public/ (the production prebuild guard would fail the build). */
import { rmSync } from "node:fs";
import { PUBLIC_DATA } from "./prepare-data.ts";

export default function globalTeardown(): void {
  // Against an external dev server (E2E_BASE_URL) the data belongs to that server's owner: leave it.
  if (process.env.E2E_BASE_URL) return;
  rmSync(PUBLIC_DATA, { recursive: true, force: true });
}
