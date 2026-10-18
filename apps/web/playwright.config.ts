import { defineConfig } from "@playwright/test";

const PORT = 3300;
const CI = Boolean(process.env.CI);
/**
 * Escape hatch for a machine that already runs `next dev` in apps/web (Next allows one dev server per
 * project dir, so a second one on port 3300 cannot start): E2E_BASE_URL=http://localhost:3000 runs the
 * tests against it instead. Data is still synced into public/data and deleted afterwards. Unset in CI.
 */
const EXTERNAL = process.env.E2E_BASE_URL;

/**
 * Mobile-first e2e (docs/KICKOFF.md Step 4 gate). One chromium project at 390x844 / DPR 3, touch.
 * `next dev` on a dedicated port serves SYNTHETIC fixtures synced into public/data; teardown deletes them.
 * Each test gets a fresh browser context, so localStorage starts empty.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: true,
  forbidOnly: CI,
  retries: CI ? 1 : 0,
  reporter: CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: EXTERNAL ?? `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "mobile",
      use: {
        browserName: "chromium",
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: EXTERNAL
    ? undefined
    : {
        command: `node e2e/prepare-data.ts && pnpm exec next dev -p ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: false,
        timeout: 180_000,
        stdout: "pipe",
        stderr: "pipe",
      },
});
