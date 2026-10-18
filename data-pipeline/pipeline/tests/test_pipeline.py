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

from pipeline import config, parse, ratings, scenarios
from pipeline.nhl_client import FetchError, NhlClient, SchemaError, need
from pipeline.parse import (ParseError, mmss_to_seconds, normalize_xy, parse_events, parse_header,
                            parse_situation)
from pipeline.segments import OUTCOME_CARRIED, OUTCOME_GOAL, OUTCOME_NO_GOAL, build_segments

HOME, AWAY = 10, 20


def play(eid, kind, period, t, code=None, side="left", period_type=None, **details):
    period_descriptor = {"number": period}
    if period_type is not None:
        period_descriptor["periodType"] = period_type
    p = {"eventId": eid, "typeDescKey": kind, "periodDescriptor": period_descriptor,
         "timeInPeriod": t, "details": details}
    if side is not None:
        p["homeTeamDefendingSide"] = side
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


# ---------------------------------------------------------------------------
# homeTeamDefendingSide inference (missing on most plays before 2019-20).
# Shapes below are built from the real cached 2015030111 response (zoneCode,
# xCoord on faceoff/penalty/shot plays; no homeTeamDefendingSide at all).
# ---------------------------------------------------------------------------
LEGACY_HEADER = parse.GameHeader(game_id=2015030111, date="2016-04-14", game_type=3,
                                  home_id=HOME, home_abbrev="HOM", away_id=AWAY, away_abbrev="AWY")


