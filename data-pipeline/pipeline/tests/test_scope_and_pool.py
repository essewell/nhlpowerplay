"""Tests for the 2009-10 playoff scope, shift-less games and the playable() pool rules.

Run from data-pipeline/:  python -m unittest discover -s pipeline/tests -t .

All game data below is SYNTHETIC (shaped like the api-web / stats responses);
nothing here writes under data/: every DB and cache lives in a temp dir.
"""
from __future__ import annotations

import contextlib
import gzip
import io
import json
import tempfile
import unittest
from datetime import date
from pathlib import Path

from pipeline import build, config, ratings, scenarios
from pipeline.nhl_client import FetchError, NhlClient, SchemaError
from pipeline.tests.test_pipeline import (HOME, AWAY, FakeClient, _probe_pbp, _ProbeFakeClient, play,
                                          synthetic_game)


# ---------------------------------------------------------------------------
# Season scope
# ---------------------------------------------------------------------------
class TestSeasonScope(unittest.TestCase):
    def test_playoff_scope_starts_2009_regular_unchanged(self):
        self.assertEqual(config.PLAYOFF_FIRST_SEASON_START_YEAR, 2009)
        self.assertEqual(config.seasons_for_type(config.GAME_TYPE_PLAYOFF)[0], "20092010")
        self.assertEqual(config.seasons_for_type(config.GAME_TYPE_REGULAR)[0], "20152016")
        self.assertEqual(config.SEASONS[0], "20152016")  # regular-season scope untouched

    def test_both_scopes_end_at_the_same_last_season(self):
        self.assertEqual(config.PLAYOFF_SEASONS[-1], config.SEASONS[-1])

    def test_regular_scope_is_a_subset_of_playoff_scope(self):
        self.assertTrue(set(config.SEASONS) <= set(config.PLAYOFF_SEASONS))

    def test_all_seasons_is_sorted_union_without_duplicates(self):
        self.assertEqual(list(config.ALL_SEASONS), sorted(set(config.ALL_SEASONS)))
        self.assertEqual(set(config.ALL_SEASONS), set(config.SEASONS) | set(config.PLAYOFF_SEASONS))

    def test_seasons_are_consecutive_year_pairs(self):
        for s in config.PLAYOFF_SEASONS:
            self.assertEqual(int(s[4:]), int(s[:4]) + 1)
        self.assertEqual(len(config.PLAYOFF_SEASONS),
                         config.LAST_SEASON_START_YEAR - config.PLAYOFF_FIRST_SEASON_START_YEAR + 1)

    def test_unknown_game_type_raises(self):
        for gt in (0, 1, 4, 99):
            with self.subTest(gt=gt), self.assertRaises(ValueError):
                config.seasons_for_type(gt)


class TestSeasonOf(unittest.TestCase):
    def test_happy_paths(self):
        self.assertEqual(ratings.season_of(2009030416), "20092010")
        self.assertEqual(ratings.season_of(2010030417), "20102011")
        self.assertEqual(ratings.season_of(2015020001), "20152016")
        self.assertEqual(ratings.season_of(2025030417), "20252026")

    def test_2009_regular_season_game_is_out_of_scope(self):
        with self.assertRaises(ValueError):
            ratings.season_of(2009020001)

    def test_2014_regular_out_but_2014_playoff_in(self):
        with self.assertRaises(ValueError):
            ratings.season_of(2014020500)
        self.assertEqual(ratings.season_of(2014030111), "20142015")

    def test_before_playoff_scope_raises(self):
        with self.assertRaises(ValueError):
            ratings.season_of(2008030417)

    def test_after_last_season_raises(self):
        with self.assertRaises(ValueError):
            ratings.season_of(2026030111)

    def test_unknown_game_type_in_id_raises(self):
        for gid in (2023010001, 2023040001, 2023000001):
            with self.subTest(gid=gid), self.assertRaises(ValueError):
                ratings.season_of(gid)


