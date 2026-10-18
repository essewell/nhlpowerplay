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

import logging
from dataclasses import asdict, dataclass, field
from typing import Any

from . import config
from .parse import Event, GameHeader
from .penalty_box import PenaltyReplay

OUTCOME_GOAL = "goal"
OUTCOME_SH_GOAL = "sh_goal_against"
OUTCOME_NO_GOAL = "no_goal"
OUTCOME_CARRIED = "carried_over"
STRENGTH_FROM_FACEOFF = "faceoff"
STRENGTH_FROM_OPENER = "opener"

logger = logging.getLogger(__name__)


def restart_event(events: list[Event], open_idx: int, pp_is_home: bool) -> Event | None:
    """The restart faceoff for a PP opened at events[open_idx], or None.

    Walks forward from the opener (inclusive) through dead-puck events only
    (config.DEAD_PUCK_EVENTS: penalty, stoppage, delayed-penalty,
    period-start) and returns the first faceoff, if it still shows this side
    on a power play. Clock stamps are not compared: the PBP can log a
    stoppage after its own restart time (e.g. stoppage 16:21, faceoff 16:19).
    Returns None when the opener or anything before the faceoff is a live-play
    event (the PP began in play, e.g. a penalty expiring), when the period
    ends first, or when the faceoff no longer shows the PP; the caller then
    falls back to the opening event, explicitly. O(k) for the k events walked.
    """
    opener = events[open_idx]
    for ev in events[open_idx:]:
        if ev.period != opener.period:
            return None
        if ev.t < opener.t:
            continue  # logged late but stamped before the opener: not play after the restart
        if ev.kind != config.EV_FACEOFF and ev.kind not in config.DEAD_PUCK_EVENTS:
            return None
        if ev.kind == config.EV_FACEOFF and ev.situation is not None:
            return ev if ev.situation.is_power_play(pp_is_home) else None
    return None


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
    goalie_pulled: bool = False          # PP side's goalie off at the restart faceoff (situationCode)
    restart_t: int | None = None         # time of the restart faceoff; on-ice units are looked up here
    strength_source: str = ""            # STRENGTH_FROM_FACEOFF, or STRENGTH_FROM_OPENER (logged fallback)
    penalties: list[dict[str, Any]] = field(default_factory=list)  # penalty_box snapshot at the opener
    seq: int = 0  # disambiguates segments that share (game_id, period, start_t); see segment_id()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def _abs_t(period: int, t: int) -> int:
    return (period - 1) * config.PERIOD_LENGTH_S + t


def build_segments(header: GameHeader, events: list[Event]) -> list[PpSegment]:
    """Cut every PP in one game. Raises penalty_box.PenaltyError on an unknown penalty code.

    pp_remaining_s is the time until the advantage ends per the penalty-box
    replay (None when the replay shows no advantage for the PP team, e.g. a
    penalty missing from the PBP); such segments never enter the pool.
    O(E + S * (E + P^2)) for E events, S segments, P man-down penalties.
    """
    replay = PenaltyReplay(events, header)
    segments: list[PpSegment] = []
    current: PpSegment | None = None
    home_score = away_score = 0
    last_penalty_by_team: dict[int, Event] = {}
    # (period, start_t) -> (index into segments, is a flicker). Lets a real
    # segment supersede a flicker that already claimed its slot, in either
    # arrival order, without ever holding two segments at the same key.
    slot_by_key: dict[tuple[int, int], tuple[int, bool]] = {}
    seq_by_key: dict[tuple[int, int], int] = {}  # next disambiguating seq per key, for real collisions

    def append(seg: PpSegment) -> None:
        # A zero-length no-result segment is a momentary situationCode flicker
        # (e.g. two coincidental penalties logged at the same instant), not a
        # real power play. It only gets dropped if something else already
        # occupies its (period, start_t) slot -- a *lone* zero-length segment
        # (e.g. one truncated by the recorded data simply ending) is kept, since
        # it carries real state and nothing collides with its id. A goal or
        # shorthanded-goal outcome is never treated as a flicker: a goal happened.
        is_flicker = seg.start_t == seg.end_t and seg.outcome in (OUTCOME_NO_GOAL, OUTCOME_CARRIED)
        key = (seg.period, seg.start_t)
        slot = slot_by_key.get(key)
        if slot is not None:
            prior_idx, prior_is_flicker = slot
            if is_flicker:
                return  # a flicker never displaces whatever already holds this slot
            if prior_is_flicker:
                segments[prior_idx] = seg  # real segment supersedes the flicker that shared this id
                slot_by_key[key] = (prior_idx, False)
                return
            seg.seq = seq_by_key.get(key, 0) + 1  # two distinct real segments share an id: disambiguate
            seq_by_key[key] = seg.seq
            segments.append(seg)
            return
        slot_by_key[key] = (len(segments), is_flicker)
        segments.append(seg)

    def close(outcome: str, ev: Event) -> None:
        nonlocal current
        assert current is not None
        current.outcome = outcome
        current.end_t = ev.t if ev.period == current.period else config.PERIOD_LENGTH_S
        append(current)
        current = None

    for idx, ev in enumerate(events):
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
            # Strength, goalie_pulled, the on-ice time and the box snapshot all
            # come from the restart faceoff, not from the penalty / stoppage
            # event whose situationCode can be a delayed-call transient.
            restart = restart_event(events, idx, pp_is_home)
            if restart is None:
                # Common and legitimate when a PP begins in live play; the
                # segment records strength_source so callers can count these.
                logger.info("game %s P%s %ss: no restart faceoff after the opener; strength taken from "
                            "the opening %s event", header.game_id, ev.period, ev.t, ev.kind)
                restart, source = ev, STRENGTH_FROM_OPENER
            else:
                source = STRENGTH_FROM_FACEOFF
            assert restart.situation is not None
            box = replay.at(restart.period, restart.t, pp_team)
            remaining = (None if box.advantage_end_abs is None
                         else box.advantage_end_abs - _abs_t(restart.period, restart.t))
            current = PpSegment(
                game_id=header.game_id, game_type=header.game_type, date=header.date,
                pp_team_id=pp_team, pk_team_id=pk_team, pp_is_home=pp_is_home,
                period=ev.period, start_t=ev.t, end_t=ev.t,
                strength=restart.situation.label(pp_is_home),
                pp_score=home_score if pp_is_home else away_score,
                pk_score=away_score if pp_is_home else home_score,
                pp_remaining_s=remaining,
                penalty_event_id=pen.event_id if pen else None,
                penalised_player_id=pen.player1 if pen else None,
                goalie_pulled=restart.situation.skaters(pp_is_home)[1] == 0,
                penalties=box.penalties,
                restart_t=restart.t,
                strength_source=source,
            )
            _collect(current, ev)

    if current is not None:
        current.outcome = OUTCOME_NO_GOAL
        append(current)
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
