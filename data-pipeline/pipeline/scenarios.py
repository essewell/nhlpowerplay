"""Scenario assembly: curated famous moments + mined pool + daily schedule.

Curated moments (data/curated_moments.json) carry only facts verified against
cited sources. resolve_curated() then finds the exact PP segment in the NHL
play-by-play and REFUSES to emit a scenario if the data disagrees with the
curated facts (no silent fallbacks).

Complexity: resolve O(E) per game; mine O(N log N) for N segments.
Pure except for client I/O; not thread-safe only through the shared client.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from . import config
from .nhl_client import NhlClient, need
from .parse import GameHeader, mmss_to_seconds, parse_events, parse_header, parse_roster
from .segments import OUTCOME_CARRIED, OUTCOME_GOAL, PpSegment, build_segments


class CurationMismatch(RuntimeError):
    """Curated facts do not match the play-by-play. Fix the curated entry or investigate."""


class ScenarioInvalid(ValueError):
    """A built scenario contradicts itself (e.g. on-ice counts vs strength); it must not be exported."""


# ---------------------------------------------------------------------------
# Shifts -> on-ice lookup
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Shift:
    player_id: int
    team_id: int
    period: int
    start: int
    end: int


def parse_shifts(raw: dict[str, Any]) -> list[Shift]:
    """Parse stats-API shift charts. Field names are probed by `build.py probe`."""
    out: list[Shift] = []
    for row in need(raw, "data"):
        start, end = row.get("startTime"), row.get("endTime")
        if not start or not end:
            continue  # goal-event rows in shift charts carry no shift times
        out.append(Shift(int(need(row, "playerId")), int(need(row, "teamId")), int(need(row, "period")),
                         mmss_to_seconds(start), mmss_to_seconds(end)))
    return out


def on_ice(shifts: list[Shift], team_id: int, period: int, t: int, inclusive_end: bool = False) -> set[int]:
    """Players of team_id on ice at (period, t). start <= t < end, or <= end for goals. O(S)."""
    return {s.player_id for s in shifts if s.team_id == team_id and s.period == period
            and s.start <= t and (t <= s.end if inclusive_end else t < s.end)}


# ---------------------------------------------------------------------------
# Scenario building
# ---------------------------------------------------------------------------
def stable_seed(scenario_id: str) -> int:
    """Deterministic 32-bit seed from an id (same on every machine)."""
    return int.from_bytes(hashlib.sha256(scenario_id.encode("utf-8")).digest()[:4], "big")


def _sweater_key(p: dict[str, Any]) -> tuple[bool, int, int]:
    number = p.get("number")
    return (number is None, int(number) if number is not None else 0, int(p["id"]))


def scenario_from_segment(seg: PpSegment, header: GameHeader, roster: dict[int, dict[str, Any]],
                          shifts: list[Shift] | None, scenario_id: str,
                          narrative: dict[str, Any] | None = None, stage: str | None = None) -> dict[str, Any]:
    """One scenario in the shared curated/mined shape. O(S + R) for S shifts, R roster spots.

    pp.bench lists the PP team's roster skaters (no goalies) who are neither on
    the ice nor serving a penalty, sorted by sweater number (unknown numbers last).
    Does not validate; call validate_scenario() before exporting.
    """
    on_ice_ids: dict[int, set[int]] = {}

    def unit(team_id: int) -> dict[str, Any]:
        at = seg.restart_t if seg.restart_t is not None else seg.start_t  # restart faceoff, see segments.py
        ids = on_ice(shifts, team_id, seg.period, at) if shifts else set()
        on_ice_ids[team_id] = ids
        players = [{"id": pid, **roster.get(pid, {})} for pid in sorted(ids)]
        return {
            "team_id": team_id,
            "abbrev": header.home_abbrev if team_id == header.home_id else header.away_abbrev,
            "skaters": [p for p in players if p.get("pos") != "G"],
            "goalie": next((p for p in players if p.get("pos") == "G"), None),
            "on_ice_source": "shifts" if shifts else "unknown",
        }
    pp = unit(seg.pp_team_id)
    boxed = {p["player_id"] for p in seg.penalties if p.get("side") == "pp" and p.get("player_id") is not None}
    pp["bench"] = sorted(
        ({"id": pid, **r} for pid, r in roster.items()
         if r.get("team_id") == seg.pp_team_id and r.get("pos") != "G"
         and pid not in on_ice_ids[seg.pp_team_id] and pid not in boxed),
        key=_sweater_key)
    return {
        "id": scenario_id,
        "seed": stable_seed(scenario_id),
        "game": {"nhl_game_id": header.game_id, "date": header.date, "game_type": header.game_type,
                 "home": header.home_abbrev, "away": header.away_abbrev, "stage": stage},
        "state": {"period": seg.period, "clock_elapsed_s": seg.start_t, "strength": seg.strength,
                  "score": {"pp": seg.pp_score, "pk": seg.pk_score},
                  "pp_remaining_s": seg.pp_remaining_s,
                  "penalties": [dict(p) for p in seg.penalties],
                  "goalie_pulled": seg.goalie_pulled},
        "pp": pp,
        "pk": unit(seg.pk_team_id),
        "real_outcome": {"result": seg.outcome, "scorer_id": seg.scorer_id, "assist1_id": seg.assist1_id,
                         "assist2_id": seg.assist2_id, "end_t": seg.end_t},
        "narrative": narrative or {},
    }


def validate_scenario(scen: dict[str, Any]) -> None:
    """Raise ScenarioInvalid unless on-ice skater counts match the strength. O(1).

    strength is "<pp>v<pk>" skaters from the opening situationCode; the PP
    count already includes an extra attacker when the goalie is pulled, so
    the PP unit must hold exactly <pp> skaters and the PK unit <pk>.
    """
    sid = scen.get("id")
    strength = scen.get("state", {}).get("strength")
    try:
        want_pp, want_pk = (int(x) for x in str(strength).split("v"))
    except ValueError as exc:
        raise ScenarioInvalid(f"{sid}: unreadable strength {strength!r}") from exc
    if scen["pp"].get("on_ice_source") != "shifts":
        raise ScenarioInvalid(f"{sid}: no shift data, on-ice units unknown (lineups are never invented)")
    got_pp, got_pk = len(scen["pp"]["skaters"]), len(scen["pk"]["skaters"])
    if (got_pp, got_pk) != (want_pp, want_pk):
        raise ScenarioInvalid(f"{sid}: on-ice skaters {got_pp}v{got_pk} from shifts do not match strength "
                              f"{strength}" + (" (PP goalie pulled)" if scen["state"].get("goalie_pulled") else ""))


def resolve_curated(moment: dict[str, Any], client: NhlClient) -> dict[str, Any]:
    """Locate a curated moment in real data and verify every stated fact."""
    teams = set(need(moment, "teams"))
    games = [g for g in need(client.score_by_date(need(moment, "date")), "games")
             if {need(g, "homeTeam.abbrev"), need(g, "awayTeam.abbrev")} == teams]
    if len(games) != 1:
        raise CurationMismatch(f"{moment['id']}: expected 1 game for {sorted(teams)} on {moment['date']}, "
                               f"found {len(games)}")
    game_id = int(need(games[0], "id"))
    pbp = client.pbp(game_id)
    header, roster = parse_header(pbp), parse_roster(pbp)
    events = parse_events(pbp, header)
    segs = build_segments(header, events)
    pp_abbrev = need(moment, "pp_team")
    pp_team_id = header.home_id if header.home_abbrev == pp_abbrev else header.away_id
    if pp_abbrev not in (header.home_abbrev, header.away_abbrev):
        raise CurationMismatch(f"{moment['id']}: pp_team {pp_abbrev} not in game {game_id}")

    candidates = [s for s in segs if s.pp_team_id == pp_team_id and s.period == moment["period"]
                  and s.outcome == moment["real_outcome"]]
    if moment.get("goal_time"):
        gt = mmss_to_seconds(moment["goal_time"])
        candidates = [s for s in candidates if s.outcome == OUTCOME_GOAL and s.end_t == gt]
    if moment.get("penalty_time"):
        pt = mmss_to_seconds(moment["penalty_time"])
        pen_ids = {e.event_id for e in events if e.kind == config.EV_PENALTY and e.period == moment["period"]
                   and e.t == pt}
        candidates = [s for s in candidates if s.penalty_event_id in pen_ids]
    if moment.get("scorer_last"):
        want = moment["scorer_last"].casefold()
        candidates = [s for s in candidates
                      if s.scorer_id is not None and roster.get(s.scorer_id, {}).get("last", "").casefold() == want]
    if moment.get("score_before"):
        sb = moment["score_before"]
        candidates = [s for s in candidates if (s.pp_score, s.pk_score) == (sb["pp"], sb["pk"])]
    if len(candidates) != 1:
        raise CurationMismatch(f"{moment['id']}: {len(candidates)} matching PP segments in game {game_id}")

    try:
        shifts = parse_shifts(client.shifts(game_id))
    except Exception as exc:  # noqa: BLE001 - recorded, never swallowed silently
        shifts = None
        moment.setdefault("_warnings", []).append(f"shifts unavailable: {exc}")
    scen = scenario_from_segment(candidates[0], header, roster, shifts, need(moment, "id"),
                                 narrative={"title": moment.get("title"), "sources": moment.get("sources", [])},
                                 stage=moment.get("stage"))
    try:
        validate_scenario(scen)
    except ScenarioInvalid as exc:
        raise CurationMismatch(f"{moment['id']}: scenario fails validation, not exported: {exc}") from exc
    scen["verification"] = {"status": "verified_against_pbp", "warnings": moment.get("_warnings", [])}
    return scen


# ---------------------------------------------------------------------------
# Mining + modes
# ---------------------------------------------------------------------------
def drama_score(seg: dict[str, Any]) -> float:
    """Heuristic interest score. NOT a win-probability model."""
    stage = config.STAGE_WEIGHT["P"] if seg["game_type"] == config.GAME_TYPE_PLAYOFF else config.STAGE_WEIGHT["R"]
    diff = abs(seg["pp_score"] - seg["pk_score"])
    close = config.CLOSENESS_WEIGHT.get(diff, config.CLOSENESS_FLOOR)
    late = config.OVERTIME_BONUS if seg["period"] > config.LATE_PERIOD else (
        1.0 + seg["start_t"] / config.PERIOD_LENGTH_S if seg["period"] == config.LATE_PERIOD else 1.0)
    return stage * close * late


def playable(seg: dict[str, Any]) -> bool:
    """True if a mined segment may enter the Daily/Endless pool. O(1).

    Excluded (fail closed on a missing field):
      - games without shift charts (`has_shifts` falsy or absent): no real
        on-ice units, and lineups are never invented. Those games still feed
        ratings and base rates; only the pool skips them.
      - zero-length segments (end_t <= start_t): a 0-second power play.
      - segments opening at or after the period's end (start_t >=
        PERIOD_LENGTH_S): period-end openers with nothing left to play.
      - too little PP time left, or a carried-over tail.
    """
    if not seg.get("has_shifts"):
        return False
    start_t, end_t = seg.get("start_t"), seg.get("end_t")
    if start_t is None or end_t is None or end_t <= start_t or start_t >= config.PERIOD_LENGTH_S:
        return False
    rem = seg.get("pp_remaining_s")
    return rem is not None and rem >= config.MIN_PP_REMAINING_FOR_POOL_S and seg["outcome"] != OUTCOME_CARRIED


def mine(segments: list[dict[str, Any]], limit: int = config.DAILY_POOL_SIZE) -> list[dict[str, Any]]:
    """Top playable segments by drama, deterministic tie-break. O(N log N).

    Each segment dict must carry its game's `has_shifts` flag (build.cmd_schedule
    copies it from the games table); segments without it are not playable.
    """
    pool = [s for s in segments if playable(s)]
    pool.sort(key=lambda s: (-drama_score(s), s["game_id"], s["start_t"]))
    return pool[:limit]


def daily_schedule(curated_ids: list[str], mined_ids: list[str], start: date) -> list[dict[str, str]]:
    """Curated moments first, then mined. One scenario per calendar day, no repeats."""
    seen: set[str] = set()
    ordered = [i for i in curated_ids + mined_ids if not (i in seen or seen.add(i))]
    return [{"date": (start + timedelta(days=n)).isoformat(), "scenario_id": sid} for n, sid in enumerate(ordered)]


def segment_id(seg: dict[str, Any]) -> str:
    """'<game_id>-p<period>-<start_t>', with a '-d<n>' suffix for the rare case
    of two distinct, non-zero-length segments starting at the same (period,
    start_t) in one game (see segments.build_segments's seq field)."""
    base = f"{seg['game_id']}-p{seg['period']}-{seg['start_t']:04d}"
    seq = seg.get("seq", 0)
    return base if not seq else f"{base}-d{seq}"

