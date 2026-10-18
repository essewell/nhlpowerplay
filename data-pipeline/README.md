# PowerPlay scenario + ratings database

Builds the real-data database behind PowerPlay: every NHL power play from
**2015-16 through 2025-26** (regular season and playoffs), player and goalie
probability ratings, shooter-vs-goalie matchups, curated famous moments, the
Daily schedule and the Endless pool. Plus the TypeScript likelihood engine that
turns those numbers into option subtext ("Pass to Kucherov · 78% connects").

## What is real data vs. modeled

| Piece | Source | Status |
| --- | --- | --- |
| Games, PP segments, score/clock/strength, penalties, on-ice skaters | NHL play-by-play + shift charts (api-web.nhle.com, api.nhle.com/stats/rest) | Real, pulled by `ingest` |
| P(goal) by shot type x distance on the PP | Same PBP, all PP shots 2015-26 | Real, computed by `ratings` |
| Shooter finishing, accuracy; goalie goals-vs-expected; faceoff %; playmaking (primary assists) | Same | Real, shrunk toward league average |
| Shooter x goalie matchups | Same | Real |
| 6 curated famous moments | Facts from cited articles in `data/curated_moments.json` | Verified against sources; `curate` re-verifies against PBP |
| Pass completion, skating/carry retention | No public NHL pass data | **Modeled** (`packages/engine/src/constants.ts`, flagged ASSUMPTION), to fit on Stathletes Big Data Cup |
| Net-zone (top glove, five-hole, etc.) effects | Public PBP has no puck-entry location | **Modeled**; seeded from cited goal-share data in `data/model_priors.json` |

Nothing in this repo contains typed-in player statistics: every rating is
computed from the play-by-play when you run the pipeline.

## Run it (PowerShell or bash, Python 3.10+, no pip installs)

```bash
cd powerplay-data
python -m unittest discover -s pipeline/tests -t .        # 20 tests, offline
node --test "../packages/engine/src/*.test.ts"               # 17 engine tests, Node 22.18+

python -m pipeline.build probe --game-id 2023020204 --date 2023-11-10   # MUST pass first
python -m pipeline.build ingest --seasons all --types 3                 # playoffs only, fast start
python -m pipeline.build ingest --seasons all --types 2,3               # full build
python -m pipeline.build ratings
python -m pipeline.build curate
python -m pipeline.build schedule --start 2026-11-01
python -m pipeline.build export                                         # -> data/export/*.json
```

`probe` checks every response key path the parser depends on against live data
and exits non-zero if the NHL changed a shape. Field names were taken from
hockeyR's scraper of the same endpoints, but some (`rosterSpots`, shift-chart
fields, the stats `/en/game` listing) were not confirmed against a live
response from this environment, which has no network access. Run `probe`
before trusting anything else.

**Cost estimate (arithmetic, not measured):** ~1,300 regular-season + ~85
playoff games per season x 11 seasons, 2 requests each (PBP + shifts), at the
0.5 s polite interval = roughly 4-5 hours for the full build; playoffs only is
roughly 15-20 minutes. Every response is cached in `data/raw/`, so reruns and
`--offline` builds cost nothing.

## Outputs (`data/export/`)

| File | Contents |
| --- | --- |
| `base_rates.json` | P(goal) per PP shot type x distance bucket, with counts |
| `shooter_ratings.json`, `goalie_ratings.json`, `faceoff_ratings.json`, `playmaker_ratings.json` | Per player, per season and `all`; multipliers + 40-99 display rating + low-sample flag |
| `scenarios/<id>.json` | One file per scenario: real teams, on-ice units, score, clock, PP time left, hidden real outcome |
| `schedule.json` | Daily mode: one scenario per date, identical for everyone (curated first, then mined) |
| `endless_index.json` | Endless mode pool |

## Rating math

Multipliers use Gamma-Poisson shrinkage: `(observed + m) / (expected + m)`,
where `expected` sums league base rates for that player's actual shots and `m`
is a prior strength in pseudo-goals (`config.py`, flagged ASSUMPTION, tune by
split-half reliability). A shooter with 0 shots is exactly league average (1.0).

## Complexity

Parsing and segmenting: O(E) per game. Ratings: O(S) over S shots plus
O(P log P) to rank P players. Mining: O(N log N). Likelihood calls: O(D) for
D <= 5 defenders. Endless queue: O(n) shuffle, O(1) per draw.

## Thread safety

Pipeline: single-threaded by design; `NhlClient` and the SQLite connection are
not shared across threads. Engine: pure functions; `EndlessQueue` holds per-run
state and must not be shared between runs.

## Data credits and terms

NHL data via the public, undocumented NHL endpoints (community reference:
github.com/Zmalski/NHL-API-Reference). Review the NHL site terms before any
commercial use. Not affiliated with the NHL or NHLPA.
