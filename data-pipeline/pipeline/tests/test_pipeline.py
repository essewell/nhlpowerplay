"""Pipeline tests. Run from powerplay-data/:  python -m unittest discover -s pipeline/tests -t .

All game data below is SYNTHETIC and shaped like the api-web play-by-play
fields the parser uses; it is not a real game.
"""
from __future__ import annotations

import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path

from pipeline import config, ratings, scenarios
from pipeline.nhl_client import FetchError, NhlClient, SchemaError, need
from pipeline.parse import (ParseError, mmss_to_seconds, normalize_xy, parse_events, parse_header,
                            parse_situation)
from pipeline.segments import build_segments

HOME, AWAY = 10, 20


def play(eid, kind, period, t, code=None, side="left", **details):
    p = {"eventId": eid, "typeDescKey": kind, "periodDescriptor": {"number": period},
         "timeInPeriod": t, "homeTeamDefendingSide": side, "details": details}
    if code is not None:
        p["situationCode"] = code
    return p


def synthetic_game(game_id=2023030111, date="2024-04-20"):
    plays = [
        play(1, "faceoff", 1, "00:00", "1551", eventOwnerTeamId=HOME, winningPlayerId=101, losingPlayerId=201),
        # PP 1: away penalty 5:00, home PP, home scores at 6:00
        play(2, "penalty", 1, "05:00", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=202,
             drawnByPlayerId=101, typeCode="MIN", duration=2),
        play(3, "faceoff", 1, "05:05", "1451", eventOwnerTeamId=HOME, winningPlayerId=101, losingPlayerId=201),
        play(4, "shot-on-goal", 1, "05:30", "1451", eventOwnerTeamId=HOME, shootingPlayerId=102,
             goalieInNetId=299, shotType="wrist", xCoord=70, yCoord=-5),
        play(5, "blocked-shot", 1, "05:40", "1451", eventOwnerTeamId=AWAY, shootingPlayerId=103,
             blockingPlayerId=203, xCoord=60, yCoord=10),
        play(6, "goal", 1, "06:00", "1451", eventOwnerTeamId=HOME, scoringPlayerId=102, assist1PlayerId=101,
             assist2PlayerId=103, goalieInNetId=299, shotType="snap", xCoord=75, yCoord=3,
             homeScore=1, awayScore=0),
        # PP 2: home penalty P2 10:00, away PP, expires (even code at 12:05)
        play(7, "penalty", 2, "10:00", "1551", side="right", eventOwnerTeamId=HOME, committedByPlayerId=104,
             typeCode="MIN", duration=2),
        play(8, "faceoff", 2, "10:02", "1541", side="right", eventOwnerTeamId=AWAY, winningPlayerId=201,
             losingPlayerId=101),
        play(9, "missed-shot", 2, "11:00", "1541", side="right", eventOwnerTeamId=AWAY, shootingPlayerId=204,
             shotType="slap", xCoord=60, yCoord=0),
        play(10, "faceoff", 2, "12:05", "1551", side="right", eventOwnerTeamId=HOME, winningPlayerId=101,
             losingPlayerId=201),
        # PP 3: away penalty P3 2:00, home PP, AWAY scores shorthanded
        play(11, "penalty", 3, "02:00", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=205,
             typeCode="MIN", duration=2),
        play(12, "faceoff", 3, "02:03", "1451", eventOwnerTeamId=HOME, winningPlayerId=101, losingPlayerId=201),
        play(13, "goal", 3, "03:00", "1451", eventOwnerTeamId=AWAY, scoringPlayerId=206, goalieInNetId=199,
             shotType="wrist", xCoord=-80, yCoord=0, homeScore=1, awayScore=1),
        # 6v5 extra attacker late: NOT a power play
        play(14, "shot-on-goal", 3, "19:00", "0651", eventOwnerTeamId=AWAY, shootingPlayerId=204,
             goalieInNetId=199, shotType="wrist", xCoord=-70, yCoord=0),
        # PP 4 starts late in P3 and carries into OT
        play(15, "penalty", 3, "19:30", "1551", eventOwnerTeamId=HOME, committedByPlayerId=105,
             typeCode="MIN", duration=2),
        play(16, "faceoff", 3, "19:31", "1541", eventOwnerTeamId=AWAY, winningPlayerId=201, losingPlayerId=101),
        play(17, "faceoff", 4, "00:00", "1541", eventOwnerTeamId=AWAY, winningPlayerId=201, losingPlayerId=101),
    ]
    roster = [{"playerId": pid, "teamId": tid, "firstName": {"default": "F"}, "lastName": {"default": last},
               "sweaterNumber": pid % 100, "positionCode": pos}
              for pid, tid, last, pos in [(101, HOME, "Centre", "C"), (102, HOME, "Sniper", "R"),
                                          (103, HOME, "Dman", "D"), (199, HOME, "Homegoalie", "G"),
                                          (201, AWAY, "Awayc", "C"), (299, AWAY, "Awaygoalie", "G")]]
    return {"id": game_id, "gameDate": date, "gameType": 3,
            "homeTeam": {"id": HOME, "abbrev": "HOM"}, "awayTeam": {"id": AWAY, "abbrev": "AWY"},
            "plays": plays, "rosterSpots": roster}


