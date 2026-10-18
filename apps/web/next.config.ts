import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const nextConfig: NextConfig = {
  // Monorepo: trace files from the repo root so workspace packages are included.
  outputFileTracingRoot: repoRoot,
};

export default nextConfig;
