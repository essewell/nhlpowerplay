"""Pipeline constants. Every tunable lives here with its source or an ASSUMPTION flag.

Thread safety: module holds only immutable constants; safe to import anywhere.
"""
from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------
FIRST_SEASON_START_YEAR = 2015          # 2015-16 season (regular-season scope)
LAST_SEASON_START_YEAR = 2025           # 2025-26 season (playoffs ended June 2026)
# Playoff scope reaches further back than the regular season. Source: Emmett,
# DECISION 2026-10-18 in docs/DATA_STATUS.md ("playoffs only, extended back to
# 2009-10"). 2009-10 is the first season with full PBP (situationCode + coords);
# its shift charts are empty, so those games feed ratings/base rates only.
PLAYOFF_FIRST_SEASON_START_YEAR = 2009  # 2009-10 season


def _season_range(first_start_year: int, last_start_year: int) -> tuple[str, ...]:
    return tuple(f"{y}{y + 1}" for y in range(first_start_year, last_start_year + 1))


SEASONS: tuple[str, ...] = _season_range(FIRST_SEASON_START_YEAR, LAST_SEASON_START_YEAR)  # regular season
PLAYOFF_SEASONS: tuple[str, ...] = _season_range(PLAYOFF_FIRST_SEASON_START_YEAR, LAST_SEASON_START_YEAR)
ALL_SEASONS: tuple[str, ...] = tuple(sorted(set(SEASONS) | set(PLAYOFF_SEASONS)))
GAME_TYPE_REGULAR = 2                   # per Zmalski NHL-API-Reference ("2 regular, 3 postseason")
GAME_TYPE_PLAYOFF = 3


def seasons_for_type(game_type: int) -> tuple[str, ...]:
    """Season scope for one game type: playoffs go back further than the regular season.

    Raises ValueError for an unknown game type. O(1).
    """
    if game_type == GAME_TYPE_PLAYOFF:
        return PLAYOFF_SEASONS
    if game_type == GAME_TYPE_REGULAR:
        return SEASONS
    raise ValueError(f"unknown game type {game_type}; expected {GAME_TYPE_REGULAR} or {GAME_TYPE_PLAYOFF}")

# ---------------------------------------------------------------------------
# Endpoints (community-documented, undocumented by the NHL; see README)
# ---------------------------------------------------------------------------
WEB_BASE = "https://api-web.nhle.com"
STATS_BASE = "https://api.nhle.com/stats/rest"
PBP_PATH = "/v1/gamecenter/{game_id}/play-by-play"
BOXSCORE_PATH = "/v1/gamecenter/{game_id}/boxscore"
SCORE_BY_DATE_PATH = "/v1/score/{date}"
SHIFTS_PATH = "/en/shiftcharts?cayenneExp=gameId={game_id}"
GAMES_BY_SEASON_PATH = "/en/game?cayenneExp=season={season}%20and%20gameType={game_type}"

# ---------------------------------------------------------------------------
# HTTP behaviour
# ---------------------------------------------------------------------------
REQUEST_MIN_INTERVAL_S = 0.5            # ASSUMPTION: polite rate; NHL publishes no limit
REQUEST_TIMEOUT_S = 20.0
MAX_RETRIES = 5
BACKOFF_BASE_S = 1.0                    # exponential: 1, 2, 4, 8, 16 s
RETRYABLE_HTTP = frozenset({429, 500, 502, 503, 504})
USER_AGENT = "PowerPlay-data-pipeline/0.1 (fan project; contact via repo)"

ROOT = Path(__file__).resolve().parent.parent
CACHE_DIR = ROOT / "data" / "raw"
DB_PATH = ROOT / "data" / "powerplay.db"
EXPORT_DIR = ROOT / "data" / "export"

# ---------------------------------------------------------------------------
# Rink geometry (feet, origin centre ice). Nets at x = +/-89 per hockeyR's
# shot-distance code (danmorse314/hockeyR scrape_game.R).
# ---------------------------------------------------------------------------
NET_X_FT = 89.0
BLUE_LINE_X_FT = 25.0                   # ASSUMPTION: verify vs rink spec before UI work
DISTANCE_BUCKETS_FT: tuple[float, ...] = (0.0, 10.0, 20.0, 30.0, 45.0, 64.0, 200.0)

# ---------------------------------------------------------------------------
# Clock and penalties
# ---------------------------------------------------------------------------
PERIOD_LENGTH_S = 1200
MINOR_S = 120
SECONDS_PER_PENALTY_MINUTE = 60