class TestParse(unittest.TestCase):
    def test_situation_and_power_play_rules(self):
        s = parse_situation("1451")
        self.assertTrue(s.is_power_play(is_home=True))
        self.assertFalse(s.is_power_play(is_home=False))
        self.assertEqual(s.label(True), "5v4")
        self.assertFalse(parse_situation("0651").is_power_play(is_home=False))  # 6v5 extra attacker
        self.assertTrue(parse_situation("0641").is_power_play(is_home=False))   # 6v4 pulled on PP
        self.assertTrue(parse_situation("1341").is_power_play(is_home=True))    # 4v3
        self.assertFalse(parse_situation("1551").is_power_play(is_home=True))

    def test_bad_inputs_raise(self):
        for bad in ("151", "15a1", "2551", "1071", None):
            with self.assertRaises(ParseError):
                parse_situation(bad)
        for bad in ("12-23", "1:75", "x"):
            with self.assertRaises(ParseError):
                mmss_to_seconds(bad)
        self.assertEqual(mmss_to_seconds("12:23"), 743)

    def test_normalize_orientation(self):
        self.assertEqual(normalize_xy(70, 5, True, "left"), (70, 5))
        self.assertEqual(normalize_xy(70, 5, True, "right"), (-70, -5))
        self.assertEqual(normalize_xy(-70, 5, False, "left"), (70, -5))
        with self.assertRaises(ParseError):
            normalize_xy(1, 1, True, None)

    def test_need_reports_path(self):
        with self.assertRaises(SchemaError) as ctx:
            need({"a": {"b": [1]}}, "a.b[3]")
        self.assertIn("a.b.[3]", str(ctx.exception))


class TestSegments(unittest.TestCase):
    def setUp(self):
        pbp = synthetic_game()
        self.header = parse_header(pbp)
        self.events = parse_events(pbp, self.header)
        self.segs = build_segments(self.header, self.events)

    def test_segments_with_correct_outcomes(self):
        self.assertEqual([s.outcome for s in self.segs],
                         ["goal", "no_goal", "sh_goal_against", "carried_over", "no_goal"])

    def test_carry_over_continues_in_next_period_with_remaining_time(self):
        cont = self.segs[4]
        self.assertEqual((cont.period, cont.start_t, cont.pp_team_id), (4, 0, AWAY))
        self.assertEqual(cont.pp_remaining_s, 90)   # 2:00 minor taken at 19:30 of P3

    def test_goal_segment_details(self):
        g = self.segs[0]
        self.assertEqual((g.pp_team_id, g.period, g.start_t, g.end_t), (HOME, 1, 305, 360))
        self.assertEqual((g.scorer_id, g.assist1_id, g.pp_remaining_s), (102, 101, 115))
        self.assertEqual(len(g.shots), 3)  # SOG + blocked + goal
        self.assertEqual(g.shots[1]["kind"], "blocked-shot")

    def test_blocked_shot_credited_to_shooting_team(self):
        blocked = next(e for e in self.events if e.kind == "blocked-shot")
        self.assertEqual(blocked.team_id, HOME)

    def test_scores_tracked_into_later_segments(self):
        self.assertEqual((self.segs[1].pp_score, self.segs[1].pk_score), (0, 1))  # away PP, home leads 1-0

    def test_attacking_team_normalised_toward_positive_x(self):
        miss = next(e for e in self.events if e.kind == "missed-shot")   # away attacks +x already
        self.assertEqual((miss.x, miss.y), (60.0, 0.0))
        sh_goal = next(e for e in self.events if e.event_id == 13)       # away attacks -x -> flipped
        self.assertEqual((sh_goal.x, sh_goal.y), (80.0, -0.0))


