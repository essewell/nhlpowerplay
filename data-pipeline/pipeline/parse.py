"""Parse api-web.nhle.com play-by-play into typed events.

Field names follow hockeyR's scraper of the same endpoint
(danmorse314/hockeyR R/scrape_game.R): plays[].typeDescKey,
periodDescriptor.number, timeInPeriod, situationCode, homeTeamDefendingSide,
details.{xCoord,yCoord,shotType,eventOwnerTeamId,shootingPlayerId,
scoringPlayerId,assist1PlayerId,assist2PlayerId,goalieInNetId,
winningPlayerId,losingPlayerId,committedByPlayerId,drawnByPlayerId,
typeCode,duration,descKey,homeScore,awayScore}.

situationCode digits (hockeyR): [0]=away goalie in, [1]=away skaters,
[2]=home skaters, [3]=home goalie in.

All functions are pure; safe to call from any thread.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Any, Iterable

from . import config
from .nhl_client import SchemaError, need, opt


class ParseError(ValueError):
    """Raised when a value is present but malformed."""


@dataclass(frozen=True)
class Situation:
    away_goalie: int
    away_skaters: int
    home_skaters: int
    home_goalie: int

    def skaters(self, is_home: bool) -> tuple[int, int, int]:
        """Return (own skaters, own goalie in, opponent skaters)."""
        if is_home:
            return self.home_skaters, self.home_goalie, self.away_skaters
        return self.away_skaters, self.away_goalie, self.home_skaters

    def is_power_play(self, is_home: bool) -> bool:
        """True if this side has a man advantage, excluding an extra attacker.

        6v5 with a pulled goalie is NOT a power play; 6v4 on a PP is; 4v3 in
        3-on-3 OT is.
        """
        own, own_goalie, opp = self.skaters(is_home)
        effective = own - (1 if own_goalie == 0 else 0)
        return effective > opp

    def label(self, is_home: bool) -> str:
        own, _, opp = self.skaters(is_home)
        return f"{own}v{opp}"


def parse_situation(code: str) -> Situation:
    """Parse a 4-digit situationCode. O(1). Raises ParseError."""
    if not isinstance(code, str) or len(code) != 4 or not code.isdigit():
        raise ParseError(f"bad situationCode {code!r}")
    a_g, a_s, h_s, h_g = (int(c) for c in code)
    if a_g not in (0, 1) or h_g not in (0, 1) or not (0 < a_s <= 6) or not (0 < h_s <= 6):
        raise ParseError(f"out-of-range situationCode {code!r}")
    return Situation(a_g, a_s, h_s, h_g)


def mmss_to_seconds(value: str) -> int:
    """'12:23' -> 743. Raises ParseError."""
    try:
        minutes, seconds = value.split(":")
        m, s = int(minutes), int(seconds)
    except (AttributeError, ValueError) as exc:
        raise ParseError(f"bad clock value {value!r}") from exc
    if m < 0 or not (0 <= s < 60):
        raise ParseError(f"bad clock value {value!r}")
    return m * 60 + s


def normalize_xy(x: float, y: float, team_is_home: bool, home_defending_side: str | None) -> tuple[float, float]:
    """Rotate so the event team always attacks toward +x (net at +NET_X_FT).

    Home attacks +x when it defends the left side; away attacks +x when home
    defends the right side. Unknown side -> raise (never guess silently).
    """
    if home_defending_side not in ("left", "right"):
        raise ParseError(f"unknown homeTeamDefendingSide {home_defending_side!r}")
    attacks_positive = (home_defending_side == "left") == team_is_home
    return (x, y) if attacks_positive else (-x, -y)


def shot_distance_ft(x: float, y: float) -> float:
    """Distance to the attacked net at (+NET_X_FT, 0) in normalized coords."""
    return math.hypot(config.NET_X_FT - x, y)


def distance_bucket(dist: float) -> int:
    """Index into DISTANCE_BUCKETS_FT. O(B) with B buckets."""
    edges = config.DISTANCE_BUCKETS_FT
    for i in range(len(edges) - 1):
        if edges[i] <= dist < edges[i + 1]:
            return i
    return len(edges) - 2


@dataclass
class Event:
    event_id: int
    kind: str
    period: int
    t: int                         # seconds into period
    situation: Situation | None
    team_id: int | None            # team credited with the action (shooter's team for blocks)
    team_is_home: bool | None
    x: float | None = None         # normalized, event team attacks +x
    y: float | None = None
    shot_type: str | None = None
    player1: int | None = None     # shooter / scorer / FO winner / penalised player
    player2: int | None = None     # A1 / blocker / FO loser / drew penalty
    player3: int | None = None     # A2
    goalie: int | None = None
    penalty_type: str | None = None
    penalty_minutes: int | None = None
    home_score: int | None = None
    away_score: int | None = None
    extra: dict[str, Any] = field(default_factory=dict)

    @property
    def distance(self) -> float | None:
        if self.x is None or self.y is None:
            return None
        return shot_distance_ft(self.x, self.y)


@dataclass(frozen=True)
class GameHeader:
    game_id: int
    date: str
    game_type: int
    home_id: int
    home_abbrev: str
    away_id: int
    away_abbrev: str


def parse_header(pbp: dict[str, Any]) -> GameHeader:
    return GameHeader(
        game_id=int(need(pbp, "id")),
        date=str(need(pbp, "gameDate")),
        game_type=int(need(pbp, "gameType")),
        home_id=int(need(pbp, "homeTeam.id")),
        home_abbrev=str(need(pbp, "homeTeam.abbrev")),
        away_id=int(need(pbp, "awayTeam.id")),
        away_abbrev=str(need(pbp, "awayTeam.abbrev")),
    )


def parse_roster(pbp: dict[str, Any]) -> dict[int, dict[str, Any]]:
    """playerId -> {name, team_id, number, pos}. Empty dict if rosterSpots absent."""
    roster: dict[int, dict[str, Any]] = {}
    for spot in opt(pbp, "rosterSpots", []) or []:
        pid = int(need(spot, "playerId"))
        roster[pid] = {
            "team_id": int(need(spot, "teamId")),
            "first": opt(spot, "firstName.default", ""),
            "last": opt(spot, "lastName.default", ""),
            "number": opt(spot, "sweaterNumber"),
            "pos": opt(spot, "positionCode"),
        }
    return roster


def parse_events(pbp: dict[str, Any], header: GameHeader) -> list[Event]:
    """Convert raw plays into Events in API order. O(P) for P plays.

    Plays without situationCode keep situation=None (e.g. some period markers).
    Raises SchemaError / ParseError on malformed required fields.
    """
    events: list[Event] = []
    for i, play in enumerate(need(pbp, "plays")):
        try:
            events.append(_parse_play(play, header))
        except (SchemaError, ParseError) as exc:
            raise type(exc)(f"game {header.game_id} play[{i}]: {exc}") from exc
    return events


def _parse_play(play: dict[str, Any], header: GameHeader) -> Event:
    kind = str(need(play, "typeDescKey"))
    period = int(need(play, "periodDescriptor.number"))
    t = mmss_to_seconds(str(need(play, "timeInPeriod")))
    code = opt(play, "situationCode")
    situation = parse_situation(str(code)) if code is not None else None
    d = opt(play, "details", {}) or {}

    owner = d.get("eventOwnerTeamId")
    team_id: int | None = int(owner) if owner is not None else None
    if kind == config.EV_BLOCK and team_id is not None:
        # eventOwnerTeamId on blocked shots is the blocking team (hockeyR swaps it).
        team_id = header.away_id if team_id == header.home_id else header.home_id
    team_is_home = None if team_id is None else team_id == header.home_id

    ev = Event(
        event_id=int(need(play, "eventId")),
        kind=kind,
        period=period,
        t=t,
        situation=situation,
        team_id=team_id,
        team_is_home=team_is_home,
        shot_type=d.get("shotType"),
        home_score=d.get("homeScore"),
        away_score=d.get("awayScore"),
    )
    if kind in config.ALL_SHOT_EVENTS:
        ev.player1 = d.get("scoringPlayerId") if kind == config.EV_GOAL else d.get("shootingPlayerId")
        ev.player2 = d.get("assist1PlayerId") if kind == config.EV_GOAL else d.get("blockingPlayerId")
        ev.player3 = d.get("assist2PlayerId")
        ev.goalie = d.get("goalieInNetId")
        if "xCoord" in d and "yCoord" in d and team_is_home is not None:
            ev.x, ev.y = normalize_xy(float(d["xCoord"]), float(d["yCoord"]), team_is_home,
                                      opt(play, "homeTeamDefendingSide"))
    elif kind == config.EV_FACEOFF:
        ev.player1, ev.player2 = d.get("winningPlayerId"), d.get("losingPlayerId")
        ev.extra["zone"] = d.get("zoneCode")
    elif kind == config.EV_PENALTY:
        ev.player1, ev.player2 = d.get("committedByPlayerId"), d.get("drawnByPlayerId")
        ev.penalty_type = d.get("typeCode")          # MIN / MAJ / BEN (hockeyR)
        dur = d.get("duration")
        ev.penalty_minutes = int(dur) if dur is not None else None
        ev.extra["desc"] = d.get("descKey")
    return ev


def iter_with_situation(events: Iterable[Event]) -> Iterable[Event]:
    """Yield only events that carry a situation code."""
    return (e for e in events if e.situation is not None)