class TestResolveSeasons(unittest.TestCase):
    def test_all_playoffs_starts_2009(self):
        seasons = build.resolve_seasons("all", [3])
        self.assertEqual(seasons[0], "20092010")
        self.assertEqual(seasons, list(config.PLAYOFF_SEASONS))

    def test_all_regular_unchanged(self):
        self.assertEqual(build.resolve_seasons("all", [2]), list(config.SEASONS))

    def test_all_both_types_is_union(self):
        self.assertEqual(build.resolve_seasons("all", [2, 3]), list(config.ALL_SEASONS))

    def test_explicit_2009_rejected_for_regular_only(self):
        with self.assertRaises(ValueError):
            build.resolve_seasons("20092010", [2])

    def test_explicit_2009_accepted_when_playoffs_requested(self):
        self.assertEqual(build.resolve_seasons("20092010,20232024", [2, 3]), ["20092010", "20232024"])

    def test_unknown_season_and_empty_inputs_raise(self):
        for spec, types in (("19992000", [3]), ("", [3]), (",", [3]), ("all", []), ("all", [4])):
            with self.subTest(spec=spec, types=types), self.assertRaises(ValueError):
                build.resolve_seasons(spec, types)

    def test_whitespace_is_tolerated(self):
        self.assertEqual(build.resolve_seasons(" 20102011 , 20112012", [3]), ["20102011", "20112012"])

    def test_main_rejects_bad_scope_before_opening_the_db(self):
        from unittest.mock import patch

        def no_db(*a, **k):
            raise AssertionError("connect() must not run for an invalid scope")
        for argv in (["--offline", "ingest", "--seasons", "20092010", "--types", "2"],
                     ["--offline", "ingest", "--types", "x"],
                     ["--offline", "all", "--types", "4", "--start", "2026-11-01"]):
            with self.subTest(argv=argv), patch.object(build, "connect", no_db), \
                    contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit) as cm:
                build.main(argv)
            self.assertEqual(cm.exception.code, 2)


class _ScopedGamesClient:
    """Records every (season, type) listing requested."""

    def __init__(self):
        self.calls: list[tuple[str, int]] = []

    def games_for_season(self, season, game_type):
        self.calls.append((season, game_type))
        return {"data": [{"id": int(season[:4]) * 1_000_000 + game_type * 10_000 + 1, "gameStateId": 7}]}


class TestGameIdsScope(unittest.TestCase):
    def test_playoffs_all_includes_2009(self):
        c = _ScopedGamesClient()
        ids = build._game_ids(c, build.resolve_seasons("all", [3]), [3])
        self.assertEqual(ids[0], 2009030001)
        self.assertIn(("20092010", 3), c.calls)

    def test_regular_season_not_requested_before_2015(self):
        c = _ScopedGamesClient()
        build._game_ids(c, build.resolve_seasons("all", [2, 3]), [2, 3])
        self.assertNotIn(("20092010", 2), c.calls)
        self.assertNotIn(("20142015", 2), c.calls)
        self.assertIn(("20152016", 2), c.calls)
        self.assertIn(("20142015", 3), c.calls)

    def test_out_of_scope_pair_alone_yields_nothing(self):
        c = _ScopedGamesClient()
        self.assertEqual(build._game_ids(c, ["20092010"], [2]), [])
        self.assertEqual(c.calls, [])

    def test_empty_seasons(self):
        self.assertEqual(build._game_ids(_ScopedGamesClient(), [], [2, 3]), [])

    def test_unknown_type_raises(self):
        with self.assertRaises(ValueError):
            build._game_ids(_ScopedGamesClient(), ["20232024"], [4])

    def test_every_listed_id_maps_back_into_scope(self):
        c = _ScopedGamesClient()
        for gid in build._game_ids(c, build.resolve_seasons("all", [2, 3]), [2, 3]):
            ratings.season_of(gid)  # raises if a listed game were out of scope


