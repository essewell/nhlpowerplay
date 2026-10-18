# PowerPlay — Claude Code kickoff

One Claude Code session per step. Start each in Plan mode, approve the plan, then let it build.
Each step ends with its gate passing; do not start the next step until it does.

## Step 0 — Local setup (you, ~15 min)

1. Install: Node 22.18+, pnpm, Python 3.10+, Git, Claude Code.
2. Unzip, then `cd powerplay; git init; git add -A; git commit -m "starter"`.
3. Prove the starter works:
   `node --test "packages/engine/src/*.test.ts"` (17 pass) and
   `cd data-pipeline; python -m unittest discover -s pipeline/tests -t .` (20 pass).
4. Data is owned by the Cowork session: see docs/DATA_RUNBOOK.md. Claude Code reads
   docs/DATA_STATUS.md to know when real export JSON is ready.

## Step 1 — Scaffold the monorepo

> Read CLAUDE.md and docs/DESIGN.md. Plan a pnpm workspace: `apps/web` (Next.js App Router,
> TypeScript strict, Tailwind configured with the tokens in docs/DESIGN.md, Barlow Condensed +
> IBM Plex Sans via next/font) and `packages/engine` (keep existing files and their node:test
> tests; add package.json and tsconfig with allowImportingTsExtensions + noEmit). Add a GitHub
> Actions CI running engine tests, pipeline tests, typecheck and lint. List every assumption.
> Do not write files until I approve.

**Gate:** CI green; `pnpm dev` serves an empty home page in the design's colours and fonts.

## Step 2 — Engine: simulation core

> In packages/engine add `sim.ts` and `machine.ts`. Model a run as: scenario intro -> faceoff
> call -> live sim -> decision pause (puck on our skater's stick) -> resolve -> continue | PP
> goal | cleared (zone-entry call) | PP expires | shorthanded goal. Use XState for the run machine.
> Resolve each call by sampling the existing likelihood functions with the seeded PRNG from
> modes.ts. Clock rules: minor 2:00 ends on PP goal, double minor, major, 5v3 overlaps,
> carry-over between periods. Auto-play neutral/defensive-zone touches unless "ask every touch"
> is on. Every constant goes in constants.ts flagged ASSUMPTION. Tests: determinism, 10,000
> random runs with zero thrown errors, and the 10 edge cases in docs/KICKOFF.md#edge-cases.

**Gate:** determinism test + 10k fuzz pass; Big-O comments present.

## Step 3 — Data into the app

> Check docs/DATA_STATUS.md. If export is not ready yet, build against a small dev fixture in
> apps/web/dev-fixtures/ whose files are named *.synthetic.json and contain only invented,
> clearly labelled data; production builds must fail if a synthetic file is bundled.
> Define Zod schemas for every file in data-pipeline/data/export (scenarios, ratings, base_rates,
> schedule, endless_index) in packages/engine/src/schema.ts. Write a copy script
> `pnpm data:sync` that validates and copies export JSON into apps/web/public/data. Build a
> loader that turns one scenario + ratings into engine inputs (Skater, Goalie, Defender).
> Missing ratings fall back to league average (multiplier 1.0) and are flagged in the UI.

**Gate:** all exported files validate; a scenario loads in a unit test.

## Step 4 — Screens from the design canvas

> Build Home, Rink (decision pause), Shot picker and Results exactly as specified in
> docs/DESIGN.md. Rink renders the offensive zone in feet with Canvas for skaters/puck and SVG
> for markings. Decision sheet: PASS lists every teammate with "NN% connects"; SKATE lists named
> spots from OZ_SPOTS with "NN% keeps puck"; SHOOT opens the shot picker (type x target with
> % goal, on net, blocked; corners mapped to glove/blocker by goalie catch hand). Every
> percentage comes from packages/engine likelihood functions — none hard-coded. Mobile first,
> 44 px targets, grades readable without colour.

**Gate:** Playwright mobile test plays the Daily start to finish; axe shows no contrast errors.

## Step 5 — Grader, results, share

> Run grading in a Web Worker via Comlink: for each pause, estimate V(a) for every legal call
> with seeded rollouts and grade the chosen call (best <=0.5 pp, close <=2, costly <=5, miss >5).
> Results screen: banner, real outcome, grade strip, percentile vs simulated benches, share text.

**Gate:** one pause grades in <150 ms on a mid-range phone profile.

## Step 6 — Backend

> Supabase: tables runs and profiles with RLS; anonymous auth; `POST /api/runs` re-runs the
> engine from (scenarioId, seed, calls) and stores the official score; leaderboard view.

**Gate:** server score equals client score on 1,000 fuzzed runs; RLS tests pass.

## Step 7 — Deploy

> Deploy apps/web to Vercel (root apps/web), env vars from docs, preview per PR.

**Gate:** the 5-step audit in CLAUDE.md passes on the preview URL.

## Edge cases

1. PP goal at the exact second the penalty expires.
2. Overlapping minors (5v3 -> 5v4); a goal releases only the earlier penalty.
3. Period ends mid-PP; time carries over.
4. Clear with too little time to re-enter: run ends cleanly.
5. 6v4 with goalie pulled: empty-net goal against ends the run.
6. Reload mid-run resumes from seed + calls; no second Daily attempt.
7. Daily rolls over mid-run: finish on the starting scenario.
8. Offline at submit: queue, retry, show provisional score.
9. Double tap on a call: one call recorded.
10. Slow device: fewer rollouts, grade labelled "approx".
