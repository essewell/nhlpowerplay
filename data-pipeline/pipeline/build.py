"""PowerPlay data pipeline CLI.

Run from the repo root (`powerplay-data/`):

    python -m pipeline.build probe --game-id 2023020204 --date 2023-11-10
    python -m pipeline.build ingest --seasons all --types 2,3
    python -m pipeline.build ratings
    python -m pipeline.build curate
    python -m pipeline.build schedule --start 2026-11-01
    python -m pipeline.build export
    python -m pipeline.build all --seasons all --types 3 --start 2026-11-01   # every stage after probe

`all` is resumable: rerun it after an interruption and cached responses are reused.

`probe` must pass before `ingest`: it checks every response key path the
pipeline relies on against live data and exits non-zero on any miss.

Single-threaded by design (one NhlClient, one SQLite connection).
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import sys
from collections import Counter
from dataclasses import dataclass, replace
from datetime import date
from pathlib import Path
from typing import Any, Iterable

from . import config, ratings, scenarios
from .nhl_client import FetchError, NhlClient, SchemaError, need
from .parse import ParseError, parse_events, parse_header, parse_roster
from .segments import STRENGTH_FROM_OPENER, build_segments

ROOT = config.ROOT
CURATED_PATH = ROOT / "data" / "curated_moments.json"
SCHEMA_PATH = ROOT / "db" / "schema.sql"

PROBE_PATHS = {
    "pbp": ["id", "gameDate", "gameType", "homeTeam.id", "homeTeam.abbrev", "awayTeam.id",
            "awayTeam.abbrev", "plays[0].eventId", "plays[0].typeDescKey",
            "plays[0].periodDescriptor.number", "plays[0].timeInPeriod", "rosterSpots[0].playerId",
            "rosterSpots[0].teamId", "rosterSpots[0].positionCode", "rosterSpots[0].lastName.default"],
    "shifts": ["data[0].playerId", "data[0].teamId", "data[0].period", "data[0].startTime",
               "data[0].endTime"],
    "score": ["games[0].id", "games[0].homeTeam.abbrev", "games[0].awayTeam.abbrev"],
    "games": ["data[0].id", "data[0].gameStateId"],
}


def connect(db_path: Path = config.DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))
    return conn


# ---------------------------------------------------------------------------
def cmd_probe(client: NhlClient, game_id: int, on_date: str) -> int:
    responses = {
        "pbp": client.pbp(game_id),
        "shifts": client.shifts(game_id),
        "score": client.score_by_date(on_date),
        "games": client.games_for_season(config.SEASONS[-1], config.GAME_TYPE_PLAYOFF),
    }
    missing = []
    for name, paths in PROBE_PATHS.items():
        for p in paths:
            try:
                need(responses[name], p)
            except SchemaError as exc:
                missing.append(f"{name}: {exc}")
    # Every play must parse; surfaces new typeDescKey/situationCode shapes early.
    try:
        header = parse_header(responses["pbp"])
        events = parse_events(responses["pbp"], header)
        segs = build_segments(header, events)
        print(f"parsed {len(events)} events, {len(segs)} PP segments in game {game_id}")
        unresolved = sum(1 for e in events if e.side_unresolved)
        if unresolved:
            print(f"  {unresolved} event(s) had no resolvable homeTeamDefendingSide; x/y left null")
    except (SchemaError, ParseError) as exc:
        missing.append(f"parse: {exc}")

    # Always also probe a known old-era game (pre-2019-20 PBP mostly lacks
    # homeTeamDefendingSide and this run's --game-id may not), so the legacy
    # code paths get exercised on every probe run, not only when asked for.
    if game_id != config.PROBE_LEGACY_GAME_ID:
        try:
            legacy_pbp = client.pbp(config.PROBE_LEGACY_GAME_ID)
            legacy_header = parse_header(legacy_pbp)
            legacy_events = parse_events(legacy_pbp, legacy_header)
            legacy_segs = build_segments(legacy_header, legacy_events)
            print(f"parsed {len(legacy_events)} events, {len(legacy_segs)} PP segments "
                  f"in legacy game {config.PROBE_LEGACY_GAME_ID}")
        except (FetchError, SchemaError, ParseError) as exc:
            missing.append(f"legacy-game {config.PROBE_LEGACY_GAME_ID}: {exc}")

    # Early-era playoff games at the start of the playoff scope: report field
    # coverage (shifts, situationCode, coordinates, defending side) every run.
    for era_gid, era_date in config.PROBE_ERA_GAMES:
        if era_gid != game_id:
            missing.extend(_probe_era_game(client, era_gid, era_date))

    if missing:
        print("PROBE FAILED:\n  " + "\n  ".join(missing), file=sys.stderr)
        return 1
    print("probe OK: all key paths present")
    return 0


def probe_key_report(responses: dict[str, Any], names: Iterable[str] | None = None) -> dict[str, dict[str, bool]]:
    """{response name: {PROBE_PATHS key path: present?}} for the named responses.

    Raises KeyError for a name that is not in PROBE_PATHS or not in responses.
    O(total length of the checked paths).
    """
    report: dict[str, dict[str, bool]] = {}
    for name in (list(PROBE_PATHS) if names is None else list(names)):
        paths = PROBE_PATHS[name]
        body = responses[name]
        report[name] = {}
        for p in paths:
            try:
                need(body, p)
                report[name][p] = True
            except SchemaError:
                report[name][p] = False
    return report


def era_coverage(pbp: dict[str, Any], shifts_raw: Any) -> dict[str, int]:
    """Counts of the fields older seasons may lack. O(P + S) over P plays, S shift rows.

    shift_rows counts rows that parse into real shifts (goal rows carry no
    times), so an empty or goal-only chart reports 0, matching ingest's has_shifts.
    Raises SchemaError if pbp has no plays list or the shift chart has no data list.
    """
    plays = need(pbp, "plays")
    return {
        "plays": len(plays),
        "with_situation_code": sum(1 for p in plays if p.get("situationCode") is not None),
        "with_coordinates": sum(1 for p in plays if isinstance(p.get("details"), dict)
                                and "xCoord" in p["details"] and "yCoord" in p["details"]),
        "with_home_defending_side": sum(1 for p in plays if p.get("homeTeamDefendingSide") is not None),
        "shift_rows": len(scenarios.parse_shifts(shifts_raw)),
    }


def _probe_era_game(client: Any, game_id: int, on_date: str) -> list[str]:
    """Probe one early-era game; return failure lines (empty when fine).

    Fails on: a fetch error, a missing pbp key path, a parse error, or the game
    not being listed by score-by-date on on_date (wrong id/date pairing).
    Missing shift-chart paths are reported as coverage, not failures: games
    without shifts are kept for ratings and excluded from the mined pool.
    """
    label = f"era-game {game_id}"
    try:
        pbp = client.pbp(game_id)
        shifts_raw = client.shifts(game_id)
        listed = {int(need(g, "id")) for g in need(client.score_by_date(on_date), "games")}
    except (FetchError, SchemaError) as exc:
        return [f"{label}: {exc}"]
    failures: list[str] = []
    if game_id not in listed:
        failures.append(f"{label}: not listed by score-by-date on {on_date}")
    for name, paths in probe_key_report({"pbp": pbp, "shifts": shifts_raw}, names=("pbp", "shifts")).items():
        for p, present in paths.items():
            print(f"  {label} {name}: {p}: {'present' if present else 'ABSENT'}")
            if name == "pbp" and not present:
                failures.append(f"{label} pbp: missing '{p}'")
    try:
        header = parse_header(pbp)
        events = parse_events(pbp, header)
        segs = build_segments(header, events)
        cov = era_coverage(pbp, shifts_raw)
    except (SchemaError, ParseError) as exc:
        return failures + [f"{label} parse: {exc}"]
    note = "" if cov["shift_rows"] else " -> NO SHIFTS: kept for ratings, excluded from the mined pool"
    print(f"parsed {len(events)} events, {len(segs)} PP segments in {label} ({header.date}); "
          + ", ".join(f"{k}={v}" for k, v in cov.items()) + note)
    return failures


def resolve_seasons(spec: str, types: list[int]) -> list[str]:
    """Turn the --seasons argument into season ids for the requested game types.

    "all" is the union of every requested type's scope (playoffs start at
    config.PLAYOFF_FIRST_SEASON_START_YEAR, regular seasons at
    config.FIRST_SEASON_START_YEAR). An explicit season must be in scope for at
    least one requested type. Raises ValueError on an unknown type, an empty
    type list, or an out-of-scope season. O(T * S).
    """
    if not types:
        raise ValueError("no game types given")
    scopes = {gt: config.seasons_for_type(gt) for gt in types}
    allowed = sorted({s for scope in scopes.values() for s in scope})
    if spec == "all":
        return allowed
    seasons = [x.strip() for x in spec.split(",") if x.strip()]
    if not seasons:
        raise ValueError("no seasons given")
    bad = [x for x in seasons if x not in allowed]
    if bad:
        raise ValueError(f"unknown seasons {bad} for types {types}; allowed {allowed}")
    return seasons


def _game_ids(client: NhlClient, seasons: Iterable[str], types: Iterable[int]) -> list[int]:
    """All game ids for the given seasons/types, excluding never-played games.

    A (season, type) pair outside that type's scope (config.seasons_for_type)
    is skipped, so `--seasons all --types 2,3` lists playoffs from 2009-10 but
    regular seasons only from 2015-16. O(G log G) over G listed games.

    Playoff brackets pre-allocate up to 7 game ids per series; games beyond
    the series' actual length appear in this listing with gameStateId ==
    GAME_STATE_NOT_PLAYED. That mapping is an inference from observed data,
    not a published enum, so a missing gameStateId is treated as "can't
    tell" and kept rather than silently dropped.
    """
    ids: set[int] = set()
    for season in seasons:
        for gt in types:
            if season not in config.seasons_for_type(gt):
                continue
            for row in need(client.games_for_season(season, gt), "data"):
                state = row.get("gameStateId")
                if state == config.GAME_STATE_NOT_PLAYED:
                    continue
                ids.add(int(need(row, "id")))
    return sorted(ids)


def cmd_ingest(client: NhlClient, conn: sqlite3.Connection, seasons: list[str], types: list[int]) -> int:
    failures: list[str] = []
    unresolved_events = unresolved_games = opener_strength = 0
    game_ids = _game_ids(client, seasons, types)
    print(f"{len(game_ids)} games to ingest")
    for n, gid in enumerate(game_ids, 1):
        try:
            pbp = client.pbp(gid)
            header = parse_header(pbp)
            roster = parse_roster(pbp)
            events = parse_events(pbp, header)
            segs = build_segments(header, events)
            has_shifts = _has_shifts(client, gid)
            game_unresolved = sum(1 for e in events if e.side_unresolved)
            opener_strength += sum(1 for x in segs if x.strength_source == STRENGTH_FROM_OPENER)
            with conn:
                conn.execute("INSERT OR REPLACE INTO games VALUES (?,?,?,?,?,?,?,?,?)",
                             (header.game_id, ratings.season_of(gid), header.game_type, header.date,
                              header.home_id, header.away_id, header.home_abbrev, header.away_abbrev, has_shifts))
                conn.executemany("INSERT OR REPLACE INTO players VALUES (?,?,?,?)",
                                 [(pid, r["first"], r["last"], r["pos"]) for pid, r in roster.items()])
                conn.execute("DELETE FROM pp_segments WHERE game_id = ?", (gid,))
                for s in segs:
                    d = s.to_dict()
                    conn.execute(
                        "INSERT INTO pp_segments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        (scenarios.segment_id(d), gid, s.pp_team_id, s.pk_team_id, s.period, s.start_t,
                         s.end_t, s.strength, s.pp_score, s.pk_score, s.pp_remaining_s, s.outcome,
                         s.scorer_id, s.assist1_id, s.assist2_id, s.goalie_id,
                         scenarios.drama_score(d), json.dumps(d)))
            if game_unresolved:
                unresolved_events += game_unresolved
                unresolved_games += 1
        except Exception as exc:  # noqa: BLE001 - one bad game must not abort an 11-season run;
            # always recorded with type+message below, never swallowed silently.
            failures.append(f"{gid}: {type(exc).__name__}: {exc}")
        if n % 250 == 0:
            print(f"  {n}/{len(game_ids)} games, {len(failures)} failures")
    if unresolved_events:
        print(f"{unresolved_events} event(s) in {unresolved_games} game(s) had no resolvable "
              f"homeTeamDefendingSide; their x/y were left null")
    if opener_strength:
        print(f"{opener_strength} PP segment(s) had no restart faceoff after the opener (PP began in live play); "
              f"their strength comes from the opening event")
    _report_failures(failures, "ingest")
    return 0 if not failures else 2


def _has_shifts(client: Any, game_id: int) -> int:
    """1 if the game's shift chart yields at least one real shift, else 0.

    An empty chart (2009-10 answers data [] / total 0), a goal-rows-only chart,
    an unfetchable chart or a malformed one all mean "no on-ice units": the
    game is still ingested for ratings/base rates but never enters the mined
    pool (scenarios.playable). The reason is printed, never swallowed. O(S).
    """
    try:
        shifts = scenarios.parse_shifts(client.shifts(game_id))
    except (FetchError, SchemaError, ParseError, ValueError) as exc:
        print(f"  game {game_id}: shift chart unusable ({type(exc).__name__}: {exc}); has_shifts=0")
        return 0
    return 1 if shifts else 0


def _segments(conn: sqlite3.Connection, season: str | None) -> list[dict[str, Any]]:
    q = "SELECT s.payload_json FROM pp_segments s JOIN games g USING(game_id)"
    rows = conn.execute(q + (" WHERE g.season = ?" if season else ""), ((season,) if season else ()))
    return [json.loads(r[0]) for r in rows]


def cmd_ratings(conn: sqlite3.Connection) -> int:
    scopes = ["all"] + [s for (s,) in conn.execute("SELECT DISTINCT season FROM games ORDER BY season")]
    for scope in scopes:
        segs = _segments(conn, None if scope == "all" else scope)
        if not segs:
            continue
        r = ratings.compute(segs)
        with conn:
            for key, v in r["base_rates"].items():
                st, b = key.split("|")
                conn.execute("INSERT OR REPLACE INTO base_rates VALUES (?,?,?,?,?,?,?,?)",
                             (scope, st, int(b), v["attempts"], v["on_net"], v["goals"], v["p_unblocked"], v["p_on_net"]))
            conn.executemany("INSERT OR REPLACE INTO shooter_ratings VALUES (?,?,?,?,?,?,?,?,?,?)",
                             [(p, scope, v["attempts"], v["on_net"], v["goals"], v["xg"], v["finishing_mult"],
                               v["accuracy"], v["rating"], int(v["low_sample"])) for p, v in r["shooters"].items()])
            conn.executemany("INSERT OR REPLACE INTO goalie_ratings VALUES (?,?,?,?,?,?,?,?)",
                             [(p, scope, v["on_net"], v["ga"], v["xga"], v["ga_mult"], v["rating"],
                               int(v["low_sample"])) for p, v in r["goalies"].items()])
            conn.executemany("INSERT OR REPLACE INTO faceoff_ratings VALUES (?,?,?,?,?)",
                             [(p, scope, v["won"], v["taken"], v["win_rate"]) for p, v in r["faceoffs"].items()])
            conn.executemany("INSERT OR REPLACE INTO playmaker_ratings VALUES (?,?,?,?,?)",
                             [(p, scope, v["a1"], v["presence"], v["playmaking_mult"])
                              for p, v in r["playmakers"].items()])
            conn.executemany("INSERT OR REPLACE INTO matchups VALUES (?,?,?,?,?,?)",
                             [(*map(int, k.split("|")), scope, v["on_net"], v["goals"], v["xg"])
                              for k, v in r["matchups"].items()])
        print(f"ratings[{scope}]: {len(r['shooters'])} shooters, {len(r['goalies'])} goalies")
    return 0


def cmd_curate(client: NhlClient, conn: sqlite3.Connection) -> int:
    moments = need(json.loads(CURATED_PATH.read_text(encoding="utf-8")), "moments")
    failures = []
    for m in moments:
        try:
            scen = scenarios.resolve_curated(m, client)
            with conn:
                conn.execute("INSERT OR REPLACE INTO scenarios VALUES (?,?,?,?)",
                             (scen["id"], "curated", 0.0, json.dumps(scen)))
            print(f"verified {m['id']}")
        except (scenarios.CurationMismatch, FetchError, SchemaError, ParseError) as exc:
            failures.append(f"{m['id']}: {exc}")
    _report_failures(failures, "curate")
    return 0 if not failures else 2


@dataclass
class _GameCache:
    header: Any
    roster: dict[int, dict[str, Any]]
    segments: dict[str, Any]          # segment_id -> PpSegment (rebuilt by the current segmenter)
    shifts: list[scenarios.Shift]


def _load_game(reader: Any, game_id: int) -> _GameCache:
    """Rebuild one game's segments + shifts from the cache. Raises FetchError/SchemaError/ParseError. O(E + S)."""
    pbp = reader.pbp(game_id)
    header = parse_header(pbp)
    segs = build_segments(header, parse_events(pbp, header))
    return _GameCache(header, parse_roster(pbp), {scenarios.segment_id(x.to_dict()): x for x in segs},
                      scenarios.parse_shifts(reader.shifts(game_id)))