# ---------------------------------------------------------------------------
# playable() / mine()
# ---------------------------------------------------------------------------
def seg(**over):
    base = {"game_id": 2023030111, "game_type": 3, "period": 2, "start_t": 300, "end_t": 360,
            "pp_score": 1, "pk_score": 1, "pp_remaining_s": 120, "outcome": "no_goal", "has_shifts": True}
    base.update(over)
    return base


class TestPlayable(unittest.TestCase):
    def test_happy_path(self):
        self.assertTrue(scenarios.playable(seg()))

    def test_zero_length_segment_excluded(self):
        self.assertFalse(scenarios.playable(seg(start_t=300, end_t=300)))

    def test_zero_length_excluded_for_every_outcome(self):
        for outcome in ("no_goal", "goal", "sh_goal_against"):
            with self.subTest(outcome=outcome):
                self.assertFalse(scenarios.playable(seg(start_t=500, end_t=500, outcome=outcome)))

    def test_one_second_segment_is_playable(self):
        self.assertTrue(scenarios.playable(seg(start_t=300, end_t=301)))

    def test_negative_length_excluded(self):
        self.assertFalse(scenarios.playable(seg(start_t=300, end_t=299)))

    def test_period_end_opener_excluded(self):
        self.assertFalse(scenarios.playable(seg(start_t=config.PERIOD_LENGTH_S, end_t=config.PERIOD_LENGTH_S)))
        self.assertFalse(scenarios.playable(seg(start_t=config.PERIOD_LENGTH_S, end_t=config.PERIOD_LENGTH_S + 5)))
        self.assertFalse(scenarios.playable(seg(start_t=config.PERIOD_LENGTH_S + 1, end_t=config.PERIOD_LENGTH_S + 9)))

    def test_last_second_opener_with_length_is_playable(self):
        self.assertTrue(scenarios.playable(seg(start_t=config.PERIOD_LENGTH_S - 1, end_t=config.PERIOD_LENGTH_S)))

    def test_shiftless_game_excluded(self):
        for flag in (False, 0, None):
            with self.subTest(flag=flag):
                self.assertFalse(scenarios.playable(seg(has_shifts=flag)))

    def test_missing_has_shifts_fails_closed(self):
        s = seg()
        del s["has_shifts"]
        self.assertFalse(scenarios.playable(s))

    def test_has_shifts_as_sqlite_int_one_is_playable(self):
        self.assertTrue(scenarios.playable(seg(has_shifts=1)))

    def test_missing_times_fail_closed(self):
        for key in ("start_t", "end_t"):
            s = seg()
            del s[key]
            with self.subTest(missing=key):
                self.assertFalse(scenarios.playable(s))

    def test_existing_rules_still_apply(self):
        self.assertFalse(scenarios.playable(seg(pp_remaining_s=None)))
        self.assertFalse(scenarios.playable(seg(pp_remaining_s=config.MIN_PP_REMAINING_FOR_POOL_S - 1)))
        self.assertTrue(scenarios.playable(seg(pp_remaining_s=config.MIN_PP_REMAINING_FOR_POOL_S)))
        self.assertFalse(scenarios.playable(seg(outcome="carried_over")))


