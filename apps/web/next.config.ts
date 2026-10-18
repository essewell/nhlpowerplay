import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Netlify sets CONTEXT at build time: "production", "deploy-preview", "branch-deploy" or "dev".
// Every non-production deploy must stay out of search engines (docs/LAUNCH.md, Deploy checklist).
const isProduction = process.env.CONTEXT === undefined || process.env.CONTEXT === "production";

const nextConfig: NextConfig = {
  // Monorepo: trace files from the repo root so workspace packages are included.
  outputFileTracingRoot: repoRoot,
  async headers() {
    if (isProduction) return [];
    return [{ source: "/:path*", headers: [{ key: "X-Robots-Tag", value: "noindex" }] }];
  },
};

export default nextConfig;