# ---------------------------------------------------------------------------
# Event vocabulary (typeDescKey values used by hockeyR against this API)
# ---------------------------------------------------------------------------
EV_GOAL = "goal"
EV_SHOT = "shot-on-goal"
EV_MISS = "missed-shot"
EV_BLOCK = "blocked-shot"
EV_FACEOFF = "faceoff"
EV_PENALTY = "penalty"
EV_PERIOD_END = "period-end"
UNBLOCKED_SHOT_EVENTS = frozenset({EV_GOAL, EV_SHOT, EV_MISS})
ALL_SHOT_EVENTS = UNBLOCKED_SHOT_EVENTS | {EV_BLOCK}

# ---------------------------------------------------------------------------
# homeTeamDefendingSide inference (missing on most plays before 2019-20).
# ---------------------------------------------------------------------------
# A period's zoneCode + xCoord pairs vote on which way the home team attacks;
# real play never swaps ends mid-period, so a clean period should show near-
# unanimous agreement. Below this bar we leave the side unresolved rather
# than guess. ASSUMPTION — tune against more old-season probes.
SIDE_INFERENCE_MIN_SAMPLES = 3
SIDE_INFERENCE_MIN_AGREEMENT = 0.9

# ---------------------------------------------------------------------------
# NHL stats-API gameStateId (community-documented, undocumented by the NHL).
# ASSUMPTION: inferred from observed data, not a published enum; cmd_probe
# checks this key path on every run so a live-data mismatch surfaces early.
# ---------------------------------------------------------------------------
GAME_STATE_NOT_PLAYED = 1
GAME_STATE_FINAL = 7

# A known pre-2019-20 game (missing homeTeamDefendingSide on nearly every
# play) that cmd_probe always re-checks in addition to whatever --game-id
# was passed, so the legacy-PBP code paths get exercised on every probe run.
PROBE_LEGACY_GAME_ID = 2015030111
PROBE_LEGACY_GAME_DATE = "2016-04-14"

# Early-era playoff games (one per season at the start of the playoff scope)
# that cmd_probe also re-checks and reports coverage for: shift-chart rows,
# situationCode, coordinates, homeTeamDefendingSide. Missing shifts here are
# reported, not failed: 2009-10 shift charts are known to be empty and those
# games are kept out of the mined pool via games.has_shifts.
# Ids/dates confirmed against the live API on 2026-10-18 (score-by-date lists them).
PROBE_ERA_GAMES: tuple[tuple[int, str], ...] = (
    (2009030416, "2010-06-09"),         # 2009-10 playoffs
    (2010030417, "2011-06-15"),         # 2010-11 playoffs
)

# ---------------------------------------------------------------------------
# Shrinkage priors (empirical Bayes, Gamma-Poisson on rate multipliers).
# multiplier = (observed + m) / (expected + m)
# ---------------------------------------------------------------------------
PRIOR_GOALS_SHOOTER = 6.0               # ASSUMPTION: tune by split-half reliability
PRIOR_GOALS_GOALIE = 12.0               # ASSUMPTION
PRIOR_ASSISTS_PLAYMAKER = 6.0           # ASSUMPTION
PRIOR_FACEOFFS = 200.0                  # ASSUMPTION: pseudo-draws at 50%
FACEOFF_PRIOR_RATE = 0.5
MIN_SHOTS_FOR_RATING_RANK = 30          # ASSUMPTION: rank only players with >= this many PP shots

RATING_FLOOR = 40                       # display scale floor
RATING_SPAN = 59                        # floor + span = 99

# ---------------------------------------------------------------------------
# Scenario mining ("drama" is a heuristic, not a win-probability model)
# ---------------------------------------------------------------------------
STAGE_WEIGHT = {"R": 1.0, "P": 2.5, "CONF_FINAL": 3.0, "SCF": 4.0}  # ASSUMPTION; round-level
# stages come only from curated moments (playoff round is not derived from game IDs).
OVERTIME_BONUS = 2.0                    # ASSUMPTION
CLOSE_GAME_MAX_DIFF = 1
DAILY_POOL_SIZE = 400
LATE_PERIOD = 3
CLOSENESS_WEIGHT = {0: 1.0, 1: 1.0, 2: 0.4}  # |score diff| -> weight; else CLOSENESS_FLOOR
CLOSENESS_FLOOR = 0.1
MIN_PP_REMAINING_FOR_POOL_S = 30         # ASSUMPTION: shorter PPs are not playable scenarios