class TestMine(unittest.TestCase):
    def test_happy_path_orders_by_drama(self):
        segs = [seg(game_id=1, period=1), seg(game_id=2, period=4)]
        self.assertEqual([s["game_id"] for s in scenarios.mine(segs)], [2, 1])  # OT beats P1

    def test_shiftless_games_left_out_but_others_kept(self):
        segs = [seg(game_id=2009030416, period=4, has_shifts=False), seg(game_id=2010030417, period=1)]
        self.assertEqual([s["game_id"] for s in scenarios.mine(segs)], [2010030417])

    def test_zero_length_and_period_end_openers_left_out(self):
        segs = [seg(game_id=1, start_t=100, end_t=100), seg(game_id=2, start_t=1200, end_t=1200),
                seg(game_id=3)]
        self.assertEqual([s["game_id"] for s in scenarios.mine(segs)], [3])

    def test_empty_input(self):
        self.assertEqual(scenarios.mine([]), [])

    def test_all_unplayable(self):
        self.assertEqual(scenarios.mine([seg(has_shifts=False), seg(end_t=300)]), [])

    def test_limit_and_zero_limit(self):
        segs = [seg(game_id=i) for i in range(1, 6)]
        self.assertEqual(len(scenarios.mine(segs, limit=2)), 2)
        self.assertEqual(scenarios.mine(segs, limit=0), [])

    def test_deterministic_tie_break(self):
        segs = [seg(game_id=3, start_t=50, end_t=90), seg(game_id=1, start_t=70, end_t=90),
                seg(game_id=1, start_t=20, end_t=90)]
        a = scenarios.mine(segs)
        b = scenarios.mine(list(reversed(segs)))
        self.assertEqual(a, b)
        self.assertEqual([(s["game_id"], s["start_t"]) for s in a], [(1, 20), (1, 70), (3, 50)])

    def test_input_not_mutated(self):
        segs = [seg(game_id=2), seg(game_id=1)]
        before = json.dumps(segs)
        scenarios.mine(segs)
        self.assertEqual(json.dumps(segs), before)


# ---------------------------------------------------------------------------
# ingest: has_shifts only for charts with real shifts
# ---------------------------------------------------------------------------
class _ShiftClient:
    def __init__(self, shifts):
        self._shifts = shifts

    def shifts(self, game_id):
        if isinstance(self._shifts, Exception):
            raise self._shifts
        return self._shifts


class TestHasShifts(unittest.TestCase):
    def _run(self, shifts):
        with contextlib.redirect_stdout(io.StringIO()):
            return build._has_shifts(_ShiftClient(shifts), 2009030416)

    def test_real_shifts(self):
        self.assertEqual(self._run(FakeClient(synthetic_game(), "x").shifts(1)), 1)

    def test_empty_chart_like_2009_10(self):
        self.assertEqual(self._run({"data": [], "total": 0}), 0)

    def test_goal_rows_only(self):
        self.assertEqual(self._run({"data": [{"playerId": 1, "teamId": HOME, "period": 1,
                                              "startTime": None, "endTime": None}]}), 0)

    def test_fetch_error(self):
        self.assertEqual(self._run(FetchError("down")), 0)

    def test_missing_data_key(self):
        self.assertEqual(self._run({"total": 0}), 0)

    def test_malformed_row(self):
        self.assertEqual(self._run({"data": [{"teamId": HOME, "period": 1, "startTime": "00:00",
                                              "endTime": "00:40"}]}), 0)

    def test_bad_time_string(self):
        self.assertEqual(self._run({"data": [{"playerId": 1, "teamId": HOME, "period": 1,
                                              "startTime": "xx", "endTime": "00:40"}]}), 0)

    def test_reason_is_printed_not_swallowed(self):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            build._has_shifts(_ShiftClient(FetchError("simulated")), 2009030416)
        self.assertIn("has_shifts=0", buf.getvalue())
        self.assertIn("simulated", buf.getvalue())


def _write_cache(client: NhlClient, url: str, body) -> None:
    path = client._cache_path(url)
    path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(path, "wt", encoding="utf-8") as fh:
        json.dump({"url": url, "body": body}, fh)


