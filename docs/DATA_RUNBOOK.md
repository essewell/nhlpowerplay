# Data runbook (owned by the Cowork session)

Where the data comes from: the NHL's public JSON endpoints (`api-web.nhle.com` and
`api.nhle.com/stats/rest`). The pipeline in `data-pipeline/` downloads them, caches every response
(gzip) in `data-pipeline/data/raw/`, and builds `data-pipeline/data/powerplay.db` plus
`data-pipeline/data/export/*.json`. No API key is needed. Nothing is typed in by hand.

## Ownership (so two agents never edit the same file)

| Path | Owner |
| --- | --- |
| `data-pipeline/data/**`, `docs/DATA_STATUS.md`, `docs/COPY.md` | Cowork |
| `apps/**`, `packages/**`, `docs/TRACKER.md`, CI files | Claude Code |
| `data-pipeline/pipeline/**` (Python code) | Claude Code; Cowork reports parser problems in DATA_STATUS.md |

## Stages

| # | Command (run inside `data-pipeline/`) | Expected | If it fails |
| --- | --- | --- | --- |
| 1 | `python -m unittest discover -s pipeline/tests -t .` | 20 tests OK | Stop; record the error |
| 2 | `python -m pipeline.build probe --game-id 2023020204 --date 2023-11-10` | `probe OK` | Network error: see Fallback. Missing key path: record exact output for Claude Code |
| 3 | `python -m pipeline.build all --seasons all --types 3 --start 2026-11-01` | Playoffs 2015-26 built and exported; `data/run_status.json` written | Rerun the same command; the cache makes it resume |
| 4 | `python -m pipeline.build all --seasons all --types 2,3 --start 2026-11-01` | Full regular season + playoffs | Same; run season by season if the session times out (`--seasons 20152016`, then the next, then once more with `all`) |

Time (arithmetic estimate at the 0.5 s polite interval, not measured): playoffs only about
15-20 minutes; full build about 4-5 hours. Disk: unknown until stage 3 finishes; record the size of
`data/raw/` after stage 3 and extrapolate before starting stage 4.

## Fallback if Cowork cannot reach the NHL domains

Cowork's code runs in an isolated VM whose network access follows your egress settings. If
`probe` fails with a network or proxy error:
1. Allow `api-web.nhle.com` and `api.nhle.com` in your Cowork network settings and retry, or
2. Run stages 2-4 yourself in PowerShell on your PC (Python 3.10+, no installs). Cowork then
   continues from the cached files.

## After each stage, update `docs/DATA_STATUS.md`

```
Last run: <date time>   Stage: <n>   Result: OK | PARTIAL | FAILED
Seasons/types: ...
Games ingested: N   Failures: N (see data/ingest_failures.log)
Curated verified: N / M  (failures: data/curate_failures.log)
Export ready: yes/no   Path: data-pipeline/data/export/
Notes for Claude Code: ...
```

## Curated moments (after stage 3 succeeds)

Expand `data/curated_moments.json` toward 30 playoff power-play moments from 2015-26, following
its rules: every fact from a source actually opened, unknown fields null, include some
failed power plays (`"real_outcome": "no_goal"`). Show the proposed list to Emmett before writing.
Then run `python -m pipeline.build curate`, `schedule --start 2026-11-01` and `export`. A moment that
fails curate gets fixed in the data or removed. The check is never weakened.