EXCLUDE_REASONS = ("cache_miss", "parse_error", "segment_not_rebuilt", "not_playable", "invalid")


def build_mined(conn: sqlite3.Connection, reader: Any, limit: int = config.DAILY_POOL_SIZE
                ) -> tuple[list[dict[str, Any]], list[tuple[str, str, str]]]:
    """Mined scenarios in the full scenario shape, best drama first, plus exclusions.

    Candidates are the DB segments that pass scenarios.playable(), in drama
    order. Each is rebuilt from the cached pbp + shifts (the stored payload may
    predate the current segmenter), re-checked with playable(), turned into a
    scenario with scenario_from_segment() and validated. Any failure excludes
    that candidate as (scenario_id, reason, message), reason in EXCLUDE_REASONS,
    and the next candidate is tried until `limit` are built. Each built
    scenario carries a "drama" key for the caller to pop.
    O(N log N + G * (E + S)) for N segments and G distinct games touched.
    """
    segs = [{**json.loads(payload), "has_shifts": bool(has_shifts)} for payload, has_shifts in conn.execute(
        "SELECT s.payload_json, g.has_shifts FROM pp_segments s JOIN games g USING(game_id)")]
    ordered = scenarios.mine(segs, limit=len(segs))
    games: dict[int, Any] = {}        # game_id -> _GameCache, or the exception that loading it raised
    built: list[dict[str, Any]] = []
    excluded: list[tuple[str, str, str]] = []
    for cand in ordered:
        if len(built) >= limit:
            break
        sid = scenarios.segment_id(cand)
        gid = int(cand["game_id"])
        if gid not in games:
            try:
                games[gid] = _load_game(reader, gid)
            except (FetchError, SchemaError, ParseError) as exc:
                games[gid] = exc
        game = games[gid]
        if isinstance(game, Exception):
            reason = "cache_miss" if isinstance(game, FetchError) else "parse_error"
            excluded.append((sid, reason, f"{type(game).__name__}: {game}"))
            continue
        seg = game.segments.get(sid)
        if seg is None:
            excluded.append((sid, "segment_not_rebuilt", "the current segmenter no longer produces this segment"))
            continue
        fresh = {**seg.to_dict(), "has_shifts": cand["has_shifts"]}
        if not scenarios.playable(fresh):
            excluded.append((sid, "not_playable", f"after rebuild: pp_remaining_s={fresh['pp_remaining_s']}, "
                                                  f"start_t={fresh['start_t']}, end_t={fresh['end_t']}"))
            continue
        scen = scenarios.scenario_from_segment(seg, game.header, game.roster, game.shifts, sid)
        try:
            scenarios.validate_scenario(scen)
        except scenarios.ScenarioInvalid as exc:
            excluded.append((sid, "invalid", str(exc)))
            continue
        scen["drama"] = scenarios.drama_score(fresh)
        built.append(scen)
    return built, excluded


