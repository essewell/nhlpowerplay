"""Replay both teams' penalty boxes from play-by-play penalty and goal events.

Answers, for any game time (period, t): which penalties are running or waiting
on each side, how long each has left, and when the current man advantage
ends if nothing else happens.

Rules (sources and tunables in config.py):
  - Each penalty event is classified by (typeCode, duration minutes) through
    config.PENALTY_KIND_BY_CODE into minor / double_minor / major, or None for
    penalties that put no man down (misconduct, game misconduct, penalty shot).
    An unrecognised pair raises PenaltyError listing every such pair in the game.
  - Coincidental penalties (NHL Rule 19, quotes in config.py). At one stoppage,
    equal same-kind penalties to both teams are dropped (substitutes keep both
    sides whole) and the surplus is served normally -- EXCEPT the bare case of one
    minor per team with nothing else running or queued, which Rule 19.1 serves
    without substitution as 4v4: both go on the box flagged `coincidental`.
    Coincidental seats count as skaters down on their side (so a later third
    penalty gets the right advantage and end time) but never create an advantage
    by themselves and are never the penalty a goal releases.
  - At most config.MAX_ACTIVE_PENALTIES_PER_SIDE run per side; further ones
    queue and start when a running one ends.
  - A player's second penalty is served after his first (same seat, no extra
    man down); at the same instant a major is served before a minor.
  - A power-play goal (scoring team has more skaters per the goal's
    situationCode, or per the box when the code is absent) ends the
    NON-coincidental running minor with the LEAST TIME LEFT on the shorthanded
    side (Rule 16.2: "the minor penalty with the least amount of time on the
    clock shall terminate"), or, for a double minor, the minor in progress
    (more than MINOR_S left -> the second minor starts: MINOR_S left). Majors
    are never released. Penalties expiring in the goal's own second are
    processed BEFORE the release (the box is advanced to the goal time first),
    so a penalty that ends in that second is gone and cannot also be the one released.

All times are absolute game seconds: (period - 1) * PERIOD_LENGTH_S + t.

Complexity: PenaltyReplay() is O(E) over E events; at() is O(E + P^2) for P
man-down penalties (each expiry scans at most 2 * MAX_ACTIVE seats, P is small).
Thread safety: pure; a PenaltyReplay holds only immutable data after
construction and each at() call builds its own private box state.
"""
from __future__ import annotations

from dataclasses import dataclass, field, replace
from typing import Any

from . import config
from .parse import Event, GameHeader, ParseError

SIDE_PP = "pp"
SIDE_PK = "pk"


class PenaltyError(ParseError):
    """A penalty event the replay cannot interpret (unknown code, missing team)."""


def abs_time(period: int, t: int) -> int:
    """Absolute game seconds. O(1)."""
    return (period - 1) * config.PERIOD_LENGTH_S + t


@dataclass(frozen=True)
class BoxPenalty:
    order: int                 # index in the event list; deterministic tie-break
    event_id: int
    team_id: int               # penalised team
    player_id: int | None      # player serving (servedByPlayerId, else committedByPlayerId)
    kind: str
    called_at: int             # absolute seconds
    coincidental: bool = False  # Rule 19.1 4v4 pair: a skater down but never released by a goal


@dataclass(frozen=True)
class BoxSnapshot:
    penalties: list[dict[str, Any]]
    advantage_end_abs: int | None   # None: the box shows no advantage for the PP team


def classify(ev: Event) -> str | None:
    """Kind for one penalty event, or None if it puts no man down. Raises PenaltyError. O(1)."""
    code = (str(ev.penalty_type), ev.penalty_minutes)
    if code not in config.PENALTY_KIND_BY_CODE:
        raise PenaltyError(f"unrecognised penalty code {_describe(ev)}; add it to config.PENALTY_KIND_BY_CODE")
    return config.PENALTY_KIND_BY_CODE[code]


def _describe(ev: Event) -> tuple[str, str, str]:
    return (str(ev.penalty_type), str(ev.penalty_minutes), str(ev.extra.get("desc")))


