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
# Penalty-box replay (penalty_box.py)
# ---------------------------------------------------------------------------
PEN_MINOR = "minor"
PEN_DOUBLE_MINOR = "double_minor"
PEN_MAJOR = "major"
DOUBLE_MINOR_S = 2 * MINOR_S            # NHL Rule 18 (double minor = two consecutive minors)
MAJOR_S = 300                           # NHL Rule 20 (major = 5 minutes)
PENALTY_DURATION_S = {PEN_MINOR: MINOR_S, PEN_DOUBLE_MINOR: DOUBLE_MINOR_S, PEN_MAJOR: MAJOR_S}
# Minutes in details.duration -> kind: Rule 16.1 minor = 2 min, Rule 18.1 double minor = 4 min,
# Rule 20.1 major = 5 min (NHL Official Rules 2025-26, media.nhl.com/site/asset/public/ext/2025-26/2025-26Rules.pdf).
PENALTY_KIND_BY_MINUTES = {2: PEN_MINOR, 4: PEN_DOUBLE_MINOR, 5: PEN_MAJOR}
# NHL Rule 16.2 (goal against a short-handed team): "If both criteria are
# satisfied, the minor penalty with the least amount of time on the clock shall
# terminate" (criteria: the team scored against is short-handed, i.e. "below the
# numerical strength of its opponent on the ice at the time the goal is scored",
# and is serving a minor on the clock). The same paragraph also says "the first of
# such penalties shall automatically terminate"; the criteria sentence is the
# specific one, so the penalty with the LEAST TIME LEFT is released, not the one
# that started first. Table 12 (A1/A2) for a double minor: a goal in its first half
# ends the first minor and "the second begins" at the goal; in the second half it
# ends the penalty. "No penalty shall expire when a goal is scored ... on a penalty
# shot" (not modelled).
# ASSUMPTION: for a double minor the time on the clock compared across seats is
# that of the minor in progress (left - MINOR_S while more than MINOR_S is left).
# NHL Rule 26 (delayed penalties): a team is never below three skaters, so at
# most two penalties per side run at once; further ones wait in a queue.
MAX_ACTIVE_PENALTIES_PER_SIDE = 2
# (details.typeCode, details.duration minutes) -> kind, or None for a penalty
# that puts no man down. Every pair below was seen in the cached play-by-play
# (999 games: 2015-16..2025-26 playoffs + probe games, surveyed 2026-10-18;
# counts in parentheses). Any other pair is an explicit PenaltyError, never a guess.
PENALTY_KIND_BY_CODE: dict[tuple[str, int], str | None] = {
    ("MIN", 2): PEN_MINOR,              # minor (7616)
    ("MIN", 4): PEN_DOUBLE_MINOR,       # *-double-minor descKeys (99)
    ("BEN", 2): PEN_MINOR,              # bench minor, served by servedByPlayerId (242)
    ("MAJ", 5): PEN_MAJOR,              # major (213)
    # Match penalty: player ejected, a teammate serves 5 minutes (NHL Rule 21).
    # ASSUMPTION: the duration-10 variant ('match-penatly-10-minutes', 5 seen)
    # is the same 5-minute man-down major; verify against situationCode.
    ("MAT", 5): PEN_MAJOR,              # (1)
    ("MAT", 10): PEN_MAJOR,             # (5)
    ("MIS", 10): None,                  # misconduct: player off, team not shorthanded (NHL Rule 22) (401)
    ("GAM", 10): None,                  # game misconduct (NHL Rule 23) (45)
    ("PS", 0): None,                    # penalty shot awarded instead of a minor (NHL Rule 24) (21)
}
# NHL Rule 19 (coincidental penalties), NHL Official Rules 2025-26 (same PDF):
#  - 19.1: "When one minor penalty is assessed to one player of each team at the
#    same stoppage in play, these penalties will be served without substitution
#    provided there are no other penalties in effect and visible on the penalty
#    clocks. Both teams will therefore play four skaters against four skaters".
#    Implemented exactly: a stoppage whose only man-down penalties are one minor
#    (or bench minor) per team, with nothing running or queued on either side,
#    puts BOTH on the box as `coincidental` (they cost a skater each: 4v4).
#  - 19.1 otherwise: "Immediate substitution shall be made for an equal number of
#    minor penalties ... and the penalties of the players for which substitutions
#    have been made shall not be taken into account"; 19.2 does the same for
#    majors; 19.5 says cancel as many major/match, then as many minor / bench
#    minor / double-minor as possible, "any differential ... served in the normal
#    manner". Implemented: equal same-kind pairs are dropped from the box (the
#    substitutes keep both sides at full strength); the surplus is served normally.
#  - 16.2: "coincident minor penalties to both Teams do not cause either side to be
#    'short-handed'", and a goal terminates "the minor penalty with the least
#    amount of time on the clock ... except when coincidental penalties are being
#    served" (Table 12 G4: A15 coincidental, A23 a later minor, goal -> A23 returns).
#    Implemented: coincidental box seats count as skaters down on both sides (so a
#    third penalty gets the right 5v4 / 4v3 advantage and end time) but are never
#    the penalty a power-play goal releases.
# ASSUMPTION: which of several same-kind penalties cancel is taken in event order
# (the rule leaves it to the captains), and unequal-kind mixes (a minor against
# one half of a double minor, a minor against a major) are not netted.

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
EV_STOPPAGE = "stoppage"
EV_DELAYED_PENALTY = "delayed-penalty"
EV_PERIOD_START = "period-start"
# Events logged while the puck is dead, between a stoppage and its restart
# faceoff (typeDescKeys seen in the cached PBP, surveyed 2026-10-18). Used by
# segments.restart_event to find the faceoff that restarts play after a call.
DEAD_PUCK_EVENTS = frozenset({EV_PENALTY, EV_STOPPAGE, EV_DELAYED_PENALTY, EV_PERIOD_START})
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
