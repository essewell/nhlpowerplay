# Build tracker

Owned by Claude Code. One row per step in docs/KICKOFF.md; a step is done only when its gate passes.

| Step | Gate | Status | Date | Note |
| --- | --- | --- | --- | --- |
| 0 Local setup | engine tests 17 pass; pipeline tests 20 pass | done | 2026-10-18 | Node 24.15.0, pnpm 10.4.1, Python 3.12.10 |
| 1 Scaffold monorepo | CI green; `pnpm dev` serves empty home page in design colours and fonts | done | 2026-10-18 | CI run 39161201119 green on 32d4cec (engine, pipeline, web). Home verified at 390 px: bg #0B1220, Barlow Condensed 700, IBM Plex Sans. Repo: github.com/essewell/nhlpowerplay, default branch main |
| 2 Engine sim core | determinism test + 10k fuzz pass; Big-O comments present | not started | | |
| 3 Data into the app | all exported files validate; a scenario loads in a unit test | not started | | export not ready yet: use synthetic dev fixtures |
| 4 Screens | Playwright mobile test plays the Daily start to finish; axe shows no contrast errors | not started | | |
| 5 Grader, results, share | one pause grades in <150 ms on a mid-range phone profile | not started | | |
| 6 Backend | server score equals client score on 1,000 fuzzed runs; RLS tests pass | not started | | |
| 7 Deploy | the 5-step audit in CLAUDE.md passes on the preview URL | not started | | |

## Carry-overs

From the Step 1 engine-reviewer pass (all pre-existing in `packages/engine/src`, none introduced by Step 1). Fix at the start of Step 2:

- P1 `modes.ts` `EndlessQueue` constructor throws on an empty pool; should return `Result<T>` (e.g. a static `create`).
- P2 `likelihood.ts` `distanceBucket` maps NaN or negative distances to a valid bucket silently; `laneThreat` does not validate `sigma <= 0`.
- P3 `passLikelihood` and `skateLikelihood` do not reject non-finite positions.
- P3 several public functions have fewer than 5 edge-case tests (`baseRate`, `zoneFor`, `pct`, `dailyScenario`, `EndlessQueue`, `fnv1a`, `mulberry32`, subtext helpers).
- P3 `Result<T>` is defined in both `likelihood.ts` and `modes.ts`; move it to one module.
- Turn on `noUncheckedIndexedAccess` in `packages/engine/tsconfig.json` (left off in Step 1: it flags 6 bounds-safe reads).