@dataclass
class _Item:
    pen: BoxPenalty
    remaining: int             # seconds left on this penalty when it (re)starts
    coincidental: bool = False


@dataclass
class _Seat:
    """One man down: a chain of one player's penalties served back to back."""
    player_id: int | None
    chain: list[_Item]
    head_start: int | None = None   # set while running
    head_end: int | None = None


@dataclass
class _Box:
    teams: tuple[int, int]
    active: dict[int, list[_Seat]] = field(default_factory=dict)
    queued: dict[int, list[_Seat]] = field(default_factory=dict)
    now: int = 0

    def __post_init__(self) -> None:
        for team in self.teams:
            self.active.setdefault(team, [])
            self.queued.setdefault(team, [])

    # -- seat lifecycle -------------------------------------------------------
    def _start(self, seat: _Seat, at: int) -> None:
        seat.head_start = at
        seat.head_end = at + seat.chain[0].remaining

    def _finish_head(self, team: int, seat: _Seat, at: int) -> None:
        """Head penalty of a running seat ends at `at`; chain or queue moves up."""
        seat.chain.pop(0)
        if seat.chain:
            self._start(seat, at)
            return
        self.active[team].remove(seat)
        if self.queued[team]:
            nxt = self.queued[team].pop(0)
            self._start(nxt, at)
            self.active[team].append(nxt)

    def add(self, pen: BoxPenalty) -> None:
        item = _Item(pen, config.PENALTY_DURATION_S[pen.kind], pen.coincidental)
        if pen.player_id is not None:
            for seat in self.active[pen.team_id] + self.queued[pen.team_id]:
                if seat.player_id == pen.player_id:
                    seat.chain.append(item)
                    return
        seat = _Seat(pen.player_id, [item])
        if len(self.active[pen.team_id]) < config.MAX_ACTIVE_PENALTIES_PER_SIDE:
            self._start(seat, pen.called_at)
            self.active[pen.team_id].append(seat)
        else:
            self.queued[pen.team_id].append(seat)

    def next_expiry(self) -> tuple[int, int, _Seat] | None:
        best: tuple[int, int, int, _Seat] | None = None
        for team in self.teams:
            for seat in self.active[team]:
                assert seat.head_end is not None
                key = (seat.head_end, seat.chain[0].pen.order)
                if best is None or key < best[:2]:
                    best = (key[0], key[1], team, seat)
        return None if best is None else (best[0], best[2], best[3])

    def advance(self, to: int) -> None:
        while True:
            nxt = self.next_expiry()
            if nxt is None or nxt[0] > to:
                break
            end, team, seat = nxt
            self._finish_head(team, seat, end)
        self.now = max(self.now, to)

    def men_down(self, team: int) -> int:
        return len(self.active[team])

    def idle(self) -> bool:
        """True when no penalty is running or queued on either side. O(1)."""
        return not any(self.active[t] or self.queued[t] for t in self.teams)

    @staticmethod
    def _clock_left(seat: _Seat, at: int) -> int:
        """Seconds on the clock of the minor in progress (a double minor shows its current half). O(1)."""
        assert seat.head_end is not None
        left = seat.head_end - at
        if seat.chain[0].pen.kind == config.PEN_DOUBLE_MINOR and left > config.MINOR_S:
            return left - config.MINOR_S
        return left

    def release_on_pp_goal(self, shorthanded_team: int, at: int) -> None:
        """NHL Rule 16.2: end the non-coincidental minor with the least time on the clock. O(S)."""
        minors = [s for s in self.active[shorthanded_team]
                  if s.chain[0].pen.kind in (config.PEN_MINOR, config.PEN_DOUBLE_MINOR)
                  and not s.chain[0].coincidental]
        if not minors:
            return  # only majors / coincidentals running: nothing is released
        seat = min(minors, key=lambda s: (self._clock_left(s, at), s.chain[0].pen.order))
        assert seat.head_end is not None
        left = seat.head_end - at
        if seat.chain[0].pen.kind == config.PEN_DOUBLE_MINOR and left > config.MINOR_S:
            seat.head_end = at + config.MINOR_S  # first half of the double minor ends
            return
        self._finish_head(shorthanded_team, seat, at)

    def snapshot(self, pp_team: int, pk_team: int) -> list[dict[str, Any]]:
        rows: list[tuple[tuple[int, int, int], dict[str, Any]]] = []
        for team in (pk_team, pp_team):
            side = SIDE_PP if team == pp_team else SIDE_PK
            side_rank = 0 if side == SIDE_PK else 1
            for seat in self.active[team]:
                assert seat.head_end is not None
                for i, item in enumerate(seat.chain):
                    running = i == 0
                    row = {"side": side, "player_id": item.pen.player_id, "kind": item.pen.kind,
                           "remaining_s": (seat.head_end - self.now) if running else item.remaining,
                           "queued": not running}
                    if item.coincidental:
                        row["coincidental"] = True  # key present only on Rule 19.1 4v4 seats
                    rows.append(((side_rank, 0 if running else 1, item.pen.order), row))
            for seat in self.queued[team]:
                for item in seat.chain:
                    rows.append(((side_rank, 1, item.pen.order), {
                        "side": side, "player_id": item.pen.player_id, "kind": item.pen.kind,
                        "remaining_s": item.remaining, "queued": True}))
        rows.sort(key=lambda r: r[0])
        return [r[1] for r in rows]

    def advantage_end(self, pp_team: int, pk_team: int) -> int | None:
        """Absolute time the PP team's advantage ends if no further events occur.

        Consumes this box (simulates forward); call on a throwaway box only.
        """
        if self.men_down(pk_team) <= self.men_down(pp_team):
            return None
        while True:
            nxt = self.next_expiry()
            if nxt is None:  # unreachable while pk has running seats; kept explicit
                raise PenaltyError("advantage with no running penalty")
            self.advance(nxt[0])
            if self.men_down(pk_team) <= self.men_down(pp_team):
                return nxt[0]


