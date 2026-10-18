"""Full scenario shape (penalties, goalie_pulled, bench), validation, cache-only mining, export cleanup.

Run from data-pipeline/:  python -m unittest discover -s pipeline/tests -t .

All data SYNTHETIC; every DB, cache, log and export lives in a temp dir and
config.ROOT is patched wherever a stage could write a failures log.
"""
from __future__ import annotations

import contextlib
import gzip
import io
import json
import sqlite3
import tempfile
import unittest
import urllib.error
from datetime import date
from pathlib import Path
from unittest.mock import patch

from pipeline import build, config, scenarios
from pipeline.nhl_client import FetchError, NhlClient
from pipeline.parse import parse_events, parse_header, parse_roster
from pipeline.segments import PpSegment, build_segments
from pipeline.tests.test_pipeline import AWAY, HOME, FakeClient, play, synthetic_game


def _seg(**over) -> PpSegment:
    base = dict(game_id=2023030111, game_type=3, date="2024-04-20", pp_team_id=HOME, pk_team_id=AWAY,
                pp_is_home=True, period=1, start_t=305, end_t=360, strength="5v4", pp_score=0, pk_score=0,
                pp_remaining_s=115, penalty_event_id=2, penalised_player_id=202,
                penalties=[{"side": "pk", "player_id": 202, "kind": "minor", "remaining_s": 115, "queued": False}])
    base.update(over)
    return PpSegment(**base)


def _roster():
    pbp = synthetic_game()
    r = parse_roster(pbp)
    # bench candidates for HOME with mixed sweater numbers (one unknown)
    r[106] = {"team_id": HOME, "first": "F", "last": "Bench9", "number": 9, "pos": "C"}
    r[107] = {"team_id": HOME, "first": "F", "last": "Bench2", "number": 2, "pos": "D"}
    r[108] = {"team_id": HOME, "first": "F", "last": "Nonum", "number": None, "pos": "L"}
    r[109] = {"team_id": HOME, "first": "F", "last": "Backup", "number": 30, "pos": "G"}
    r[110] = {"team_id": HOME, "first": "F", "last": "Boxed", "number": 4, "pos": "R"}
    return pbp, r


def _shifts():
    return scenarios.parse_shifts(FakeClient(synthetic_game(), "x").shifts(1))


class TestScenarioFromSegment(unittest.TestCase):
    def setUp(self):
        self.pbp, self.roster = _roster()
        self.header = parse_header(self.pbp)

    def build(self, **over):
        return scenarios.scenario_from_segment(_seg(**over), self.header, self.roster, _shifts(), "sid-1")

    def test_happy_path_full_shape(self):
        scen = self.build()
        self.assertEqual(sorted(scen), ["game", "id", "narrative", "pk", "pp", "real_outcome", "seed", "state"])
        self.assertEqual(scen["state"]["penalties"][0]["kind"], "minor")
        self.assertFalse(scen["state"]["goalie_pulled"])
        self.assertEqual(scen["seed"], scenarios.stable_seed("sid-1"))
        self.assertEqual(scen["narrative"], {})

    def test_bench_sorted_by_sweater_number_unknown_last(self):
        bench = self.build()["pp"]["bench"]
        self.assertEqual([p["id"] for p in bench], [107, 110, 106, 108])

    def test_bench_excludes_goalies_on_ice_and_other_team(self):
        ids = {p["id"] for p in self.build()["pp"]["bench"]}
        self.assertNotIn(109, ids)                         # goalie
        self.assertTrue(ids.isdisjoint({101, 102, 103}))   # on ice
        self.assertNotIn(201, ids)                         # PK team

    def test_bench_excludes_pp_player_in_the_box(self):
        pens = [{"side": "pp", "player_id": 110, "kind": "minor", "remaining_s": 50, "queued": False}]
        self.assertNotIn(110, {p["id"] for p in self.build(penalties=pens)["pp"]["bench"]})

    def test_bench_empty_without_roster(self):
        scen = scenarios.scenario_from_segment(_seg(), self.header, {}, _shifts(), "sid-2")
        self.assertEqual(scen["pp"]["bench"], [])

    def test_pk_has_no_bench_key(self):
        self.assertNotIn("bench", self.build()["pk"])

    def test_goalie_pulled_flag_copied(self):
        self.assertTrue(self.build(goalie_pulled=True, strength="6v4")["state"]["goalie_pulled"])

    def test_on_ice_uses_restart_time(self):
        early = self.build(start_t=290, restart_t=300)
        self.assertEqual(len(early["pp"]["skaters"]), 5)   # shifts start 04:50 = 290; restart 300 inside
        late = self.build(start_t=290, restart_t=None)
        self.assertEqual(len(late["pp"]["skaters"]), 5)

    def test_penalties_are_copies(self):
        seg = _seg()
        scen = scenarios.scenario_from_segment(seg, self.header, self.roster, _shifts(), "sid-3")
        scen["state"]["penalties"][0]["remaining_s"] = 0
        self.assertEqual(seg.penalties[0]["remaining_s"], 115)