class TestRatings(unittest.TestCase):
    def test_shrinkage_and_tables(self):
        self.assertAlmostEqual(ratings.shrunk_multiplier(0, 0, 6), 1.0)
        self.assertAlmostEqual(ratings.shrunk_multiplier(10, 4, 6), 1.6)
        with self.assertRaises(ValueError):
            ratings.shrunk_multiplier(1, 1, 0)
        pbp = synthetic_game()
        h = parse_header(pbp)
        segs = [s.to_dict() for s in build_segments(h, parse_events(pbp, h))]
        r = ratings.compute(segs)
        self.assertIn("102", {str(k) for k in r["shooters"]})
        self.assertEqual(r["league"]["exposure_source"], "participants_only")
        self.assertTrue(all(0 < v["win_rate"] < 1 for v in r["faceoffs"].values()))

    def test_season_of(self):
        self.assertEqual(ratings.season_of(2023020204), "20232024")
        with self.assertRaises(ValueError):
            ratings.season_of(1999020001)


class FakeClient:
    def __init__(self, pbp, date):
        self._pbp, self._date = pbp, date

    def score_by_date(self, date):
        if date != self._date:
            return {"games": []}
        return {"games": [{"id": self._pbp["id"], "homeTeam": {"abbrev": "HOM"}, "awayTeam": {"abbrev": "AWY"}}]}

    def pbp(self, game_id):
        return self._pbp

    def shifts(self, game_id):
        return {"data": [{"playerId": p, "teamId": t, "period": 1, "startTime": "04:50", "endTime": "06:30"}
                         for p, t in [(101, HOME), (102, HOME), (103, HOME), (199, HOME), (201, AWAY), (299, AWAY)]]}