def cmd_schedule(conn: sqlite3.Connection, start: date, client: Any) -> int:
    """Rebuild the mined pool (full scenario shape, from the cache only) and the Daily schedule.

    An NhlClient is switched to cache_only so this stage never hits the network.
    Exclusions are logged to data/schedule_failures.log and counted by reason.
    """
    reader = replace(client, cache_only=True) if isinstance(client, NhlClient) else client
    curated = [sid for (sid,) in conn.execute("SELECT scenario_id FROM scenarios WHERE kind='curated' ORDER BY scenario_id")]
    mined, excluded = build_mined(conn, reader)
    with conn:
        # Rebuild the mined pool from scratch: otherwise scenarios mined by an
        # earlier run under looser rules (e.g. zero-length PPs) would linger in
        # the scenarios table and leak into endless_index.json. daily_schedule
        # references scenarios (FOREIGN KEY), so it is cleared first.
        conn.execute("DELETE FROM daily_schedule")
        conn.execute("DELETE FROM scenarios WHERE kind = 'mined'")
        for scen in mined:
            drama = scen.pop("drama")
            conn.execute("INSERT OR IGNORE INTO scenarios VALUES (?,?,?,?)",
                         (scen["id"], "mined", drama, json.dumps(scen)))
        conn.executemany("INSERT INTO daily_schedule VALUES (?,?)",
                         [(d["date"], d["scenario_id"]) for d in
                          scenarios.daily_schedule(curated, [x["id"] for x in mined], start)])
    by_reason = Counter(reason for _, reason, _ in excluded)
    detail = f" ({', '.join(f'{k} {v}' for k, v in sorted(by_reason.items()))})" if excluded else ""
    print(f"schedule: {len(curated)} curated + {len(mined)} mined from {start.isoformat()}; "
          f"{len(excluded)} excluded{detail}")
    _report_failures([f"{sid}: {reason}: {msg}" for sid, reason, msg in excluded], "schedule")
    return 0


