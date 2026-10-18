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
from datetime import date
from pathlib import Path
from typing import Any, Iterable

from . import config, ratings, scenarios
from .nhl_client import FetchError, NhlClient, SchemaError, need
from .parse import ParseError, parse_events, parse_header, parse_roster
from .segments import build_segments

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

    if missing:
        print("PROBE FAILED:\n  " + "\n  ".join(missing), file=sys.stderr)
        return 1
    print("probe OK: all key paths present")
    return 0


def _game_ids(client: NhlClient, seasons: Iterable[str], types: Iterable[int]) -> list[int]:
    """All game ids for the given seasons/types, excluding never-played games.

    Playoff brackets pre-allocate up to 7 game ids per series; games beyond
    the series' actual length appear in this listing with gameStateId ==
    GAME_STATE_NOT_PLAYED. That mapping is an inference from observed data,
    not a published enum, so a missing gameStateId is treated as "can't
    tell" and kept rather than silently dropped.
    """
    ids: set[int] = set()
    for season in seasons:
        for gt in types:
            for row in need(client.games_for_season(season, gt), "data"):
                state = row.get("gameStateId")
                if state == config.GAME_STATE_NOT_PLAYED:
                    continue
                ids.add(int(need(row, "id")))
    return sorted(ids)


def cmd_ingest(client: NhlClient, conn: sqlite3.Connection, seasons: list[str], types: list[int]) -> int:
    failures: list[str] = []
    game_ids = _game_ids(client, seasons, types)
    print(f"{len(game_ids)} games to ingest")
    for n, gid in enumerate(game_ids, 1):
        try:
            pbp = client.pbp(gid)
            header = parse_header(pbp)
            roster = parse_roster(pbp)
            segs = build_segments(header, parse_events(pbp, header))
            has_shifts = 1
            try:
                scenarios.parse_shifts(client.shifts(gid))
            except (FetchError, SchemaError, ParseError):
                has_shifts = 0
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
        except Exception as exc:  # noqa: BLE001 - one bad game must not abort an 11-season run;
            # always recorded with type+message below, never swallowed silently.
            failures.append(f"{gid}: {type(exc).__name__}: {exc}")
        if n % 250 == 0:
            print(f"  {n}/{len(game_ids)} games, {len(failures)} failures")
    _report_failures(failures, "ingest")
    return 0 if not failures else 2


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


def cmd_schedule(conn: sqlite3.Connection, start: date) -> int:
    curated = [sid for (sid,) in conn.execute("SELECT scenario_id FROM scenarios WHERE kind='curated' ORDER BY scenario_id")]
    segs = [json.loads(r[0]) for r in conn.execute(
        "SELECT payload_json FROM pp_segments s JOIN games g USING(game_id) WHERE g.has_shifts = 1")]
    mined = scenarios.mine(segs)
    with conn:
        for s in mined:
            sid = scenarios.segment_id(s)
            conn.execute("INSERT OR IGNORE INTO scenarios VALUES (?,?,?,?)",
                         (sid, "mined", scenarios.drama_score(s), json.dumps(s)))
        conn.execute("DELETE FROM daily_schedule")
        conn.executemany("INSERT INTO daily_schedule VALUES (?,?)",
                         [(d["date"], d["scenario_id"]) for d in
                          scenarios.daily_schedule(curated, [scenarios.segment_id(s) for s in mined], start)])
    print(f"schedule: {len(curated)} curated + {len(mined)} mined from {start.isoformat()}")
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
    (out / "scenarios").mkdir(exist_ok=True)
    for sid, payload in conn.execute("SELECT scenario_id, payload_json FROM scenarios"):
        (out / "scenarios" / f"{sid}.json").write_text(payload, encoding="utf-8")
    print(f"exported to {out}")
    return 0


def _report_failures(failures: list[str], stage: str) -> None:
    if failures:
        log = config.ROOT / "data" / f"{stage}_failures.log"
        log.write_text("\n".join(failures), encoding="utf-8")
        print(f"{len(failures)} {stage} failures written to {log}", file=sys.stderr)


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
    conn = connect()
    try:
        if a.cmd in ("ingest", "all"):
            seasons = list(config.SEASONS) if a.seasons == "all" else a.seasons.split(",")
            bad = [x for x in seasons if x not in config.SEASONS]
            if bad:
                ap.error(f"unknown seasons {bad}; allowed {config.SEASONS}")
            rc = cmd_ingest(client, conn, seasons, [int(t) for t in a.types.split(",")])
            if a.cmd == "ingest":
                return rc
            # rc 2 = some games failed (logged); later stages still run on what succeeded.
            results = [rc, cmd_ratings(conn), cmd_curate(client, conn),
                       cmd_schedule(conn, date.fromisoformat(a.start)), cmd_export(conn)]
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
            return cmd_schedule(conn, date.fromisoformat(a.start))
        if a.cmd == "export":
            return cmd_export(conn)
    finally:
        conn.close()
    return 1


if __name__ == "__main__":
    sys.exit(main())
