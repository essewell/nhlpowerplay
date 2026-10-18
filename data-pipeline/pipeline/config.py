"""Pipeline constants. Every tunable lives here with its source or an ASSUMPTION flag.

Thread safety: module holds only immutable constants; safe to import anywhere.
"""
from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------------------
# Scope
# ---------------------------------------------------------------------------
FIRST_SEASON_START_YEAR = 2015          # 2015-16 season
LAST_SEASON_START_YEAR = 2025           # 2025-26 season (playoffs ended June 2026)
SEASONS: tuple[str, ...] = tuple(
    f"{y}{y + 1}" for y in range(FIRST_SEASON_START_YEAR, LAST_SEASON_START_YEAR + 1)
)
GAME_TYPE_REGULAR = 2                   # per Zmalski NHL-API-Reference ("2 regular, 3 postseason")
GAME_TYPE_PLAYOFF = 3

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