class TestShiftlessGameEndToEnd(unittest.TestCase):
    """A 2009-10-style game (empty shift chart) is ingested and rated but never mined."""

    def test_shiftless_game_in_ratings_not_in_pool(self):
        shifted = synthetic_game(game_id=2023030111, date="2024-04-20")
        shiftless = synthetic_game(game_id=2009030111, date="2010-04-15")
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            client = NhlClient(cache_dir=d / "cache", offline=True)
            fake = FakeClient(shifted, "2024-04-20")
            for season, gid in (("20232024", shifted["id"]), ("20092010", shiftless["id"])):
                _write_cache(client, config.STATS_BASE + config.GAMES_BY_SEASON_PATH.format(season=season, game_type=3),
                             {"data": [{"id": gid, "gameStateId": 7}]})
            _write_cache(client, config.WEB_BASE + config.PBP_PATH.format(game_id=shifted["id"]), shifted)
            _write_cache(client, config.WEB_BASE + config.PBP_PATH.format(game_id=shiftless["id"]), shiftless)
            _write_cache(client, config.STATS_BASE + config.SHIFTS_PATH.format(game_id=shifted["id"]),
                         fake.shifts(shifted["id"]))
            _write_cache(client, config.STATS_BASE + config.SHIFTS_PATH.format(game_id=shiftless["id"]),
                         {"data": [], "total": 0})
            conn = build.connect(d / "t.db")
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(build.cmd_ingest(client, conn, ["20092010", "20232024"], [3]), 0)
                    flags = dict(conn.execute("SELECT game_id, has_shifts FROM games"))
                    self.assertEqual(flags, {shifted["id"]: 1, shiftless["id"]: 0})
                    # both games' segments are stored and rated
                    self.assertEqual(conn.execute("SELECT COUNT(DISTINCT game_id) FROM pp_segments").fetchone()[0], 2)
                    self.assertEqual(build.cmd_ratings(conn), 0)
                    seasons = {s for (s,) in conn.execute("SELECT DISTINCT scope FROM base_rates")}
                    self.assertIn("20092010", seasons)
                    self.assertEqual(build.cmd_schedule(conn, date(2026, 11, 1)), 0)
                mined_games = {json.loads(p)["game_id"] for (p,) in
                               conn.execute("SELECT payload_json FROM scenarios WHERE kind='mined'")}
                self.assertTrue(mined_games)
                self.assertNotIn(shiftless["id"], mined_games)
                payloads = [json.loads(p) for (p,) in conn.execute("SELECT payload_json FROM scenarios")]
                self.assertTrue(all("has_shifts" not in p for p in payloads))  # exported shape unchanged
            finally:
                conn.close()

    def test_schedule_rerun_drops_stale_mined_scenarios(self):
        with tempfile.TemporaryDirectory() as d:
            conn = build.connect(Path(d) / "t.db")
            try:
                with conn:
                    conn.execute("INSERT INTO scenarios VALUES (?,?,?,?)",
                                 ("2016030153-p4-0044", "mined", 1.0, "{}"))      # old zero-length pick
                    conn.execute("INSERT INTO scenarios VALUES (?,?,?,?)", ("curated-x", "curated", 0.0, "{}"))
                with contextlib.redirect_stdout(io.StringIO()):
                    self.assertEqual(build.cmd_schedule(conn, date(2026, 11, 1)), 0)
                left = {sid for (sid,) in conn.execute("SELECT scenario_id FROM scenarios")}
                self.assertEqual(left, {"curated-x"})
            finally:
                conn.close()


# ---------------------------------------------------------------------------
# probe: era games + per-key report
# ---------------------------------------------------------------------------
class _EraProbeClient(_ProbeFakeClient):
    def __init__(self, pbps, shifts_by_id=None, listed=None, fail_ids=frozenset()):
        super().__init__(pbps, fail_ids=fail_ids)
        self.shifts_by_id = shifts_by_id or {}
        self.listed = listed

    def shifts(self, game_id):
        if game_id in self.shifts_by_id:
            return self.shifts_by_id[game_id]
        return super().shifts(game_id)

    def score_by_date(self, on_date):
        if self.listed is None:
            return super().score_by_date(on_date)
        return {"games": [{"id": gid, "homeTeam": {"abbrev": "HOM"}, "awayTeam": {"abbrev": "AWY"}}
                          for gid in self.listed]}


ERA_2009, ERA_2010 = (gid for gid, _ in config.PROBE_ERA_GAMES)


def _probe(client, gid=2023020001, on_date="2024-01-01"):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = build.cmd_probe(client, gid, on_date)
    return rc, out.getvalue(), err.getvalue()