def cmd_export(conn: sqlite3.Connection, out: Path = config.EXPORT_DIR) -> int:
    out.mkdir(parents=True, exist_ok=True)
    def dump(name: str, obj: Any) -> None:
        (out / name).write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    cur = conn.execute("SELECT * FROM base_rates WHERE scope='all'")
    cols = [c[0] for c in cur.description]
    dump("base_rates.json", [dict(zip(cols, r)) for r in cur])
    for table in ("shooter_ratings", "goalie_ratings", "faceoff_ratings", "playmaker_ratings"):
        cur = conn.execute(f"SELECT * FROM {table}")  # table names are constants above
        cols = [c[0] for c in cur.description]
        dump(f"{table}.json", [dict(zip(cols, r)) for r in cur])
    dump("schedule.json", [{"date": d, "scenario_id": s} for d, s in conn.execute("SELECT * FROM daily_schedule ORDER BY play_date")])
    endless = [sid for (sid,) in conn.execute("SELECT scenario_id FROM scenarios ORDER BY scenario_id")]
    dump("endless_index.json", endless)
    scen_dir = out / "scenarios"
    scen_dir.mkdir(exist_ok=True)
    for sid, payload in conn.execute("SELECT scenario_id, payload_json FROM scenarios"):
        (scen_dir / f"{sid}.json").write_text(payload, encoding="utf-8")
    removed = _remove_stale_scenarios(scen_dir, set(endless))
    print(f"exported to {out} ({len(endless)} scenarios; removed {removed} stale scenario file(s))")
    return 0