class PenaltyReplay:
    """Pre-parsed penalty timeline for one game; query it with at(). O(E) to build."""

    def __init__(self, events: list[Event], header: GameHeader) -> None:
        self.header = header
        teams = (header.home_id, header.away_id)
        unknown: set[tuple[str, str, str]] = set()
        batches: dict[int, list[BoxPenalty]] = {}
        batch_order: dict[int, int] = {}
        goals: list[tuple[int, int, Event]] = []
        for order, ev in enumerate(events):
            if ev.kind == config.EV_PENALTY:
                try:
                    kind = classify(ev)
                except PenaltyError:
                    unknown.add(_describe(ev))
                    continue
                if kind is None:
                    continue
                if ev.team_id not in teams:
                    raise PenaltyError(f"game {header.game_id} penalty event {ev.event_id}: "
                                       f"team {ev.team_id} is neither home nor away")
                served = ev.extra.get("served_by")
                player = int(served) if served is not None else (None if ev.player1 is None else int(ev.player1))
                at = abs_time(ev.period, ev.t)
                batches.setdefault(at, []).append(BoxPenalty(order, ev.event_id, int(ev.team_id), player, kind, at))
                batch_order.setdefault(at, order)
            elif ev.kind == config.EV_GOAL and ev.team_id in teams:
                goals.append((abs_time(ev.period, ev.t), order, ev))
        if unknown:
            raise PenaltyError(f"game {header.game_id}: unrecognised penalty code(s) (typeCode, minutes, descKey) "
                               f"{sorted(unknown)}; add them to config.PENALTY_KIND_BY_CODE")
        timeline: list[tuple[int, int, str, Any]] = []
        for at, pens in batches.items():
            timeline.append((at, batch_order[at], "penalties", pens))
        for at, order, ev in goals:
            timeline.append((at, order, "goal", ev))
        timeline.sort(key=lambda x: (x[0], x[1]))
        self._timeline = timeline

    def at(self, period: int, t: int, pp_team_id: int) -> BoxSnapshot:
        """Box state at (period, t), events at exactly that time included. O(E + P^2)."""
        h = self.header
        if pp_team_id not in (h.home_id, h.away_id):
            raise PenaltyError(f"game {h.game_id}: pp team {pp_team_id} is neither home nor away")
        pk_team_id = h.away_id if pp_team_id == h.home_id else h.home_id
        query = abs_time(period, t)
        box = self._replay(query)
        penalties = box.snapshot(pp_team_id, pk_team_id)
        end = self._replay(query).advantage_end(pp_team_id, pk_team_id)
        return BoxSnapshot(penalties=penalties, advantage_end_abs=end)

    def _replay(self, query: int) -> _Box:
        h = self.header
        box = _Box((h.home_id, h.away_id))
        for at, _order, what, payload in self._timeline:
            if at > query:
                break
            box.advance(at)
            if what == "penalties":
                for pen in _cancel_coincidental(payload, h, box.idle()):
                    box.add(pen)
            else:
                scorer = int(payload.team_id)
                victim = h.away_id if scorer == h.home_id else h.home_id
                if _is_pp_goal(payload, scorer == h.home_id, box, scorer, victim):
                    box.release_on_pp_goal(victim, at)
        box.advance(query)
        return box


