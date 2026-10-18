"""Cut every power play in a game into a PpSegment.

A segment opens on the first event whose situationCode gives one side a man
advantage (usually the faceoff right after the penalty) and closes on:
  - a goal by the PP team            -> outcome "goal"
  - a goal by the PK team            -> outcome "sh_goal_against"
  - the advantage disappearing       -> outcome "no_goal"
  - the period ending mid-advantage  -> outcome "carried_over" (time remains next period)

Complexity: O(E) over E events of one game; memory O(E) worst case.
Pure functions; thread-safe.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field
from typing import Any

from . import config
from .parse import Event, GameHeader

OUTCOME_GOAL = "goal"
OUTCOME_SH_GOAL = "sh_goal_against"
OUTCOME_NO_GOAL = "no_goal"
OUTCOME_CARRIED = "carried_over"


@dataclass
class PpSegment:
    game_id: int
    game_type: int
    date: str
    pp_team_id: int
    pk_team_id: int
    pp_is_home: bool
    period: int
    start_t: int
    end_t: int
    strength: str
    pp_score: int
    pk_score: int
    pp_remaining_s: int | None
    penalty_event_id: int | None
    penalised_player_id: int | None
    outcome: str = OUTCOME_NO_GOAL
    goal_event_id: int | None = None
    scorer_id: int | None = None
    assist1_id: int | None = None
    assist2_id: int | None = None
    goalie_id: int | None = None
    shots: list[dict[str, Any]] = field(default_factory=list)
    faceoffs: list[dict[str, Any]] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _abs_t(period: int, t: int) -> int:
    return (period - 1) * config.PERIOD_LENGTH_S + t


def build_segments(header: GameHeader, events: list[Event]) -> list[PpSegment]:
    segments: list[PpSegment] = []
    current: PpSegment | None = None
    home_score = away_score = 0
    last_penalty_by_team: dict[int, Event] = {}

    def close(outcome: str, ev: Event) -> None:
        nonlocal current
        assert current is not None
        current.outcome = outcome
        current.end_t = ev.t if ev.period == current.period else config.PERIOD_LENGTH_S
        segments.append(current)
        current = None

    for ev in events:
        if ev.kind == config.EV_PENALTY and ev.team_id is not None:
            last_penalty_by_team[ev.team_id] = ev

        if current is not None and ev.period != current.period:
            close(OUTCOME_CARRIED, ev)

        if ev.kind == config.EV_GOAL:
            if current is not None:
                if ev.team_id == current.pp_team_id:
                    current.goal_event_id = ev.event_id
                    current.scorer_id, current.assist1_id, current.assist2_id = ev.player1, ev.player2, ev.player3
                    current.goalie_id = ev.goalie
                    _record_shot(current, ev)
                    close(OUTCOME_GOAL, ev)
                elif ev.team_id == current.pk_team_id:
                    close(OUTCOME_SH_GOAL, ev)
            if ev.home_score is not None and ev.away_score is not None:
                home_score, away_score = int(ev.home_score), int(ev.away_score)
            continue

        if ev.situation is None:
            continue

        home_pp = ev.situation.is_power_play(True)
        away_pp = ev.situation.is_power_play(False)

        if current is not None:
            still = home_pp if current.pp_is_home else away_pp
            if not still:
                close(OUTCOME_NO_GOAL, ev)
            else:
                _collect(current, ev)
                continue

        if current is None and (home_pp or away_pp):
            pp_is_home = home_pp
            pp_team = header.home_id if pp_is_home else header.away_id
            pk_team = header.away_id if pp_is_home else header.home_id
            pen = last_penalty_by_team.get(pk_team)
            remaining = None
            if pen is not None and pen.penalty_minutes:
                end_abs = _abs_t(pen.period, pen.t) + pen.penalty_minutes * config.SECONDS_PER_PENALTY_MINUTE
                remaining = max(0, end_abs - _abs_t(ev.period, ev.t))
            current = PpSegment(
                game_id=header.game_id, game_type=header.game_type, date=header.date,
                pp_team_id=pp_team, pk_team_id=pk_team, pp_is_home=pp_is_home,
                period=ev.period, start_t=ev.t, end_t=ev.t,
                strength=ev.situation.label(pp_is_home),
                pp_score=home_score if pp_is_home else away_score,
                pk_score=away_score if pp_is_home else home_score,
                pp_remaining_s=remaining,
                penalty_event_id=pen.event_id if pen else None,
                penalised_player_id=pen.player1 if pen else None,
            )
            _collect(current, ev)

    if current is not None:
        current.outcome = OUTCOME_NO_GOAL
        segments.append(current)
    return segments


def _collect(seg: PpSegment, ev: Event) -> None:
    if ev.kind in config.ALL_SHOT_EVENTS and ev.team_id == seg.pp_team_id:
        _record_shot(seg, ev)
    elif ev.kind == config.EV_FACEOFF:
        seg.faceoffs.append({"event_id": ev.event_id, "t": ev.t, "winner": ev.player1,
                             "loser": ev.player2, "winner_team": ev.team_id, "zone": ev.extra.get("zone")})


def _record_shot(seg: PpSegment, ev: Event) -> None:
    seg.shots.append({
        "event_id": ev.event_id, "t": ev.t, "kind": ev.kind, "shooter": ev.player1,
        "goalie": ev.goalie, "shot_type": ev.shot_type, "x": ev.x, "y": ev.y,
        "distance": None if ev.distance is None else round(ev.distance, 1),
    })