class TestValidateScenario(unittest.TestCase):
    def setUp(self):
        pbp, self.roster = _roster()
        self.header = parse_header(pbp)

    def scen(self, shifts="default", **over):
        sh = _shifts() if shifts == "default" else shifts
        return scenarios.scenario_from_segment(_seg(**over), self.header, self.roster, sh, "sid-v")

    def test_happy_path_5v4(self):
        scenarios.validate_scenario(self.scen())

    def test_pk_count_mismatch(self):
        with self.assertRaises(scenarios.ScenarioInvalid) as cm:
            scenarios.validate_scenario(self.scen(strength="5v3"))
        self.assertIn("5v4", str(cm.exception))  # reports what the shifts show

    def test_pp_count_mismatch(self):
        with self.assertRaises(scenarios.ScenarioInvalid):
            scenarios.validate_scenario(self.scen(strength="4v4"))

    def test_goalie_pulled_needs_six_skaters(self):
        with self.assertRaises(scenarios.ScenarioInvalid) as cm:
            scenarios.validate_scenario(self.scen(strength="6v4", goalie_pulled=True))
        self.assertIn("goalie pulled", str(cm.exception))

    def test_no_shifts(self):
        with self.assertRaises(scenarios.ScenarioInvalid) as cm:
            scenarios.validate_scenario(self.scen(shifts=None))
        self.assertIn("no shift data", str(cm.exception))

    def test_unreadable_strength(self):
        for bad in ("", "5-4", "fivevfour", None):
            with self.subTest(bad=bad), self.assertRaises(scenarios.ScenarioInvalid):
                scenarios.validate_scenario(self.scen(strength=bad))

    def test_curated_mismatch_is_a_curate_failure(self):
        class ThinShifts(FakeClient):
            def shifts(self, game_id):  # only 3 PK skaters on ice at the 5v4 start
                raw = super().shifts(game_id)
                raw["data"] = [r for r in raw["data"] if r["playerId"] != 204]
                return raw
        moment = {"id": "thin-moment", "date": "2024-04-20", "teams": ["HOM", "AWY"], "pp_team": "HOM",
                  "period": 1, "goal_time": "06:00", "penalty_time": "05:00", "scorer_last": "Sniper",
                  "score_before": {"pp": 0, "pk": 0}, "real_outcome": "goal"}
        with self.assertRaises(scenarios.CurationMismatch) as cm:
            scenarios.resolve_curated(moment, ThinShifts(synthetic_game(), "2024-04-20"))
        self.assertIn("5v3", str(cm.exception))
        self.assertIn("not exported", str(cm.exception))