def _is_pp_goal(goal: Event, scorer_is_home: bool, box: _Box, scorer: int, victim: int) -> bool:
    """True if the scoring team was on a power play when it scored. O(1).

    A goal's situationCode is the state BEFORE the goal, not after it. Measured on
    the 999 cached games (2015-16..2025-26 playoffs), 5.7k goals:
      - 1127 goals carry a PP code while the previous event is PP, the next event
        is even strength and the box replay shows the victim a man down: the code
        on the goal still shows the advantage the goal ended (a post-goal code
        would read even strength). By situationCode alone 1188 of 1265 goals that
        end an advantage look like this; short-handed goals likewise (267 vs 26).
      - 64 goals carry an even code while the previous event is PP and the next is
        even; the box agrees in 62 that the minor had already expired before the
        goal, so those are correctly not power-play goals.
    So the box is released from the code on the goal itself, never from the next
    event's code. Without a code, fall back to the box's skater-down counts
    (coincidental seats included: a 4v4 pair gives no advantage).
    """
    if goal.situation is not None:
        return goal.situation.is_power_play(scorer_is_home)
    return box.men_down(victim) > box.men_down(scorer)


def _cancel_coincidental(pens: list[BoxPenalty], header: GameHeader, box_idle: bool) -> list[BoxPenalty]:
    """Apply NHL Rule 19 to the man-down penalties assessed at one stoppage. O(n log n).

    box_idle: nothing running or queued on either side when the stoppage happens.
    Exactly one minor per team on an idle box is served as a 4v4 pair (both kept,
    flagged coincidental); otherwise equal same-kind pairs are dropped (majors
    first per player) and the surplus is returned for normal service.
    """
    if box_idle and len(pens) == 2 and all(p.kind == config.PEN_MINOR for p in pens)             and {p.team_id for p in pens} == {header.home_id, header.away_id}:
        return sorted((replace(p, coincidental=True) for p in pens), key=lambda p: p.order)
    cancelled: set[int] = set()
    for kind in (config.PEN_MINOR, config.PEN_DOUBLE_MINOR, config.PEN_MAJOR):
        home = [p for p in pens if p.kind == kind and p.team_id == header.home_id]
        away = [p for p in pens if p.kind == kind and p.team_id == header.away_id]
        for a, b in zip(home, away):
            cancelled.update((a.order, b.order))
    kept = [p for p in pens if p.order not in cancelled]
    # A player with a major and a minor at once serves the major first (NHL Rule 20).
    kept.sort(key=lambda p: (p.kind != config.PEN_MAJOR, p.order))
    return kept