class TestSideInference(unittest.TestCase):
    def test_resolves_left_from_consistent_votes(self):
        plays = [
            play(1, "faceoff", 1, "01:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="N", xCoord=0),
            play(2, "shot-on-goal", 1, "02:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=70),
            play(3, "shot-on-goal", 1, "03:00", "1551", side=None, eventOwnerTeamId=AWAY, zoneCode="O", xCoord=-65),
            play(4, "shot-on-goal", 1, "04:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="D", xCoord=-50),
        ]
        self.assertEqual(parse._infer_defending_sides(plays, LEGACY_HEADER), {1: "left"})

    def test_resolves_right_for_opposite_pattern_in_another_period(self):
        plays = [
            play(1, "shot-on-goal", 2, "02:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=-70),
            play(2, "shot-on-goal", 2, "03:00", "1551", side=None, eventOwnerTeamId=AWAY, zoneCode="O", xCoord=65),
            play(3, "shot-on-goal", 2, "04:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="D", xCoord=50),
        ]
        self.assertEqual(parse._infer_defending_sides(plays, LEGACY_HEADER), {2: "right"})

    def test_below_min_samples_is_unresolved(self):
        plays = [
            play(1, "shot-on-goal", 3, "02:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=70),
            play(2, "shot-on-goal", 3, "03:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=68),
        ]
        self.assertNotIn(3, parse._infer_defending_sides(plays, LEGACY_HEADER))

    def test_contradictory_votes_below_agreement_are_unresolved(self):
        plays = [
            play(1, "shot-on-goal", 4, "01:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=70),
            play(2, "shot-on-goal", 4, "02:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=71),
            play(3, "shot-on-goal", 4, "03:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=-70),
            play(4, "shot-on-goal", 4, "04:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=-71),
        ]
        self.assertNotIn(4, parse._infer_defending_sides(plays, LEGACY_HEADER))

    def test_neutral_zone_and_zero_xcoord_do_not_vote(self):
        plays = [
            play(1, "faceoff", 5, "00:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="N", xCoord=0),
            play(2, "faceoff", 5, "05:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=0),
            play(3, "faceoff", 5, "10:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode=None, xCoord=70),
        ]
        self.assertNotIn(5, parse._infer_defending_sides(plays, LEGACY_HEADER))

    def test_blocked_shot_team_swap_is_respected(self):
        # eventOwnerTeamId on a blocked shot is the blocking team; the shooting
        # team's zone/x still drives the vote the same way a shot does.
        plays = [
            play(1, "blocked-shot", 6, "01:00", "1551", side=None, eventOwnerTeamId=AWAY, zoneCode="O", xCoord=70),
            play(2, "shot-on-goal", 6, "02:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=68),
            play(3, "shot-on-goal", 6, "03:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=72),
        ]
        # blocked-shot owner (AWAY) is swapped to HOME (the shooting team) by
        # _owner_team_id, so all three votes agree: home attacks +x -> "left".
        self.assertEqual(parse._infer_defending_sides(plays, LEGACY_HEADER), {6: "left"})

    def test_explicit_side_overrides_inference_end_to_end(self):
        plays = [
            play(1, "shot-on-goal", 1, "02:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=70),
            play(2, "shot-on-goal", 1, "03:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=71),
            play(3, "shot-on-goal", 1, "04:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=69),
            # period votes resolve to "left"; this play states "right" explicitly and must win.
            play(4, "shot-on-goal", 1, "05:00", "1551", side="right", eventOwnerTeamId=HOME,
                 zoneCode="O", shootingPlayerId=1, goalieInNetId=2, xCoord=70, yCoord=5),
        ]
        events = parse_events({"id": 1, "gameDate": "2024-01-01", "gameType": 2, "plays": plays},
                               LEGACY_HEADER)
        explicit = next(e for e in events if e.event_id == 4)
        self.assertFalse(explicit.side_unresolved)
        self.assertEqual((explicit.x, explicit.y), (-70, -5))  # "right" flips the coordinates

    def test_fallback_to_inferred_side_when_missing(self):
        plays = [
            play(1, "shot-on-goal", 1, "01:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=70),
            play(2, "shot-on-goal", 1, "02:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=71),
            play(3, "shot-on-goal", 1, "03:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="O", xCoord=69),
            play(4, "shot-on-goal", 1, "04:00", "1551", side=None, eventOwnerTeamId=HOME,
                 zoneCode="O", shootingPlayerId=1, goalieInNetId=2, xCoord=72, yCoord=-3),
        ]
        events = parse_events({"id": 1, "gameDate": "2024-01-01", "gameType": 2, "plays": plays},
                               LEGACY_HEADER)
        inferred = next(e for e in events if e.event_id == 4)
        self.assertFalse(inferred.side_unresolved)
        self.assertEqual((inferred.x, inferred.y), (72, -3))  # inferred "left" -> no flip

    def test_unresolved_side_leaves_xy_null_and_flagged_not_raised(self):
        plays = [
            play(1, "faceoff", 7, "00:00", "1551", side=None, eventOwnerTeamId=HOME, zoneCode="N", xCoord=0),
            play(2, "shot-on-goal", 7, "05:00", "1551", side=None, eventOwnerTeamId=HOME,
                 zoneCode="N", shootingPlayerId=1, goalieInNetId=2, xCoord=72, yCoord=-3),
        ]
        events = parse_events({"id": 1, "gameDate": "2024-01-01", "gameType": 2, "plays": plays},
                               LEGACY_HEADER)
        shot = next(e for e in events if e.event_id == 2)
        self.assertTrue(shot.side_unresolved)
        self.assertIsNone(shot.x)
        self.assertIsNone(shot.y)


# ---------------------------------------------------------------------------
# Shootout situationCodes ('1010'/'0101', shaped from the real cached
# 2019030002 response) must not raise, and the OT period-end boundary event
# that carries a shootout-shaped code one event before periodType flips to
# "SO" must be handled the same way.
# ---------------------------------------------------------------------------
class TestShootout(unittest.TestCase):
    def test_shootout_shot_and_goal_parse_without_raising(self):
        plays = [
            play(1, "period-start", 5, "00:00", "1010", side="right", period_type="SO"),
            play(2, "shot-on-goal", 5, "00:00", "1010", side="right", period_type="SO",
                 eventOwnerTeamId=AWAY, shootingPlayerId=1, goalieInNetId=2, xCoord=-75, yCoord=4),
            play(3, "goal", 5, "00:00", "0101", side="right", period_type="SO",
                 eventOwnerTeamId=HOME, scoringPlayerId=3, goalieInNetId=1, xCoord=77, yCoord=2,
                 homeScore=2, awayScore=2),
        ]
        events = parse_events({"id": 1, "gameDate": "2024-01-01", "gameType": 2, "plays": plays},
                               LEGACY_HEADER)
        self.assertTrue(all(e.situation is None for e in events))

    def test_ot_period_end_boundary_event_does_not_raise(self):
        # Real quirk: this play's periodType is still "OT", one event before
        # periodDescriptor flips to "SO", but situationCode is already shootout-shaped.
        p = play(1, "period-end", 4, "05:00", "1010", side=None, period_type="OT")
        events = parse_events({"id": 1, "gameDate": "2024-01-01", "gameType": 2, "plays": [p]},
                               LEGACY_HEADER)
        self.assertIsNone(events[0].situation)

    def test_genuinely_malformed_code_still_raises(self):
        p = play(1, "faceoff", 1, "00:00", "2551", eventOwnerTeamId=HOME)
        with self.assertRaises(ParseError):
            parse_events({"id": 1, "gameDate": "2024-01-01", "gameType": 2, "plays": [p]},
                         LEGACY_HEADER)

    def test_normal_ot_situation_code_still_parses_as_real_strength(self):
        p = play(1, "faceoff", 4, "00:00", "1341", eventOwnerTeamId=HOME, period_type="OT")
        events = parse_events({"id": 1, "gameDate": "2024-01-01", "gameType": 2, "plays": [p]},
                               LEGACY_HEADER)
        self.assertEqual(events[0].situation.label(True), "4v3")

    def test_shootout_plays_excluded_from_pp_segments(self):
        plays = [
            play(1, "faceoff", 1, "00:00", "1551", eventOwnerTeamId=HOME, winningPlayerId=101, losingPlayerId=201),
            play(2, "penalty", 1, "05:00", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=202,
                 typeCode="MIN", duration=2),
            play(3, "faceoff", 1, "05:05", "1451", eventOwnerTeamId=HOME, winningPlayerId=101, losingPlayerId=201),
            play(4, "period-end", 4, "05:00", "1010", side=None, period_type="OT"),
            play(5, "period-start", 5, "00:00", "1010", side="right", period_type="SO"),
            play(6, "shot-on-goal", 5, "00:00", "1010", side="right", period_type="SO",
                 eventOwnerTeamId=AWAY, shootingPlayerId=1, goalieInNetId=2, xCoord=-75, yCoord=4),
        ]
        header = parse.GameHeader(game_id=1, date="2024-01-01", game_type=2,
                                   home_id=HOME, home_abbrev="HOM", away_id=AWAY, away_abbrev="AWY")
        events = parse_events({"id": 1, "gameDate": "2024-01-01", "gameType": 2, "plays": plays}, header)
        segs = build_segments(header, events)
        self.assertEqual(len(segs), 1)  # only the regulation PP; nothing from OT/SO plays
        self.assertEqual((segs[0].period, segs[0].start_t), (1, 305))  # PP opens at the faceoff, not the penalty

    def test_shootout_goal_does_not_crash_score_sync(self):
        plays = [
            play(1, "period-start", 5, "00:00", "1010", side="right", period_type="SO"),
            play(2, "goal", 5, "00:00", "0101", side="right", period_type="SO",
                 eventOwnerTeamId=HOME, scoringPlayerId=3, goalieInNetId=1, xCoord=77, yCoord=2,
                 homeScore=2, awayScore=2),
        ]
        header = parse.GameHeader(game_id=1, date="2024-01-01", game_type=2,
                                   home_id=HOME, home_abbrev="HOM", away_id=AWAY, away_abbrev="AWY")
        events = parse_events({"id": 1, "gameDate": "2024-01-01", "gameType": 2, "plays": plays}, header)
        segs = build_segments(header, events)  # must not raise
        self.assertEqual(segs, [])


# ---------------------------------------------------------------------------
# Duplicate segment_id from a momentary situationCode flicker (coincidental
# penalties logged at the same instant) -- shaped from the real cached
# 2019030003 game at P1 18:25.
# ---------------------------------------------------------------------------
class TestSegmentDedup(unittest.TestCase):
    def _header(self):
        return parse.GameHeader(game_id=1, date="2024-01-01", game_type=2,
                                 home_id=HOME, home_abbrev="HOM", away_id=AWAY, away_abbrev="AWY")

    def _events(self, plays):
        return parse_events({"id": 1, "gameDate": "2024-01-01", "gameType": 2, "plays": plays}, self._header())

    def test_happy_path_no_collision_has_no_suffix(self):
        segs = build_segments(self._header(), self._events([
            play(1, "faceoff", 1, "00:00", "1551", eventOwnerTeamId=HOME, winningPlayerId=101, losingPlayerId=201),
            play(2, "penalty", 1, "05:00", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=202,
                 typeCode="MIN", duration=2),
            play(3, "faceoff", 1, "05:05", "1451", eventOwnerTeamId=HOME, winningPlayerId=101, losingPlayerId=201),
        ]))
        self.assertEqual(segs[0].seq, 0)
        self.assertEqual(scenarios.segment_id(segs[0].to_dict()), "1-p1-0305")

    def test_flicker_then_real_segment_keeps_only_real_one(self):
        # Two coincidental-minor penalties at the same instant: situationCode
        # flickers even -> PP -> even -> PP again, all logged at t=18:25,
        # and the second PP carries into period 2 (as in the real bug).
        segs = build_segments(self._header(), self._events([
            play(1, "penalty", 1, "18:25", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=1),
            play(2, "penalty", 1, "18:25", "1451", eventOwnerTeamId=HOME, committedByPlayerId=2),
            play(3, "penalty", 1, "18:25", "1441", eventOwnerTeamId=AWAY, committedByPlayerId=3),
            play(4, "faceoff", 1, "18:25", "1451", eventOwnerTeamId=HOME, winningPlayerId=4, losingPlayerId=5),
            play(5, "faceoff", 2, "00:00", "1451", eventOwnerTeamId=HOME, winningPlayerId=6, losingPlayerId=7),
        ]))
        at_1105 = [s for s in segs if s.period == 1 and s.start_t == 1105]
        self.assertEqual(len(at_1105), 1)
        self.assertEqual(at_1105[0].outcome, OUTCOME_CARRIED)
        self.assertEqual(scenarios.segment_id(at_1105[0].to_dict()), "1-p1-1105")

    def test_multiple_consecutive_flickers_still_keep_only_the_real_one(self):
        # start_t only ever advances within a period, so every flicker
        # revisiting a given key must be part of one contiguous same-instant
        # run; this checks the dedup holds for more than a single flicker.
        segs = build_segments(self._header(), self._events([
            play(1, "penalty", 1, "18:25", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=1),
            play(2, "penalty", 1, "18:25", "1451", eventOwnerTeamId=HOME, committedByPlayerId=2),
            play(3, "penalty", 1, "18:25", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=3),
            play(4, "penalty", 1, "18:25", "1451", eventOwnerTeamId=HOME, committedByPlayerId=4),
            play(5, "penalty", 1, "18:25", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=5),
            play(6, "faceoff", 1, "18:25", "1451", eventOwnerTeamId=HOME, winningPlayerId=6, losingPlayerId=7),
            play(7, "faceoff", 2, "00:00", "1451", eventOwnerTeamId=HOME, winningPlayerId=8, losingPlayerId=9),
        ]))
        at_1105 = [s for s in segs if s.period == 1 and s.start_t == 1105]
        self.assertEqual(len(at_1105), 1)
        self.assertEqual(at_1105[0].outcome, OUTCOME_CARRIED)

    def test_lone_zero_length_segment_with_no_collision_is_kept(self):
        # PP opens right as the recorded play-by-play simply ends: no other
        # segment claims this (period, start_t) slot, so it is real state, kept as-is.
        segs = build_segments(self._header(), self._events([
            play(1, "penalty", 1, "19:58", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=1),
            play(2, "faceoff", 1, "19:58", "1451", eventOwnerTeamId=HOME, winningPlayerId=4, losingPlayerId=5),
        ]))
        self.assertEqual(len(segs), 1)
        self.assertEqual((segs[0].start_t, segs[0].end_t, segs[0].outcome), (1198, 1198, OUTCOME_NO_GOAL))

    def test_two_distinct_real_segments_sharing_a_key_get_disambiguated(self):
        # Contrived but must not corrupt data: force two non-zero-length,
        # different-outcome segments to share (period, start_t) directly.
        from pipeline.segments import PpSegment
        segs_in = [
            PpSegment(game_id=1, game_type=2, date="2024-01-01", pp_team_id=HOME, pk_team_id=AWAY,
                      pp_is_home=True, period=1, start_t=100, end_t=160, strength="5v4",
                      pp_score=0, pk_score=0, pp_remaining_s=60, penalty_event_id=None,
                      penalised_player_id=None, outcome=OUTCOME_NO_GOAL),
        ]
        ids = [scenarios.segment_id(s.to_dict()) for s in segs_in]
        # Simulate what build_segments' append() would do for a genuine second
        # real collision: assign the next seq and recompute the id.
        segs_in[0].seq = 0
        dup = PpSegment(game_id=1, game_type=2, date="2024-01-01", pp_team_id=AWAY, pk_team_id=HOME,
                        pp_is_home=False, period=1, start_t=100, end_t=140, strength="5v4",
                        pp_score=0, pk_score=0, pp_remaining_s=40, penalty_event_id=None,
                        penalised_player_id=None, outcome=OUTCOME_GOAL, seq=1)
        self.assertEqual(scenarios.segment_id(segs_in[0].to_dict()), "1-p1-0100")
        self.assertEqual(scenarios.segment_id(dup.to_dict()), "1-p1-0100-d1")
        self.assertNotEqual(scenarios.segment_id(segs_in[0].to_dict()), scenarios.segment_id(dup.to_dict()))

    def test_zero_length_goal_outcome_is_never_dropped(self):
        # A goal scored off the opening faceoff of a PP: the segment opens and
        # closes in the same instant, but a real goal happened, so it is kept.
        segs = build_segments(self._header(), self._events([
            play(1, "penalty", 1, "10:00", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=1),
            play(2, "faceoff", 1, "10:00", "1451", eventOwnerTeamId=HOME, winningPlayerId=2, losingPlayerId=3),
            play(3, "goal", 1, "10:00", "1451", eventOwnerTeamId=HOME, scoringPlayerId=2,
                 goalieInNetId=3, shotType="wrist", xCoord=80, yCoord=0, homeScore=1, awayScore=0),
        ]))
        self.assertEqual(len(segs), 1)
        self.assertEqual((segs[0].start_t, segs[0].end_t, segs[0].outcome), (600, 600, OUTCOME_GOAL))


# ---------------------------------------------------------------------------
# _game_ids must skip never-played games (gameStateId == 1), shaped from the
# real cached games_for_season response (gameStateId field confirmed present).
# ---------------------------------------------------------------------------
class _GamesFakeClient:
    def __init__(self, rows):
        self.rows = rows  # list of row dicts, as returned regardless of season/type

    def games_for_season(self, season, game_type):
        return {"data": self.rows}


class TestGameFilter(unittest.TestCase):
    def test_final_games_are_included(self):
        from pipeline.build import _game_ids
        client = _GamesFakeClient([{"id": 1, "gameStateId": 7}, {"id": 2, "gameStateId": 7}])
        self.assertEqual(_game_ids(client, ["20232024"], [2]), [1, 2])

    def test_not_played_games_are_excluded(self):
        from pipeline.build import _game_ids
        client = _GamesFakeClient([{"id": 1, "gameStateId": 7}, {"id": 2, "gameStateId": 1}])
        self.assertEqual(_game_ids(client, ["20232024"], [2]), [1])

    def test_missing_gamestateid_is_included_not_dropped(self):
        from pipeline.build import _game_ids
        client = _GamesFakeClient([{"id": 1}])
        self.assertEqual(_game_ids(client, ["20232024"], [2]), [1])

    def test_dedupes_across_season_type_combinations(self):
        from pipeline.build import _game_ids

        class MultiFakeClient:
            def games_for_season(self, season, game_type):
                return {"data": [{"id": 1, "gameStateId": 7}]}
        self.assertEqual(_game_ids(MultiFakeClient(), ["20232024", "20242025"], [2, 3]), [1])

    def test_empty_data_list_does_not_crash(self):
        from pipeline.build import _game_ids
        client = _GamesFakeClient([])
        self.assertEqual(_game_ids(client, ["20232024"], [2]), [])

    def test_mixed_states_filtered_and_sorted(self):
        from pipeline.build import _game_ids
        client = _GamesFakeClient([{"id": 30, "gameStateId": 1}, {"id": 10, "gameStateId": 7},
                                    {"id": 20}, {"id": 40, "gameStateId": 1}])
        self.assertEqual(_game_ids(client, ["20232024"], [2]), [10, 20])


# ---------------------------------------------------------------------------
# cmd_probe always re-checks a known old-era game (config.PROBE_LEGACY_GAME_ID)
# in addition to whatever --game-id was passed.
# ---------------------------------------------------------------------------
class _ProbeFakeClient:
    def __init__(self, pbps, fail_ids=frozenset()):
        self.pbps = pbps
        self.fail_ids = fail_ids
        self.pbp_calls: list[int] = []

    def pbp(self, game_id):
        self.pbp_calls.append(game_id)
        if game_id in self.fail_ids:
            raise FetchError(f"simulated fetch failure for {game_id}")
        return self.pbps[game_id]

    def shifts(self, game_id):
        return {"data": [{"playerId": 101, "teamId": HOME, "period": 1, "startTime": "00:00",
                          "endTime": "01:00"}]}

    def score_by_date(self, on_date):
        gid = next(iter(self.pbps))
        return {"games": [{"id": gid, "homeTeam": {"abbrev": "HOM"}, "awayTeam": {"abbrev": "AWY"}}]}

    def games_for_season(self, season, game_type):
        return {"data": [{"id": 1, "gameStateId": 7}]}


def _probe_pbp(game_id):
    return {
        "id": game_id, "gameDate": "2024-01-01", "gameType": 2,
        "homeTeam": {"id": HOME, "abbrev": "HOM"}, "awayTeam": {"id": AWAY, "abbrev": "AWY"},
        "plays": [play(1, "faceoff", 1, "00:00", "1551", eventOwnerTeamId=HOME,
                       winningPlayerId=101, losingPlayerId=201)],
        "rosterSpots": [{"playerId": 101, "teamId": HOME, "firstName": {"default": "F"},
                         "lastName": {"default": "L"}, "sweaterNumber": 1, "positionCode": "C"}],
    }


class TestProbeLegacy(unittest.TestCase):
    def test_primary_and_legacy_both_ok(self):
        from pipeline import build
        client = _ProbeFakeClient({2023020001: _probe_pbp(2023020001), config.PROBE_LEGACY_GAME_ID: _probe_pbp(config.PROBE_LEGACY_GAME_ID)})
        self.assertEqual(build.cmd_probe(client, 2023020001, "2024-01-01"), 0)
        self.assertIn(config.PROBE_LEGACY_GAME_ID, client.pbp_calls)  # legacy game was actually checked

    def test_legacy_fetch_failure_fails_probe(self):
        from pipeline import build
        client = _ProbeFakeClient({2023020001: _probe_pbp(2023020001), config.PROBE_LEGACY_GAME_ID: _probe_pbp(config.PROBE_LEGACY_GAME_ID)},
                                   fail_ids={config.PROBE_LEGACY_GAME_ID})
        self.assertEqual(build.cmd_probe(client, 2023020001, "2024-01-01"), 1)

    def test_requesting_the_legacy_game_id_checks_it_only_once(self):
        from pipeline import build
        client = _ProbeFakeClient({config.PROBE_LEGACY_GAME_ID: _probe_pbp(config.PROBE_LEGACY_GAME_ID)})
        self.assertEqual(build.cmd_probe(client, config.PROBE_LEGACY_GAME_ID, "2016-04-14"), 0)
        self.assertEqual(client.pbp_calls.count(config.PROBE_LEGACY_GAME_ID), 1)

    def test_primary_parse_failure_fails_probe_even_if_legacy_ok(self):
        from pipeline import build
        bad_primary = _probe_pbp(2023020001)
        bad_primary["plays"][0]["situationCode"] = "2551"  # malformed, not shootout-shaped
        client = _ProbeFakeClient({2023020001: bad_primary, config.PROBE_LEGACY_GAME_ID: _probe_pbp(config.PROBE_LEGACY_GAME_ID)})
        self.assertEqual(build.cmd_probe(client, 2023020001, "2024-01-01"), 1)

    def test_unresolved_side_count_is_printed(self):
        from pipeline import build
        pbp = _probe_pbp(2023020001)
        pbp["plays"].append(play(2, "shot-on-goal", 1, "01:00", "1551", side=None, eventOwnerTeamId=HOME,
                                 zoneCode="N", shootingPlayerId=101, goalieInNetId=299, xCoord=70, yCoord=0))
        client = _ProbeFakeClient({2023020001: pbp, config.PROBE_LEGACY_GAME_ID: _probe_pbp(config.PROBE_LEGACY_GAME_ID)})
        buf = io.StringIO()
        import contextlib
        with contextlib.redirect_stdout(buf):
            build.cmd_probe(client, 2023020001, "2024-01-01")
        self.assertIn("1 event(s) had no resolvable homeTeamDefendingSide", buf.getvalue())


# ---------------------------------------------------------------------------
# cmd_ingest must record ANY per-game exception (including sqlite3.IntegrityError
# from a segment_id collision) as a logged failure rather than aborting the run.
# ---------------------------------------------------------------------------
def _mini_pbp(game_id, date):
    plays = [
        play(1, "faceoff", 1, "00:00", "1551", eventOwnerTeamId=HOME, winningPlayerId=101, losingPlayerId=201),
        play(2, "penalty", 1, "05:00", "1551", eventOwnerTeamId=AWAY, committedByPlayerId=202,
             typeCode="MIN", duration=2),
        play(3, "faceoff", 1, "05:05", "1451", eventOwnerTeamId=HOME, winningPlayerId=101, losingPlayerId=201),
        play(4, "goal", 1, "06:00", "1451", eventOwnerTeamId=HOME, scoringPlayerId=102, goalieInNetId=299,
             shotType="wrist", xCoord=75, yCoord=3, homeScore=1, awayScore=0),
    ]
    roster = [{"playerId": pid, "teamId": tid, "firstName": {"default": "F"}, "lastName": {"default": last},
               "sweaterNumber": pid % 100, "positionCode": pos}
              for pid, tid, last, pos in [(101, HOME, "Centre", "C"), (102, HOME, "Sniper", "R"),
                                          (201, AWAY, "Awayc", "C"), (202, AWAY, "Penalized", "D"),
                                          (299, AWAY, "Awaygoalie", "G")]]
    return {"id": game_id, "gameDate": date, "gameType": 2,
            "homeTeam": {"id": HOME, "abbrev": "HOM"}, "awayTeam": {"id": AWAY, "abbrev": "AWY"},
            "plays": plays, "rosterSpots": roster}


class _TwoGameClient:
    def __init__(self):
        self.pbps = {2023020001: _mini_pbp(2023020001, "2024-01-01"), 2023020002: _mini_pbp(2023020002, "2024-01-02")}

    def games_for_season(self, season, game_type):
        return {"data": [{"id": 2023020001, "gameStateId": 7}, {"id": 2023020002, "gameStateId": 7}]}

    def pbp(self, game_id):
        return self.pbps[game_id]

    def shifts(self, game_id):
        raise FetchError("no shift fixture for this test")


class TestIngestResilience(unittest.TestCase):
    def test_integrity_error_on_one_game_does_not_abort_the_run(self):
        from unittest.mock import patch
        from pipeline import build
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "data").mkdir(parents=True, exist_ok=True)
            conn = build.connect(d / "t.db")
            client = _TwoGameClient()
            try:
                # Force both games' single segment to compute the same segment_id,
                # so the second game's plain INSERT collides on the TEXT PRIMARY KEY.
                with patch.object(config, "ROOT", d), patch("pipeline.scenarios.segment_id", return_value="forced-id"):
                    rc = build.cmd_ingest(client, conn, ["20232024"], [2])
                self.assertEqual(rc, 2)  # some games failed, but the run completed
                remaining = [r[0] for r in conn.execute("SELECT game_id FROM games ORDER BY game_id")]
                self.assertEqual(remaining, [2023020001])  # game 2's whole transaction rolled back
                log_text = (d / "data" / "ingest_failures.log").read_text(encoding="utf-8")
                self.assertIn("2023020002", log_text)
                self.assertIn("IntegrityError", log_text)
            finally:
                conn.close()

    def test_both_games_succeed_when_ids_do_not_collide(self):
        from pipeline import build
        with tempfile.TemporaryDirectory() as d:
            conn = build.connect(Path(d) / "t.db")
            client = _TwoGameClient()
            rc = build.cmd_ingest(client, conn, ["20232024"], [2])
            self.assertEqual(rc, 0)
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM games").fetchone()[0], 2)
            conn.close()