class TestCuration(unittest.TestCase):
    base = {"id": "test-moment", "date": "2024-04-20", "teams": ["HOM", "AWY"], "pp_team": "HOM",
            "period": 1, "goal_time": "06:00", "penalty_time": "05:00", "scorer_last": "Sniper",
            "score_before": {"pp": 0, "pk": 0}, "real_outcome": "goal"}

    def test_verified_scenario(self):
        scen = scenarios.resolve_curated(dict(self.base), FakeClient(synthetic_game(), "2024-04-20"))
        self.assertEqual(scen["verification"]["status"], "verified_against_pbp")
        self.assertEqual({p["id"] for p in scen["pp"]["skaters"]}, {101, 102, 103})
        self.assertEqual(scen["pp"]["goalie"]["id"], 199)
        self.assertEqual(scen["state"]["pp_remaining_s"], 115)
        self.assertEqual(scen["seed"], scenarios.stable_seed("test-moment"))

    def test_mismatches_refuse(self):
        client = FakeClient(synthetic_game(), "2024-04-20")
        for change in ({"scorer_last": "Nobody"}, {"goal_time": "06:01"}, {"pp_team": "XXX"},
                       {"date": "2024-04-21"}, {"score_before": {"pp": 1, "pk": 0}}):
            with self.subTest(change=change), self.assertRaises(scenarios.CurationMismatch):
                scenarios.resolve_curated({**self.base, **change}, client)

    def test_curated_file_is_well_formed(self):
        data = json.loads((config.ROOT / "data" / "curated_moments.json").read_text(encoding="utf-8"))
        ids = [m["id"] for m in data["moments"]]
        self.assertEqual(len(ids), len(set(ids)))
        for m in data["moments"]:
            self.assertTrue(m["sources"], m["id"])
            self.assertIn(m["pp_team"], m["teams"])
            for key in ("goal_time", "penalty_time"):
                if m[key]:
                    mmss_to_seconds(m[key])

    def test_mining_and_schedule(self):
        segs = [{"game_id": 1, "game_type": 3, "period": 4, "start_t": 10, "pp_score": 2, "pk_score": 2,
                 "pp_remaining_s": 120, "outcome": "goal"},
                {"game_id": 2, "game_type": 2, "period": 1, "start_t": 10, "pp_score": 0, "pk_score": 4,
                 "pp_remaining_s": 120, "outcome": "no_goal"},
                {"game_id": 3, "game_type": 3, "period": 2, "start_t": 10, "pp_score": 0, "pk_score": 0,
                 "pp_remaining_s": 10, "outcome": "no_goal"}]
        mined = scenarios.mine(segs)
        self.assertEqual([s["game_id"] for s in mined], [1, 2])     # 10 s PP excluded
        from datetime import date
        sched = scenarios.daily_schedule(["c1", "x"], ["x", "m1"], date(2026, 11, 1))
        self.assertEqual([r["scenario_id"] for r in sched], ["c1", "x", "m1"])
        self.assertEqual(sched[-1]["date"], "2026-11-03")


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class TestClient(unittest.TestCase):
    def test_retry_then_cache(self):
        calls = {"n": 0}

        def opener(req, timeout):
            calls["n"] += 1
            if calls["n"] == 1:
                raise urllib.error.HTTPError(req.full_url, 503, "busy", None, None)
            return _Resp(b'{"ok": 1}')

        with tempfile.TemporaryDirectory() as d:
            c = NhlClient(cache_dir=Path(d), min_interval_s=0, sleep=lambda s: None, opener=opener)
            self.assertEqual(c.get_json("https://x/y"), {"ok": 1})
            self.assertEqual(c.get_json("https://x/y"), {"ok": 1})   # served from cache
            self.assertEqual(calls["n"], 2)

    def test_non_retryable_and_offline(self):
        def opener(req, timeout):
            raise urllib.error.HTTPError(req.full_url, 404, "nope", None, None)

        with tempfile.TemporaryDirectory() as d:
            c = NhlClient(cache_dir=Path(d), min_interval_s=0, sleep=lambda s: None, opener=opener)
            with self.assertRaises(FetchError):
                c.get_json("https://x/404")
            with self.assertRaises(FetchError):
                NhlClient(cache_dir=Path(d), offline=True).get_json("https://x/none")

    def test_gives_up_after_retries(self):
        def opener(req, timeout):
            raise urllib.error.URLError("down")

        with tempfile.TemporaryDirectory() as d:
            c = NhlClient(cache_dir=Path(d), min_interval_s=0, sleep=lambda s: None, opener=opener)
            with self.assertRaises(FetchError):
                c.get_json("https://x/down")


if __name__ == "__main__":
    unittest.main()


class TestIntegration(unittest.TestCase):
    """ingest -> ratings -> schedule -> export on a temp DB with a pre-filled offline cache."""

    def test_end_to_end_offline(self):
        from datetime import date
        from pipeline import build
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            client = NhlClient(cache_dir=d / "cache", offline=True)
            pbp = synthetic_game()
            fake = FakeClient(pbp, "2024-04-20")
            for url, body in [
                (config.STATS_BASE + config.GAMES_BY_SEASON_PATH.format(season="20232024", game_type=3),
                 {"data": [{"id": pbp["id"]}]}),
                (config.WEB_BASE + config.PBP_PATH.format(game_id=pbp["id"]), pbp),
                (config.STATS_BASE + config.SHIFTS_PATH.format(game_id=pbp["id"]), fake.shifts(pbp["id"])),
            ]:
                path = client._cache_path(url)
                path.parent.mkdir(parents=True, exist_ok=True)
                import gzip
                with gzip.open(path, "wt", encoding="utf-8") as fh:
                    json.dump({"url": url, "body": body}, fh)
            conn = build.connect(d / "t.db")
            self.assertEqual(build.cmd_ingest(client, conn, ["20232024"], [3]), 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM pp_segments").fetchone()[0], 5)
            self.assertEqual(build.cmd_ratings(conn), 0)
            self.assertGreater(conn.execute("SELECT COUNT(*) FROM base_rates").fetchone()[0], 0)
            self.assertEqual(build.cmd_schedule(conn, date(2026, 11, 1)), 0)
            self.assertEqual(build.cmd_export(conn, d / "export"), 0)
            exported = json.loads((d / "export" / "schedule.json").read_text())
            self.assertTrue(exported and exported[0]["date"] == "2026-11-01")
            conn.close()