class TestProbeEraGames(unittest.TestCase):
    def test_era_games_configured_for_2009_and_2010(self):
        self.assertEqual([ratings.season_of(g) for g, _ in config.PROBE_ERA_GAMES], ["20092010", "20102011"])

    def test_happy_path_checks_both_era_games(self):
        client = _EraProbeClient({2023020001: _probe_pbp(2023020001)})
        rc, out, _ = _probe(client)
        self.assertEqual(rc, 0)
        self.assertIn(ERA_2009, client.pbp_calls)
        self.assertIn(ERA_2010, client.pbp_calls)
        self.assertIn(f"era-game {ERA_2009} shifts: data[0].playerId: present", out)

    def test_empty_shift_chart_is_reported_not_failed(self):
        client = _EraProbeClient({2023020001: _probe_pbp(2023020001)}, shifts_by_id={ERA_2009: {"data": [], "total": 0}})
        rc, out, _ = _probe(client)
        self.assertEqual(rc, 0)
        self.assertIn(f"era-game {ERA_2009} shifts: data[0].playerId: ABSENT", out)
        self.assertIn("NO SHIFTS", out)

    def test_era_fetch_failure_fails_probe(self):
        client = _EraProbeClient({2023020001: _probe_pbp(2023020001)}, fail_ids={ERA_2010})
        rc, _, err = _probe(client)
        self.assertEqual(rc, 1)
        self.assertIn(f"era-game {ERA_2010}", err)

    def test_era_pbp_missing_key_fails_probe(self):
        bad = _probe_pbp(ERA_2009)
        del bad["rosterSpots"]
        rc, _, err = _probe(_EraProbeClient({2023020001: _probe_pbp(2023020001), ERA_2009: bad}))
        self.assertEqual(rc, 1)
        self.assertIn("rosterSpots", err)

    def test_era_game_not_listed_on_date_fails_probe(self):
        client = _EraProbeClient({2023020001: _probe_pbp(2023020001)}, listed=[2023020001, ERA_2010])
        rc, _, err = _probe(client)
        self.assertEqual(rc, 1)
        self.assertIn(f"era-game {ERA_2009}: not listed", err)

    def test_era_parse_error_fails_probe(self):
        bad = _probe_pbp(ERA_2010)
        bad["plays"][0]["situationCode"] = "2551"
        rc, _, err = _probe(_EraProbeClient({2023020001: _probe_pbp(2023020001), ERA_2010: bad}))
        self.assertEqual(rc, 1)
        self.assertIn(f"era-game {ERA_2010} parse", err)

    def test_era_game_as_primary_is_checked_once(self):
        client = _EraProbeClient({ERA_2009: _probe_pbp(ERA_2009)})
        _probe(client, gid=ERA_2009, on_date="2010-06-09")
        self.assertEqual(client.pbp_calls.count(ERA_2009), 1)

    def test_primary_shiftless_still_fails_like_before(self):
        # --game-id on a shift-less game keeps the strict all-keys check (that is the per-key record).
        client = _EraProbeClient({ERA_2009: _probe_pbp(ERA_2009)}, shifts_by_id={ERA_2009: {"data": []}})
        rc, _, err = _probe(client, gid=ERA_2009, on_date="2010-06-09")
        self.assertEqual(rc, 1)
        self.assertIn("shifts:", err)


