/** Synthetic data must never remain in public/ (the production prebuild guard would fail the build). */
import { rmSync } from "node:fs";
import { PUBLIC_DATA } from "./prepare-data.ts";

export default function globalTeardown(): void {
  rmSync(PUBLIC_DATA, { recursive: true, force: true });
}