# ---------------------------------------------------------------------------
# Cache-only client
# ---------------------------------------------------------------------------
def _write_cache(cache_dir: Path, url: str, body) -> None:
    c = NhlClient(cache_dir=cache_dir)
    path = c._cache_path(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump({"url": url, "body": body}, fh)


class TestCacheOnly(unittest.TestCase):
    def _never(self, *a, **k):
        raise AssertionError("cache_only must never open a connection")

    def test_reads_cache(self):
        with tempfile.TemporaryDirectory() as d:
            _write_cache(Path(d), "https://x/a", {"ok": 1})
            self.assertEqual(NhlClient(cache_dir=Path(d), cache_only=True, opener=self._never).get_json("https://x/a"),
                             {"ok": 1})

    def test_miss_raises_fetch_error_without_network(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(FetchError) as cm:
                NhlClient(cache_dir=Path(d), cache_only=True, opener=self._never).get_json("https://x/none")
            self.assertIn("cache-only", str(cm.exception))

    def test_default_still_fetches(self):
        calls = []

        def opener(req, timeout):
            calls.append(1)
            raise urllib.error.HTTPError(req.full_url, 404, "nope", None, None)
        with tempfile.TemporaryDirectory() as d, self.assertRaises(FetchError):
            NhlClient(cache_dir=Path(d), min_interval_s=0, sleep=lambda s: None, opener=opener).get_json("https://x/b")
        self.assertEqual(calls, [1])

    def test_offline_message_unchanged(self):
        with tempfile.TemporaryDirectory() as d, self.assertRaises(FetchError) as cm:
            NhlClient(cache_dir=Path(d), offline=True).get_json("https://x/none")
        self.assertIn("offline", str(cm.exception))

    def test_corrupt_cache_still_raises(self):
        with tempfile.TemporaryDirectory() as d:
            c = NhlClient(cache_dir=Path(d), cache_only=True)
            path = c._cache_path("https://x/bad")
            path.parent.mkdir(parents=True)
            path.write_bytes(b"not gzip")
            with self.assertRaises(FetchError):
                c.get_json("https://x/bad")

    def test_schedule_forces_cache_only(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            conn = build.connect(d / "t.db")
            client = NhlClient(cache_dir=d / "cache", opener=self._never)  # NOT cache_only itself
            try:
                with conn:
                    conn.execute("INSERT INTO games VALUES (?,?,?,?,?,?,?,?,?)",
                                 (2023030111, "20232024", 3, "2024-04-20", HOME, AWAY, "HOM", "AWY", 1))
                    conn.execute("INSERT INTO pp_segments VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                 ("2023030111-p1-0305", 2023030111, HOME, AWAY, 1, 305, 360, "5v4", 0, 0, 115,
                                  "goal", None, None, None, None, 1.0,
                                  json.dumps({**_seg().to_dict(), "outcome": "goal"})))
                with patch.object(config, "ROOT", d), contextlib.redirect_stdout(io.StringIO()), \
                        contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(build.cmd_schedule(conn, date(2026, 11, 1), client), 0)
                log = (d / "data" / "schedule_failures.log").read_text(encoding="utf-8")
                self.assertIn("cache_miss", log)
            finally:
                conn.close()


# ---------------------------------------------------------------------------
# build_mined / cmd_schedule / cmd_export
# ---------------------------------------------------------------------------
GAME = 2023030111


def _fixture_db(d: Path, shifts=None, pbp=None, with_cache=True):
    """Temp DB + cache for the synthetic game, ingested with the real cmd_ingest."""
    pbp = pbp or synthetic_game(game_id=GAME)
    fake = FakeClient(pbp, "2024-04-20")
    cache = d / "cache"
    _write_cache(cache, config.STATS_BASE + config.GAMES_BY_SEASON_PATH.format(season="20232024", game_type=3),
                 {"data": [{"id": GAME, "gameStateId": 7}]})
    _write_cache(cache, config.WEB_BASE + config.PBP_PATH.format(game_id=GAME), pbp)
    _write_cache(cache, config.STATS_BASE + config.SHIFTS_PATH.format(game_id=GAME),
                 shifts if shifts is not None else fake.shifts(GAME))
    client = NhlClient(cache_dir=cache, offline=True)
    conn = build.connect(d / "t.db")
    (d / "data").mkdir(exist_ok=True)
    with patch.object(config, "ROOT", d), contextlib.redirect_stdout(io.StringIO()):
        build.cmd_ingest(client, conn, ["20232024"], [3])
    return conn, client


class _DictReader:
    """Minimal reader: pbp/shifts from dicts, FetchError on anything else."""

    def __init__(self, pbps, shifts):
        self.pbps, self.shifts_by = pbps, shifts

    def pbp(self, gid):
        if gid not in self.pbps:
            raise FetchError(f"no cache for {gid}")
        return self.pbps[gid]

    def shifts(self, gid):
        return self.shifts_by[gid]


class TestBuildMined(unittest.TestCase):
    def test_happy_path_full_shape_and_order(self):
        with tempfile.TemporaryDirectory() as d:
            conn, client = _fixture_db(Path(d))
            try:
                built, excluded = build.build_mined(conn, client)
                self.assertEqual(len(built), 1)  # only the P1 PP has shifts covering its start
                scen = built[0]
                self.assertEqual(scen["id"], f"{GAME}-p1-0305")
                self.assertEqual(scen["state"]["strength"], "5v4")
                self.assertEqual(scen["state"]["pp_remaining_s"], 115)
                self.assertEqual(scen["state"]["penalties"],
                                 [{"side": "pk", "player_id": 202, "kind": "minor", "remaining_s": 115,
                                   "queued": False}])
                self.assertFalse(scen["state"]["goalie_pulled"])
                self.assertIn("bench", scen["pp"])
                self.assertIn("drama", scen)
                self.assertTrue(all(r in build.EXCLUDE_REASONS for _, r, _ in excluded))
                self.assertIn("invalid", {r for _, r, _ in excluded})   # P2/P3 PPs: nobody on ice per shifts
            finally:
                conn.close()

    def test_cache_miss_is_excluded_not_raised(self):
        with tempfile.TemporaryDirectory() as d:
            conn, _ = _fixture_db(Path(d))
            try:
                built, excluded = build.build_mined(conn, _DictReader({}, {}))
                self.assertEqual(built, [])
                self.assertTrue(excluded and all(r == "cache_miss" for _, r, _ in excluded))
            finally:
                conn.close()

    def test_parse_error_is_excluded(self):
        with tempfile.TemporaryDirectory() as d:
            conn, _ = _fixture_db(Path(d))
            bad = synthetic_game(game_id=GAME)
            bad["plays"][1]["details"]["typeCode"] = "ZZZ"   # unknown penalty code -> PenaltyError
            try:
                built, excluded = build.build_mined(conn, _DictReader({GAME: bad}, {GAME: {"data": []}}))
                self.assertEqual(built, [])
                self.assertEqual({r for _, r, _ in excluded}, {"parse_error"})
                self.assertIn("ZZZ", excluded[0][2])
            finally:
                conn.close()

    def test_segment_not_rebuilt(self):
        with tempfile.TemporaryDirectory() as d:
            conn, _ = _fixture_db(Path(d))
            changed = synthetic_game(game_id=GAME)
            changed["plays"][2]["timeInPeriod"] = "05:07"  # opener moves: id 0305 no longer produced
            changed["plays"][1]["timeInPeriod"] = "05:07"
            shifts = FakeClient(changed, "x").shifts(GAME)
            try:
                _, excluded = build.build_mined(conn, _DictReader({GAME: changed}, {GAME: shifts}))
                self.assertIn((f"{GAME}-p1-0305", "segment_not_rebuilt"), {(s, r) for s, r, _ in excluded})
            finally:
                conn.close()

    def test_not_playable_after_rebuild(self):
        with tempfile.TemporaryDirectory() as d:
            conn, _ = _fixture_db(Path(d))
            changed = synthetic_game(game_id=GAME)
            changed["plays"][1]["details"]["typeCode"] = "MIS"   # misconduct: no man down, no advantage
            changed["plays"][1]["details"]["duration"] = 10
            try:
                _, excluded = build.build_mined(conn, _DictReader({GAME: changed}, {GAME: FakeClient(changed, "x").shifts(GAME)}))
                self.assertIn((f"{GAME}-p1-0305", "not_playable"), {(s, r) for s, r, _ in excluded})
            finally:
                conn.close()

    def test_limit_respected(self):
        with tempfile.TemporaryDirectory() as d:
            conn, client = _fixture_db(Path(d))
            try:
                built, _ = build.build_mined(conn, client, limit=0)
                self.assertEqual(built, [])
            finally:
                conn.close()

    def test_empty_db(self):
        with tempfile.TemporaryDirectory() as d:
            conn = build.connect(Path(d) / "t.db")
            try:
                self.assertEqual(build.build_mined(conn, _DictReader({}, {})), ([], []))
            finally:
                conn.close()


class TestScheduleAndExport(unittest.TestCase):
    def test_end_to_end_full_shape_exported(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            conn, client = _fixture_db(d)
            out = d / "export"
            (out / "scenarios").mkdir(parents=True)
            (out / "scenarios" / "stale-old-id.json").write_text("{}", encoding="utf-8")
            (out / "scenarios" / "keep.txt").write_text("x", encoding="utf-8")
            (out / "scenarios" / "sub").mkdir()
            (out / "scenarios" / "sub" / "deep.json").write_text("{}", encoding="utf-8")
            try:
                buf = io.StringIO()
                with patch.object(config, "ROOT", d), contextlib.redirect_stdout(buf), \
                        contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(build.cmd_ratings(conn), 0)
                    self.assertEqual(build.cmd_schedule(conn, date(2026, 11, 1), client), 0)
                    # second run: daily_schedule rows reference mined scenarios (FOREIGN KEY)
                    self.assertEqual(build.cmd_schedule(conn, date(2026, 11, 1), client), 0)
                    self.assertEqual(build.cmd_export(conn, out), 0)
                self.assertIn("removed 1 stale scenario file(s)", buf.getvalue())
                self.assertIn("excluded (invalid", buf.getvalue())
                index = json.loads((out / "endless_index.json").read_text())
                self.assertEqual(index, [f"{GAME}-p1-0305"])
                scen = json.loads((out / "scenarios" / f"{GAME}-p1-0305.json").read_text())
                for key in ("id", "seed", "game", "state", "pp", "pk", "real_outcome", "narrative"):
                    self.assertIn(key, scen)
                for key in ("penalties", "goalie_pulled", "pp_remaining_s", "strength"):
                    self.assertIn(key, scen["state"])
                self.assertIn("bench", scen["pp"])
                self.assertNotIn("drama", scen)
                self.assertFalse((out / "scenarios" / "stale-old-id.json").exists())
                self.assertTrue((out / "scenarios" / "keep.txt").exists())
                self.assertTrue((out / "scenarios" / "sub" / "deep.json").exists())
                self.assertTrue((d / "data" / "schedule_failures.log").read_text(encoding="utf-8"))
            finally:
                conn.close()


class TestRemoveStaleScenarios(unittest.TestCase):
    def _dir(self, d, names):
        sd = Path(d) / "scenarios"
        sd.mkdir()
        for n in names:
            (sd / n).write_text("{}", encoding="utf-8")
        return sd

    def test_happy_path(self):
        with tempfile.TemporaryDirectory() as d:
            sd = self._dir(d, ["a.json", "b.json"])
            self.assertEqual(build._remove_stale_scenarios(sd, {"a"}), 1)
            self.assertEqual(sorted(p.name for p in sd.iterdir()), ["a.json"])

    def test_nothing_stale(self):
        with tempfile.TemporaryDirectory() as d:
            sd = self._dir(d, ["a.json"])
            self.assertEqual(build._remove_stale_scenarios(sd, {"a"}), 0)

    def test_empty_dir(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(build._remove_stale_scenarios(self._dir(d, []), set()), 0)

    def test_non_json_kept(self):
        with tempfile.TemporaryDirectory() as d:
            sd = self._dir(d, ["notes.txt", "x.json.bak"])
            self.assertEqual(build._remove_stale_scenarios(sd, set()), 0)

    def test_subdirectory_named_json_kept(self):
        with tempfile.TemporaryDirectory() as d:
            sd = self._dir(d, [])
            (sd / "dir.json").mkdir()
            self.assertEqual(build._remove_stale_scenarios(sd, set()), 0)
            self.assertTrue((sd / "dir.json").is_dir())

    def test_files_outside_untouched(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "outside.json").write_text("{}", encoding="utf-8")
            sd = self._dir(d, ["x.json"])
            self.assertEqual(build._remove_stale_scenarios(sd, set()), 1)
            self.assertTrue((Path(d) / "outside.json").exists())


class TestReportFailures(unittest.TestCase):
    def _run(self, d, failures, stage="ingest"):
        with patch.object(config, "ROOT", Path(d)), contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            build._report_failures(failures, stage)
        return Path(d) / "data" / f"{stage}_failures.log"

    def test_writes_failures(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(self._run(d, ["a", "b"]).read_text(encoding="utf-8"), "a\nb")

    def test_zero_failures_truncates_stale_log(self):
        with tempfile.TemporaryDirectory() as d:
            self._run(d, ["9001: old"])
            self.assertEqual(self._run(d, []).read_text(encoding="utf-8"), "")

    def test_zero_failures_creates_nothing(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertFalse(self._run(d, []).exists())

    def test_creates_data_dir(self):
        with tempfile.TemporaryDirectory() as d:
            self.assertTrue(self._run(d, ["x"]).exists())

    def test_stages_are_separate(self):
        with tempfile.TemporaryDirectory() as d:
            self._run(d, ["c"], stage="curate")
            self._run(d, [], stage="ingest")
            self.assertEqual((Path(d) / "data" / "curate_failures.log").read_text(encoding="utf-8"), "c")

    def test_overwrites_previous(self):
        with tempfile.TemporaryDirectory() as d:
            self._run(d, ["old"])
            self.assertEqual(self._run(d, ["new"]).read_text(encoding="utf-8"), "new")


class TestIngestSummaries(unittest.TestCase):
    def test_unresolved_side_and_opener_counts_printed(self):
        pbp = synthetic_game(game_id=GAME)
        # one shot with coordinates, no side and no votes -> unresolved
        pbp["plays"].append(play(99, "shot-on-goal", 2, "15:00", "1551", side=None, eventOwnerTeamId=HOME,
                                 zoneCode="N", shootingPlayerId=102, goalieInNetId=299, xCoord=50, yCoord=0))
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            cache = d / "cache"
            _write_cache(cache, config.STATS_BASE + config.GAMES_BY_SEASON_PATH.format(season="20232024", game_type=3),
                         {"data": [{"id": GAME}]})
            _write_cache(cache, config.WEB_BASE + config.PBP_PATH.format(game_id=GAME), pbp)
            _write_cache(cache, config.STATS_BASE + config.SHIFTS_PATH.format(game_id=GAME), {"data": []})
            conn = build.connect(d / "t.db")
            buf = io.StringIO()
            try:
                with patch.object(config, "ROOT", d), contextlib.redirect_stdout(buf):
                    build.cmd_ingest(NhlClient(cache_dir=cache, offline=True), conn, ["20232024"], [3])
            finally:
                conn.close()
            self.assertIn("1 event(s) in 1 game(s) had no resolvable homeTeamDefendingSide", buf.getvalue())

    def test_served_by_parsed(self):
        pbp = synthetic_game()
        pbp["plays"].append(play(98, "penalty", 2, "15:00", "1551", eventOwnerTeamId=AWAY, servedByPlayerId=77,
                                 typeCode="BEN", duration=2))
        ev = parse_events(pbp, parse_header(pbp))[-1]
        self.assertEqual(ev.extra["served_by"], 77)

    def test_segments_carry_new_fields(self):
        pbp = synthetic_game()
        h = parse_header(pbp)
        s = build_segments(h, parse_events(pbp, h))[0]
        self.assertEqual((s.strength_source, s.restart_t, s.goalie_pulled), ("faceoff", 305, False))
        self.assertEqual(s.penalties[0]["kind"], "minor")


if __name__ == "__main__":
    unittest.main()