def _remove_stale_scenarios(scen_dir: Path, keep_ids: set[str]) -> int:
    """Delete <scen_dir>/*.json whose stem is not a current scenario id; return the count. O(F).

    Only regular *.json files directly inside scen_dir are touched: no
    subdirectories, no other extensions, nothing outside the folder.
    """
    removed = 0
    for f in scen_dir.glob("*.json"):
        if f.is_file() and f.parent == scen_dir and f.stem not in keep_ids:
            f.unlink()
            removed += 1
    return removed


def _report_failures(failures: list[str], stage: str) -> None:
    """Write data/<stage>_failures.log; on a zero-failure run truncate a stale one. O(F)."""
    log = config.ROOT / "data" / f"{stage}_failures.log"
    if failures:
        log.parent.mkdir(parents=True, exist_ok=True)
        log.write_text("\n".join(failures), encoding="utf-8")
        print(f"{len(failures)} {stage} failures written to {log}", file=sys.stderr)
    elif log.exists():
        log.write_text("", encoding="utf-8")  # a stale log must never read as current
        print(f"0 {stage} failures; truncated stale {log}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="pipeline.build")
    ap.add_argument("--offline", action="store_true", help="use cache only; fail on cache miss")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("probe"); p.add_argument("--game-id", type=int, required=True); p.add_argument("--date", required=True)
    i = sub.add_parser("ingest"); i.add_argument("--seasons", default="all"); i.add_argument("--types", default="2,3")
    sub.add_parser("ratings"); sub.add_parser("curate"); sub.add_parser("export")
    s = sub.add_parser("schedule"); s.add_argument("--start", required=True)
    al = sub.add_parser("all", help="ingest -> ratings -> curate -> schedule -> export")
    al.add_argument("--seasons", default="all"); al.add_argument("--types", default="2,3")
    al.add_argument("--start", required=True)
    a = ap.parse_args(argv)

    client = NhlClient(offline=a.offline)
    if a.cmd == "probe":
        return cmd_probe(client, a.game_id, a.date)
    seasons: list[str] = []
    types: list[int] = []
    if a.cmd in ("ingest", "all"):
        # Validate the scope before connect() creates or touches the DB.
        try:
            types = [int(t) for t in a.types.split(",")]
            seasons = resolve_seasons(a.seasons, types)
        except ValueError as exc:
            ap.error(str(exc))
    conn = connect()
    try:
        if a.cmd in ("ingest", "all"):
            rc = cmd_ingest(client, conn, seasons, types)
            if a.cmd == "ingest":
                return rc
            # rc 2 = some games failed (logged); later stages still run on what succeeded.
            results = [rc, cmd_ratings(conn), cmd_curate(client, conn),
                       cmd_schedule(conn, date.fromisoformat(a.start), client), cmd_export(conn)]
            status = {"stages": dict(zip(["ingest", "ratings", "curate", "schedule", "export"], results)),
                      "seasons": seasons, "types": a.types}
            (config.ROOT / "data" / "run_status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")
            print(json.dumps(status))
            return max(results)
        if a.cmd == "ratings":
            return cmd_ratings(conn)
        if a.cmd == "curate":
            return cmd_curate(client, conn)
        if a.cmd == "schedule":
            return cmd_schedule(conn, date.fromisoformat(a.start), client)
        if a.cmd == "export":
            return cmd_export(conn)
    finally:
        conn.close()
    return 1


if __name__ == "__main__":
    sys.exit(main())