class TestProbeKeyReport(unittest.TestCase):
    def _responses(self):
        return {"pbp": _probe_pbp(2023020001),
                "shifts": {"data": [{"playerId": 1, "teamId": HOME, "period": 1, "startTime": "00:00",
                                     "endTime": "00:30"}]},
                "score": {"games": [{"id": 1, "homeTeam": {"abbrev": "HOM"}, "awayTeam": {"abbrev": "AWY"}}]},
                "games": {"data": [{"id": 1, "gameStateId": 7}]}}

    def test_happy_path_every_key_present(self):
        report = build.probe_key_report(self._responses())
        self.assertEqual(set(report), set(build.PROBE_PATHS))
        self.assertTrue(all(all(v.values()) for v in report.values()))

    def test_every_probe_path_is_reported(self):
        report = build.probe_key_report(self._responses())
        for name, paths in build.PROBE_PATHS.items():
            self.assertEqual(list(report[name]), paths)

    def test_empty_shift_chart_all_absent(self):
        r = self._responses()
        r["shifts"] = {"data": [], "total": 0}
        report = build.probe_key_report(r, names=["shifts"])
        self.assertEqual(set(report), {"shifts"})
        self.assertFalse(any(report["shifts"].values()))

    def test_partial_absence(self):
        r = self._responses()
        del r["pbp"]["rosterSpots"]
        report = build.probe_key_report(r, names=["pbp"])
        self.assertFalse(report["pbp"]["rosterSpots[0].playerId"])
        self.assertTrue(report["pbp"]["id"])

    def test_unknown_name_raises(self):
        with self.assertRaises(KeyError):
            build.probe_key_report(self._responses(), names=["nope"])

    def test_missing_response_raises(self):
        with self.assertRaises(KeyError):
            build.probe_key_report({"pbp": {}}, names=["shifts"])

    def test_non_dict_body_is_all_absent(self):
        report = build.probe_key_report({"games": None}, names=["games"])
        self.assertFalse(any(report["games"].values()))


class TestEraCoverage(unittest.TestCase):
    def test_happy_path_counts(self):
        pbp = synthetic_game()
        cov = build.era_coverage(pbp, FakeClient(pbp, "x").shifts(1))
        self.assertEqual(cov["plays"], len(pbp["plays"]))
        self.assertEqual(cov["with_situation_code"], len(pbp["plays"]))
        self.assertEqual(cov["with_home_defending_side"], len(pbp["plays"]))
        self.assertEqual(cov["shift_rows"], 6)
        self.assertGreater(cov["with_coordinates"], 0)

    def test_2009_style_no_side_no_shifts(self):
        pbp = _probe_pbp(ERA_2009)
        pbp["plays"] = [play(1, "faceoff", 1, "00:00", "1551", side=None, eventOwnerTeamId=HOME,
                             winningPlayerId=101, losingPlayerId=201, xCoord=0, yCoord=0)]
        cov = build.era_coverage(pbp, {"data": [], "total": 0})
        self.assertEqual((cov["with_home_defending_side"], cov["shift_rows"], cov["with_coordinates"]), (0, 0, 1))

    def test_missing_situation_code_and_coords_counted_as_absent(self):
        pbp = _probe_pbp(1)
        pbp["plays"] = [play(1, "period-start", 1, "00:00")]
        cov = build.era_coverage(pbp, {"data": []})
        self.assertEqual((cov["with_situation_code"], cov["with_coordinates"]), (0, 0))

    def test_only_x_without_y_is_not_coordinates(self):
        pbp = _probe_pbp(1)
        pbp["plays"] = [play(1, "faceoff", 1, "00:00", "1551", xCoord=5)]
        self.assertEqual(build.era_coverage(pbp, {"data": []})["with_coordinates"], 0)

    def test_empty_plays(self):
        pbp = _probe_pbp(1)
        pbp["plays"] = []
        self.assertEqual(build.era_coverage(pbp, {"data": []})["plays"], 0)

    def test_goal_only_shift_rows_count_zero(self):
        cov = build.era_coverage(_probe_pbp(1), {"data": [{"playerId": 1, "teamId": AWAY, "period": 1,
                                                           "startTime": "", "endTime": ""}]})
        self.assertEqual(cov["shift_rows"], 0)

    def test_missing_plays_or_data_raises(self):
        with self.assertRaises(SchemaError):
            build.era_coverage({}, {"data": []})
        with self.assertRaises(SchemaError):
            build.era_coverage(_probe_pbp(1), {})


if __name__ == "__main__":
    unittest.main()
