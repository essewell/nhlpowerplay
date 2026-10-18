# Build tracker

Owned by Claude Code. One row per step in docs/KICKOFF.md; a step is done only when its gate passes.

| Step | Gate | Status | Date | Note |
| --- | --- | --- | --- | --- |
| 0 Local setup | engine tests 17 pass; pipeline tests 20 pass | done | 2026-10-18 | Node 24.15.0, pnpm 10.4.1, Python 3.12.10 |
| 1 Scaffold monorepo | CI green; `pnpm dev` serves empty home page in design colours and fonts | done | 2026-10-18 | CI run 39161201119 green on 32d4cec (engine, pipeline, web). Home verified at 390 px: bg #0B1220, Barlow Condensed 700, IBM Plex Sans. Repo: github.com/essewell/nhlpowerplay, default branch main |
| 2 Engine sim core | determinism test + 10k fuzz pass; Big-O comments present | done | 2026-10-18 | CI green on f0e45f5. 338 engine tests in ~7 s: 10k fuzz over 11 fixtures with zero errors, determinism + replay + JSON resume, calibration within 2 sigma. engine-reviewer: gate passes after roster fix. XState run machine. |
| 3 Data into the app | all exported files validate; a scenario loads in a unit test | not started | | export not ready yet: use synthetic dev fixtures |
| 4 Screens | Playwright mobile test plays the Daily start to finish; axe shows no contrast errors | done (CI pending) | 2026-10-18 | 21 e2e tests at 390x844 touch on synthetic dev data: Daily start to finish + one-attempt lock, axe zero violations on all pages incl. decision pause and results, all targets >= 44 px. Grades are a Step 5 stub; PENDING copy in apps/web/lib/PENDING_COPY.md + lib/play/strings.ts for Cowork. Real data pending stage 3 rerun |
| 5 Grader, results, share | one pause grades in <150 ms on a mid-range phone profile | not started | | |
| 6 Backend | server score equals client score on 1,000 fuzzed runs; RLS tests pass | not started | | |
| 7 Deploy | the 5-step audit in CLAUDE.md passes on the preview URL | not started | | |

## Carry-overs

Closed in Step 2a (a8f4e5a): EndlessQueue Result API, distance/lane input validation, non-finite positions,
edge-case tests for every public likelihood and modes function, single `Result<T>`, `noUncheckedIndexedAccess` on.

Open, for Step 3 (data into the app):
- DATA_STATUS note: 42 of 400 mined scenarios are zero-length power plays (start_t == end_t); `playable()` must
  require end_t > start_t (or a minimum duration constant). Also check `2015030164-p3-1200` (starts at 1200 s, 6v4, 600 s left).
- Loader must pass a PP roster covering `clock.maxPpStrength` (bench skaters allowed); `initRun` rejects short rosters.
- Pipeline: `segments.py` sets `pp_remaining_s` from the PK team's last penalty only (wrong for 5v3, misconducts,
  coincidental minors) and the export has no penalties list. Add `state.penalties[]` and `goalie_pulled` to the
  export; the loader falls back to minor / double minor / major by remaining time when absent.
- Zod schemas must reject bad base-rate rows (negative attempts, `p_unblocked` outside [0, 1]); `baseRate` trusts them.
- `dailyScenario` checks only the date's shape (2026-13-45 passes) and does not dedupe the pool.

Open, for tuning (Step 5 playtests): sim probabilities are ASSUMPTION constants; a random policy ends about 8% of
runs in a shorthanded goal, likely too high.

Deferred engine edge cases: 8 (offline submit) -> Step 6; 10 (slow device, fewer rollouts) -> Step 5.
