"""Turn PP segments into probabilities the game engine can use.

Outputs (all from real PP events, 2015-16 .. 2025-26):
  base_rates   P(goal | unblocked shot, shot type, distance bucket) and
               P(goal | on-net shot, ...), with counts.
  shooters     finishing multiplier, accuracy (on-net share), shrunk.
  goalies      goals-allowed multiplier vs expected (>1 = worse), shrunk.
  faceoffs     win rate on PP-state draws, shrunk to 50%.
  playmakers   primary-assist multiplier vs expectation, shrunk.
  matchups     shooter x goalie PP history (shots, goals, expected goals).

Shrinkage: multiplier = (observed + m) / (expected + m)  (Gamma-Poisson
posterior mean with prior mean 1 and prior strength m pseudo-goals).

Complexity: O(S) over S shots plus O(P log P) for percentile ranking of P players.
Pure functions; thread-safe.
"""
from __future__ import annotations

from bisect import bisect_left
from collections import defaultdict
from dataclasses import dataclass
from typing import Any, Callable, Iterable

from . import config
from .parse import distance_bucket

ON_NET_KINDS = frozenset({config.EV_GOAL, config.EV_SHOT})
UNKNOWN_TYPE = "unknown"


def season_of(game_id: int) -> str:
    """2023020204 -> '20232024'. ID layout: YYYY TT NNNN (season start year, game type, number).

    Matches the example IDs in the Zmalski reference; validated against the
    scope of the id's own game type (config.seasons_for_type), so a 2009-10
    playoff game is in scope while a 2009-10 regular-season game is not.
    Raises ValueError for an out-of-scope season or an unknown game type. O(1).
    """
    year = game_id // 1_000_000
    game_type = (game_id // 10_000) % 100
    season = f"{year}{year + 1}"
    try:
        scope = config.seasons_for_type(game_type)
    except ValueError as exc:
        raise ValueError(f"game {game_id}: {exc}") from exc
    if season not in scope:
        raise ValueError(f"game {game_id} maps to season {season} outside configured scope "
                         f"for game type {game_type}")
    return season


def _key(shot: dict[str, Any]) -> tuple[str, int] | None:
    if shot.get("distance") is None:
        return None
    return (shot.get("shot_type") or UNKNOWN_TYPE, distance_bucket(float(shot["distance"])))


@dataclass
class RateCell:
    attempts: int = 0
    on_net: int = 0
    goals: int = 0

    @property
    def p_goal_unblocked(self) -> float:
        return self.goals / self.attempts if self.attempts else 0.0

    @property
    def p_goal_on_net(self) -> float:
        return self.goals / self.on_net if self.on_net else 0.0


def base_rates(segments: Iterable[dict[str, Any]]) -> dict[tuple[str, int], RateCell]:
    cells: dict[tuple[str, int], RateCell] = defaultdict(RateCell)
    for seg in segments:
        for shot in seg["shots"]:
            if shot["kind"] == config.EV_BLOCK:
                continue
            k = _key(shot)
            if k is None:
                continue
            cell = cells[k]
            cell.attempts += 1
            cell.on_net += shot["kind"] in ON_NET_KINDS
            cell.goals += shot["kind"] == config.EV_GOAL
    return dict(cells)


def _fallback_rate(rates: dict[tuple[str, int], RateCell], bucket: int, on_net: bool) -> float:
    """Pooled rate for a distance bucket across shot types (used for sparse cells)."""
    goals = sum(c.goals for (t, b), c in rates.items() if b == bucket)
    denom = sum((c.on_net if on_net else c.attempts) for (t, b), c in rates.items() if b == bucket)
    return goals / denom if denom else 0.0


def expected(rates: dict[tuple[str, int], RateCell], key: tuple[str, int], on_net: bool,
             min_cell: int = 50) -> float:
    """League expectation for one shot; pools across types when the cell has < min_cell samples."""
    cell = rates.get(key)
    if cell is not None and (cell.on_net if on_net else cell.attempts) >= min_cell:
        return cell.p_goal_on_net if on_net else cell.p_goal_unblocked
    return _fallback_rate(rates, key[1], on_net)


def shrunk_multiplier(observed: float, expect: float, prior: float) -> float:
    if expect < 0 or observed < 0 or prior <= 0:
        raise ValueError("observed/expected must be >= 0 and prior > 0")
    return (observed + prior) / (expect + prior)


def compute(segments: list[dict[str, Any]],
            on_ice: Callable[[dict[str, Any]], set[int]] | None = None) -> dict[str, Any]:
    """Compute every rating table. `on_ice(segment)` returns PP-team skater IDs on
    ice at the segment's goal (from shift charts); without it playmaking exposure
    falls back to goal participants and is flagged."""
    rates = base_rates(segments)

    shooter = defaultdict(lambda: {"attempts": 0, "on_net": 0, "goals": 0, "xg": 0.0})
    goalie = defaultdict(lambda: {"on_net": 0, "ga": 0, "xga": 0.0})
    matchup = defaultdict(lambda: {"on_net": 0, "goals": 0, "xg": 0.0})
    fo = defaultdict(lambda: {"won": 0, "taken": 0})
    a1 = defaultdict(int)
    presence = defaultdict(int)
    exposure_source = "shifts" if on_ice else "participants_only"

    league_on_net = league_attempts = 0
    for seg in segments:
        for shot in seg["shots"]:
            if shot["kind"] == config.EV_BLOCK:
                continue
            k = _key(shot)
            sid, gid = shot.get("shooter"), shot.get("goalie")
            is_goal = shot["kind"] == config.EV_GOAL
            on_net = shot["kind"] in ON_NET_KINDS
            league_attempts += 1
            league_on_net += on_net
            if sid is not None:
                s = shooter[sid]
                s["attempts"] += 1
                s["on_net"] += on_net
                s["goals"] += is_goal
                if k is not None:
                    s["xg"] += expected(rates, k, on_net=False)
            if gid is not None and on_net and k is not None:
                g = goalie[gid]
                xg_on = expected(rates, k, on_net=True)
                g["on_net"] += 1
                g["ga"] += is_goal
                g["xga"] += xg_on
                if sid is not None:
                    m = matchup[(sid, gid)]
                    m["on_net"] += 1
                    m["goals"] += is_goal
                    m["xg"] += xg_on
        for f in seg["faceoffs"]:
            if f["winner"] is not None and f["loser"] is not None:
                fo[f["winner"]]["won"] += 1
                fo[f["winner"]]["taken"] += 1
                fo[f["loser"]]["taken"] += 1
        if seg["outcome"] == "goal":
            if seg.get("assist1_id") is not None:
                a1[seg["assist1_id"]] += 1
            skaters = on_ice(seg) if on_ice else {
                p for p in (seg.get("scorer_id"), seg.get("assist1_id"), seg.get("assist2_id")) if p is not None}
            for p in skaters:
                presence[p] += 1

    league_accuracy = league_on_net / league_attempts if league_attempts else 0.0
    total_presence = sum(presence.values())
    a1_per_presence = sum(a1.values()) / total_presence if total_presence else 0.0

    shooters_out = {
        pid: {
            **v,
            "xg": round(v["xg"], 3),
            "finishing_mult": round(shrunk_multiplier(v["goals"], v["xg"], config.PRIOR_GOALS_SHOOTER), 4),
            "accuracy": round((v["on_net"] + 50 * league_accuracy) / (v["attempts"] + 50), 4),  # 50 = pseudo-shots, ASSUMPTION
        } for pid, v in shooter.items()
    }
    goalies_out = {
        pid: {**v, "xga": round(v["xga"], 3),
              "ga_mult": round(shrunk_multiplier(v["ga"], v["xga"], config.PRIOR_GOALS_GOALIE), 4)}
        for pid, v in goalie.items()
    }
    faceoffs_out = {
        pid: {**v, "win_rate": round((v["won"] + config.PRIOR_FACEOFFS * config.FACEOFF_PRIOR_RATE)
                                     / (v["taken"] + config.PRIOR_FACEOFFS), 4)}
        for pid, v in fo.items()
    }
    playmakers_out = {
        pid: {"a1": a1.get(pid, 0), "presence": n,
              "playmaking_mult": round(shrunk_multiplier(a1.get(pid, 0), n * a1_per_presence,
                                                         config.PRIOR_ASSISTS_PLAYMAKER), 4)}
        for pid, n in presence.items()
    }
    _attach_display_ratings(shooters_out, "finishing_mult", "attempts", higher_is_better=True)
    _attach_display_ratings(goalies_out, "ga_mult", "on_net", higher_is_better=False)

    return {
        "base_rates": {f"{t}|{b}": vars(c) | {"p_unblocked": round(c.p_goal_unblocked, 4),
                                               "p_on_net": round(c.p_goal_on_net, 4)}
                       for (t, b), c in sorted(rates.items())},
        "league": {"attempts": league_attempts, "accuracy": round(league_accuracy, 4),
                   "a1_per_presence": round(a1_per_presence, 4), "exposure_source": exposure_source},
        "shooters": shooters_out,
        "goalies": goalies_out,
        "faceoffs": faceoffs_out,
        "playmakers": playmakers_out,
        "matchups": {f"{s}|{g}": {**v, "xg": round(v["xg"], 3)} for (s, g), v in matchup.items()},
    }


def _attach_display_ratings(table: dict[Any, dict[str, Any]], metric: str, sample: str,
                            higher_is_better: bool) -> None:
    """Add 'rating' (40..99) by percentile among players with enough sample.
    Low-sample players are placed on the same curve but flagged."""
    ranked = sorted(v[metric] for v in table.values() if v[sample] >= config.MIN_SHOTS_FOR_RATING_RANK)
    n = len(ranked)
    for v in table.values():
        if n == 0:
            v["rating"], v["low_sample"] = None, True
            continue
        pct = bisect_left(ranked, v[metric]) / n
        if not higher_is_better:
            pct = 1.0 - pct
        v["rating"] = int(round(config.RATING_FLOOR + config.RATING_SPAN * min(max(pct, 0.0), 1.0)))
        v["low_sample"] = v[sample] < config.MIN_SHOTS_FOR_RATING_RANK
