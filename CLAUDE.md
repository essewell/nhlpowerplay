# PowerPlay — NHL power-play coaching game

You coach a real NHL power play. Play pauses whenever the puck reaches one of your skaters;
the player picks PASS / SKATE / SHOOT / SET PLAY, and every option shows a likelihood
subtext. Modes: **Daily** (same scenario for everyone) and **Endless** (random real scenarios).

Specs: `docs/KICKOFF.md` (session plan), `docs/DESIGN.md` (tokens + screens). Read the
relevant section before any change. If a requirement is ambiguous, ask; never guess silently.

## Layout
- `packages/engine/` — pure TypeScript: likelihood model (`likelihood.ts`), modes (`modes.ts`),
  tunables (`constants.ts`). Next: sim + state machine. No DOM, no `Date.now`, no `Math.random`:
  all randomness comes from the seeded PRNG passed in. Imports use `.ts` extensions
  (`allowImportingTsExtensions` + `noEmit`, or a bundler that rewrites them).
- `apps/web/` — Next.js App Router + Tailwind (to be created). Engine runs in a Web Worker in the
  browser and in `POST /api/runs` on the server for official scoring.
- `data-pipeline/` — Python 3.10+, stdlib only. Builds the scenario/ratings DB from NHL
  play-by-play 2015-16..2025-26 and exports JSON. Never called at runtime.
- `data-pipeline/data/export/` — pipeline output; copied into `apps/web/public/data/`.

## Data truth rules
- Real (from PBP): scenarios, on-ice units, base P(goal) by shot type x distance, shooter
  finishing/accuracy, goalie goals-vs-expected, faceoff %, playmaking, matchups.
- Modeled (flagged ASSUMPTION in `constants.ts`): pass completion, carry retention, net-zone
  factors, OZ spot coordinates. Never present modeled numbers as historical facts in UI copy.
- Never type player stats or game facts into code or copy. Curated moments live only in
  `data-pipeline/data/curated_moments.json`, each with sources.

## Code rules
- Runnable code only. Explicit errors: engine returns `Result<T>`; never swallow exceptions.
- No magic numbers: tunables in `constants.ts` with a source or `ASSUMPTION — tune`.
- Big-O comment on every algorithm; thread/worker ownership comment at the top of stateful modules.
- Tests: happy path + at least 5 edge cases per public function; a determinism test for any
  engine change (same seed + same calls => identical run).
- New dependency => say why in the PR description.
- Before declaring done: Intent Validation, Edge Case Audit (>=5), Integration Verification,
  UX Stress Test, Documentation Sync.

## Commands (PowerShell or bash, from repo root)
- Engine tests: `node --test "packages/engine/src/*.test.ts"`
- Pipeline tests: `cd data-pipeline; python -m unittest discover -s pipeline/tests -t .`
- Pipeline: `cd data-pipeline; python -m pipeline.build probe --game-id 2023020204 --date 2023-11-10`
  then `ingest --seasons all --types 3`, `ratings`, `curate`, `schedule --start <date>`, `export`
