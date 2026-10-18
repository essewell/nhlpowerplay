"""Penalty-box replay, restart-faceoff strength and the DATA_STATUS regression cases.

Run from data-pipeline/:  python -m unittest discover -s pipeline/tests -t .

Plays are SYNTHETIC. The three regression fixtures copy only the event
sequence of the real cached games (event kinds, clock, situationCode,
typeCode/duration, which side committed) with made-up player ids.
"""
from __future__ import annotations

import unittest

from pipeline import config, parse, penalty_box
from pipeline.parse import parse_events
from pipeline.penalty_box import PenaltyError, PenaltyReplay, abs_time, classify
from pipeline.segments import STRENGTH_FROM_FACEOFF, STRENGTH_FROM_OPENER, build_segments, restart_event
from pipeline.tests.test_pipeline import AWAY, HOME, play

HEADER = parse.GameHeader(game_id=2023030111, date="2024-04-20", game_type=3,
                          home_id=HOME, home_abbrev="HOM", away_id=AWAY, away_abbrev="AWY")


def events(plays):
    return parse_events({"id": HEADER.game_id, "plays": plays}, HEADER)


def pen(eid, period, t, team, player, code="MIN", minutes=2, sit="1551", desc="tripping", **kw):
    return play(eid, "penalty", period, t, sit, eventOwnerTeamId=team, committedByPlayerId=player,
                typeCode=code, duration=minutes, descKey=desc, **kw)


def goal(eid, period, t, team, sit):
    return play(eid, "goal", period, t, sit, eventOwnerTeamId=team, scoringPlayerId=1, goalieInNetId=2,
                xCoord=80, yCoord=0, homeScore=0, awayScore=0)


def fo(eid, period, t, sit):
    return play(eid, "faceoff", period, t, sit, eventOwnerTeamId=HOME, winningPlayerId=1, losingPlayerId=2)


def snap(plays, period, t, pp_team=HOME):
    return PenaltyReplay(events(plays), HEADER).at(period, t, pp_team)


class TestAbsTimeAndClassify(unittest.TestCase):
    def test_abs_time(self):
        self.assertEqual(abs_time(1, 0), 0)
        self.assertEqual(abs_time(2, 5), config.PERIOD_LENGTH_S + 5)
        self.assertEqual(abs_time(4, 175), 3 * config.PERIOD_LENGTH_S + 175)

    def test_classify_every_table_entry(self):
        for (code, minutes), kind in config.PENALTY_KIND_BY_CODE.items():
            ev = events([pen(1, 1, "05:00", AWAY, 7, code=code, minutes=minutes)])[0]
            with self.subTest(code=code, minutes=minutes):
                self.assertEqual(classify(ev), kind)

    def test_minutes_mapping(self):
        self.assertEqual(config.PENALTY_KIND_BY_MINUTES, {2: "minor", 4: "double_minor", 5: "major"})
        self.assertEqual(config.PENALTY_DURATION_S, {"minor": 120, "double_minor": 240, "major": 300})

    def test_unknown_code_raises(self):
        ev = events([pen(1, 1, "05:00", AWAY, 7, code="MIN", minutes=5)])[0]
        with self.assertRaises(PenaltyError):
            classify(ev)

    def test_missing_code_raises(self):
        ev = events([play(1, "penalty", 1, "05:00", "1551", eventOwnerTeamId=AWAY)])[0]
        with self.assertRaises(PenaltyError):
            classify(ev)

    def test_penalty_error_is_a_parse_error(self):
        self.assertTrue(issubclass(PenaltyError, parse.ParseError))  # existing except clauses catch it


class TestReplayConstruction(unittest.TestCase):
    def test_unknown_codes_are_all_listed(self):
        with self.assertRaises(PenaltyError) as cm:
            PenaltyReplay(events([pen(1, 1, "01:00", AWAY, 7, code="XYZ", minutes=3, desc="new-thing"),
                                  pen(2, 1, "02:00", HOME, 8, code="MIN", minutes=7, desc="odd")]), HEADER)
        msg = str(cm.exception)
        self.assertIn("XYZ", msg)
        self.assertIn("new-thing", msg)
        self.assertIn("odd", msg)

    def test_penalty_without_team_raises(self):
        with self.assertRaises(PenaltyError):
            PenaltyReplay(events([play(1, "penalty", 1, "01:00", "1551", committedByPlayerId=7,
                                       typeCode="MIN", duration=2)]), HEADER)

    def test_penalty_for_foreign_team_raises(self):
        with self.assertRaises(PenaltyError):
            PenaltyReplay(events([pen(1, 1, "01:00", 99, 7)]), HEADER)

    def test_no_penalties_no_advantage(self):
        s = snap([fo(1, 1, "00:00", "1551")], 1, 30)
        self.assertEqual((s.penalties, s.advantage_end_abs), ([], None))

    def test_unknown_pp_team_raises(self):
        with self.assertRaises(PenaltyError):
            snap([], 1, 0, pp_team=99)

    def test_deterministic(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:30", AWAY, 8, code="MAJ", minutes=5)]
        a = snap(plays, 1, 400)
        b = snap(plays, 1, 400)
        self.assertEqual(a, b)


class TestReplayRules(unittest.TestCase):
    def test_happy_path_minor(self):
        s = snap([pen(1, 1, "05:00", AWAY, 7)], 1, 305)
        self.assertEqual(s.penalties, [{"side": "pk", "player_id": 7, "kind": "minor", "remaining_s": 115,
                                        "queued": False}])
        self.assertEqual(s.advantage_end_abs, 420)

    def test_expired_penalty_gone(self):
        s = snap([pen(1, 1, "05:00", AWAY, 7)], 1, 420)
        self.assertEqual((s.penalties, s.advantage_end_abs), ([], None))

    def test_misconduct_game_misconduct_penalty_shot_put_no_man_down(self):
        for code, minutes in (("MIS", 10), ("GAM", 10), ("PS", 0)):
            with self.subTest(code=code):
                s = snap([pen(1, 1, "05:00", AWAY, 7, code=code, minutes=minutes)], 1, 301)
                self.assertEqual((s.penalties, s.advantage_end_abs), ([], None))

    def test_major_plus_game_misconduct_is_one_major(self):
        plays = [pen(1, 3, "09:13", AWAY, 7, code="MAJ", minutes=5),
                 pen(2, 3, "09:13", AWAY, 7, code="GAM", minutes=10)]
        s = snap(plays, 3, 553)
        self.assertEqual([(p["kind"], p["remaining_s"]) for p in s.penalties], [("major", 300)])
        self.assertEqual(s.advantage_end_abs - abs_time(3, 553), 300)

    def test_coincidental_minors_are_served_four_on_four(self):
        # NHL Rule 19.1: one minor each, nothing else running -> served without substitution (4v4).
        s = snap([pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", HOME, 8)], 1, 301)
        self.assertEqual([(p["side"], p["player_id"], p["remaining_s"], p["coincidental"]) for p in s.penalties],
                         [("pk", 7, 119, True), ("pp", 8, 119, True)])
        self.assertIsNone(s.advantage_end_abs)  # equal skaters down: no advantage

    def test_coincidental_cancel_leaves_the_extra_minor(self):
        s = snap([pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", HOME, 8), pen(3, 1, "05:00", AWAY, 9)], 1, 301)
        self.assertEqual([p["player_id"] for p in s.penalties], [9])
        self.assertEqual(s.advantage_end_abs, 420)

    def test_coincidental_majors_cancel(self):
        plays = [pen(1, 1, "05:00", AWAY, 7, code="MAJ", minutes=5, desc="fighting"),
                 pen(2, 1, "05:00", HOME, 8, code="MAJ", minutes=5, desc="fighting")]
        self.assertEqual(snap(plays, 1, 301).penalties, [])  # Rule 19.2: substitutes, nobody short

    def test_minors_at_different_times_do_not_cancel(self):
        s = snap([pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:01", HOME, 8)], 1, 302)
        self.assertEqual(len(s.penalties), 2)
        self.assertIsNone(s.advantage_end_abs)  # 4v4: no advantage

    def test_two_active_third_queued_then_starts(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:10", AWAY, 8), pen(3, 1, "05:20", AWAY, 9)]
        s = snap(plays, 1, 330)
        self.assertEqual([(p["player_id"], p["queued"], p["remaining_s"]) for p in s.penalties],
                         [(7, False, 90), (8, False, 100), (9, True, 120)])
        later = snap(plays, 1, 425)  # 7 ended at 420 and queued 9 started then; 8 runs to 430
        self.assertEqual([(p["player_id"], p["queued"], p["remaining_s"]) for p in later.penalties],
                         [(8, False, 5), (9, False, 115)])
        # still a PP after 8 ends at 430 (9 runs to 540), so the advantage ends at 540
        self.assertEqual(snap(plays, 1, 330).advantage_end_abs, 540)

    def test_same_player_penalties_served_back_to_back(self):
        plays = [pen(1, 1, "05:00", AWAY, 7, desc="roughing"), pen(2, 1, "05:00", AWAY, 7, desc="unsportsmanlike")]
        s = snap(plays, 1, 300)
        self.assertEqual([(p["queued"], p["remaining_s"]) for p in s.penalties], [(False, 120), (True, 120)])
        self.assertEqual(s.advantage_end_abs, 300 + 240)  # one man down for 4 minutes, never 5v3

    def test_major_served_before_minor_for_same_player(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", AWAY, 7, code="MAJ", minutes=5)]
        s = snap(plays, 1, 300)
        self.assertEqual([p["kind"] for p in s.penalties], ["major", "minor"])
        self.assertFalse(s.penalties[0]["queued"])

    def test_pp_goal_releases_earliest_minor(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:30", AWAY, 8), goal(3, 1, "06:00", HOME, "1351")]
        s = snap(plays, 1, 360)
        self.assertEqual([p["player_id"] for p in s.penalties], [8])

    def test_pp_goal_halves_double_minor(self):
        plays = [pen(1, 1, "05:00", AWAY, 7, minutes=4, desc="high-sticking-double-minor"),
                 goal(2, 1, "05:30", HOME, "1451")]
        s = snap(plays, 1, 330)
        self.assertEqual([(p["kind"], p["remaining_s"]) for p in s.penalties], [("double_minor", 120)])
        # second PP goal inside the last 120 s releases it
        s2 = snap(plays + [goal(3, 1, "06:00", HOME, "1451")], 1, 360)
        self.assertEqual(s2.penalties, [])

    def test_pp_goal_in_second_half_of_double_minor_releases(self):
        plays = [pen(1, 1, "05:00", AWAY, 7, minutes=4), goal(2, 1, "07:30", HOME, "1451")]
        self.assertEqual(snap(plays, 1, 451).penalties, [])

    def test_pp_goal_never_releases_major(self):
        plays = [pen(1, 1, "05:00", AWAY, 7, code="MAJ", minutes=5), goal(2, 1, "06:00", HOME, "1451")]
        s = snap(plays, 1, 360)
        self.assertEqual([(p["kind"], p["remaining_s"]) for p in s.penalties], [("major", 240)])

    def test_short_handed_goal_releases_nothing(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), goal(2, 1, "06:00", AWAY, "1451")]
        self.assertEqual(len(snap(plays, 1, 360).penalties), 1)

    def test_goal_without_situation_uses_box_counts(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), goal(2, 1, "06:00", HOME, None)]
        plays[1].pop("situationCode", None)
        self.assertEqual(snap(plays, 1, 360).penalties, [])

    def test_even_strength_goal_releases_nothing(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:10", HOME, 8), goal(3, 1, "06:00", HOME, "1441")]
        self.assertEqual(len(snap(plays, 1, 360).penalties), 2)

    def test_queued_starts_when_goal_releases(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", AWAY, 8), pen(3, 1, "05:00", AWAY, 9),
                 goal(4, 1, "06:00", HOME, "1351")]
        s = snap(plays, 1, 360)
        nine = next(p for p in s.penalties if p["player_id"] == 9)
        self.assertEqual((nine["queued"], nine["remaining_s"]), (False, 120))

    def test_sides_are_relative_to_pp_team(self):
        plays = [pen(1, 1, "05:00", AWAY, 7)]
        self.assertEqual(snap(plays, 1, 300, pp_team=HOME).penalties[0]["side"], "pk")
        self.assertEqual(snap(plays, 1, 300, pp_team=AWAY).penalties[0]["side"], "pp")
        self.assertIsNone(snap(plays, 1, 300, pp_team=AWAY).advantage_end_abs)

    def test_bench_minor_uses_served_by(self):
        p = play(1, "penalty", 1, "05:00", "1551", eventOwnerTeamId=AWAY, servedByPlayerId=55,
                 typeCode="BEN", duration=2, descKey="too-many-men-on-the-ice")
        self.assertEqual(snap([p], 1, 300).penalties[0]["player_id"], 55)

    def test_penalty_carries_across_periods(self):
        s = snap([pen(1, 1, "19:30", AWAY, 7)], 2, 0)
        self.assertEqual(s.penalties[0]["remaining_s"], 90)
        self.assertEqual(s.advantage_end_abs, abs_time(2, 90))

    def test_events_after_query_ignored(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), goal(2, 1, "06:00", HOME, "1451")]
        self.assertEqual(len(snap(plays, 1, 330).penalties), 1)


# ---------------------------------------------------------------------------
# Restart faceoff
# ---------------------------------------------------------------------------
class TestRestartEvent(unittest.TestCase):
    def test_happy_path_penalty_then_faceoff(self):
        ev = events([pen(1, 1, "05:00", AWAY, 7, sit="1451"), fo(2, 1, "05:00", "1451")])
        self.assertIs(restart_event(ev, 0, True), ev[1])

    def test_opener_is_the_faceoff(self):
        ev = events([fo(1, 1, "05:00", "1451")])
        self.assertIs(restart_event(ev, 0, True), ev[0])

    def test_live_opener_has_no_restart(self):
        ev = events([play(1, "shot-on-goal", 1, "05:00", "1451", eventOwnerTeamId=HOME), fo(2, 1, "05:30", "1451")])
        self.assertIsNone(restart_event(ev, 0, True))

    def test_walks_through_dead_puck_events(self):
        ev = events([pen(1, 1, "05:00", AWAY, 7, sit="1560"), play(2, "stoppage", 1, "05:00", "1460"),
                     play(3, "delayed-penalty", 1, "05:00", "1460"), fo(4, 1, "05:00", "1451")])
        self.assertIs(restart_event(ev, 1, True), ev[3])

    def test_faceoff_without_pp_returns_none(self):
        ev = events([pen(1, 1, "05:00", AWAY, 7, sit="1451"), fo(2, 1, "05:00", "1551")])
        self.assertIsNone(restart_event(ev, 0, True))

    def test_period_change_returns_none(self):
        ev = events([pen(1, 1, "20:00", AWAY, 7, sit="1451"), fo(2, 2, "00:00", "1451")])
        self.assertIsNone(restart_event(ev, 0, True))

    def test_late_logged_earlier_event_is_skipped(self):
        ev = events([play(1, "stoppage", 1, "10:47", "1451"),
                     play(2, "blocked-shot", 1, "10:43", "1551", eventOwnerTeamId=AWAY),
                     fo(3, 1, "10:47", "1451")])
        self.assertIs(restart_event(ev, 0, True), ev[2])

    def test_end_of_events_returns_none(self):
        ev = events([pen(1, 1, "19:58", AWAY, 7, sit="1451")])
        self.assertIsNone(restart_event(ev, 0, True))


# ---------------------------------------------------------------------------
# Regression fixtures from DATA_STATUS "NEW 2026-10-18: loader findings"
# ---------------------------------------------------------------------------
def _seg_at(plays, period, t):
    segs = build_segments(HEADER, events(plays))
    return next(s for s in segs if s.period == period and s.start_t == t)


class TestDataStatusRegressions(unittest.TestCase):
    def test_5on3_strength_from_restart_faceoff(self):
        # 2016030411 P1 13:50: penalty 1560 -> penalty 1451 -> faceoff 1351 (two PK minors).
        plays = [play(1, "hit", 1, "13:42", "1560", eventOwnerTeamId=AWAY),
                 pen(2, 1, "13:50", AWAY, 7, sit="1560", desc="interference"),
                 pen(3, 1, "13:50", AWAY, 8, sit="1451", desc="cross-checking"),
                 fo(4, 1, "13:50", "1351")]
        s = _seg_at(plays, 1, 830)
        self.assertEqual((s.strength, s.goalie_pulled, s.strength_source), ("5v3", False, STRENGTH_FROM_FACEOFF))
        self.assertEqual(s.pp_remaining_s, 120)
        self.assertEqual([p["kind"] for p in s.penalties], ["minor", "minor"])

    def test_delayed_call_pulled_goalie_not_kept(self):
        # 2021030147 OT 2:55: penalty 1560 (PP goalie pulled on the delayed call) -> stoppage 1460 -> faceoff 1451.
        plays = [play(1, "missed-shot", 4, "02:41", "1551", eventOwnerTeamId=HOME),
                 pen(2, 4, "02:55", AWAY, 7, sit="1560", desc="holding"),
                 play(3, "stoppage", 4, "02:55", "1460"),
                 fo(4, 4, "02:55", "1451"),
                 play(5, "shot-on-goal", 4, "02:58", "1451", eventOwnerTeamId=HOME)]
        s = _seg_at(plays, 4, 175)
        self.assertEqual((s.strength, s.goalie_pulled), ("5v4", False))
        self.assertEqual(s.pp_remaining_s, 120)

    def test_major_with_game_misconduct_is_300s_and_survives_goal(self):
        # 2018030187 P3 9:13: MAJ 5 + GAM 10 to the same player, restart 1451, PP goal 9:20.
        plays = [pen(1, 3, "09:13", AWAY, 7, code="MAJ", minutes=5, desc="cross-checking"),
                 pen(2, 3, "09:13", AWAY, 7, code="GAM", minutes=10, desc="game-misconduct"),
                 play(3, "stoppage", 3, "09:13", "1551"),
                 fo(4, 3, "09:13", "1451"),
                 goal(5, 3, "09:20", HOME, "1451"),
                 fo(6, 3, "09:20", "1451")]
        segs = build_segments(HEADER, events(plays))
        first = next(s for s in segs if s.start_t == 553)
        self.assertEqual((first.strength, first.pp_remaining_s), ("5v4", 300))
        self.assertEqual([(p["kind"], p["remaining_s"]) for p in first.penalties], [("major", 300)])
        after_goal = next(s for s in segs if s.start_t == 560)
        self.assertEqual(after_goal.pp_remaining_s, 293)  # the major keeps running after the goal

    def test_live_play_opener_falls_back_explicitly(self):
        # The situationCode first shows the PP on a live-play shot: no restart faceoff, strength from the opener.
        plays = [fo(1, 1, "05:00", "1551"),
                 play(2, "shot-on-goal", 1, "07:00", "1451", eventOwnerTeamId=HOME)]
        with self.assertLogs("pipeline.segments", level="INFO") as logs:
            segs = build_segments(HEADER, events(plays))
        s = next(x for x in segs if x.start_t == 420)
        self.assertEqual(s.strength_source, STRENGTH_FROM_OPENER)
        self.assertIn("no restart faceoff", "\n".join(logs.output))


# ---------------------------------------------------------------------------
# Rule 19 coincidental penalties and Rule 16.2 release choice
# ---------------------------------------------------------------------------
def rows(s):
    return [(p["side"], p["player_id"], p["kind"], p["remaining_s"], p["queued"], p.get("coincidental", False))
            for p in s.penalties]


class TestCoincidentalRule19(unittest.TestCase):
    def test_pair_expires_after_two_minutes(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", HOME, 8)]
        self.assertEqual(snap(plays, 1, 420).penalties, [])
        self.assertEqual(len(snap(plays, 1, 419).penalties), 2)

    def test_third_penalty_during_pair_gives_advantage_to_its_own_end(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", HOME, 8), pen(3, 1, "05:30", AWAY, 9)]
        s = snap(plays, 1, 330)
        self.assertEqual(rows(s), [("pk", 7, "minor", 90, False, True), ("pk", 9, "minor", 120, False, False),
                                   ("pp", 8, "minor", 90, False, True)])
        self.assertEqual(s.advantage_end_abs, 330 + 120)  # the new minor alone decides the end
        later = snap(plays, 1, 430)  # pair expired at 420; still a power play until 450
        self.assertEqual(rows(later), [("pk", 9, "minor", 20, False, False)])
        self.assertEqual(later.advantage_end_abs, 450)

    def test_third_penalty_to_the_other_team_swaps_the_advantage(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", HOME, 8), pen(3, 1, "05:30", HOME, 9)]
        self.assertEqual(snap(plays, 1, 330, pp_team=AWAY).advantage_end_abs, 450)
        self.assertIsNone(snap(plays, 1, 330, pp_team=HOME).advantage_end_abs)

    def test_pair_during_existing_pk_is_substituted(self):
        # AWAY already shorthanded 5:00-7:00; a pair at 6:00 is not 4v4: box unchanged.
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "06:00", AWAY, 8), pen(3, 1, "06:00", HOME, 9)]
        s = snap(plays, 1, 361)
        self.assertEqual([r[1] for r in rows(s)], [7])
        self.assertEqual(s.advantage_end_abs, 420)

    def test_second_pair_with_first_pair_still_on_clock_is_substituted(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", HOME, 8),
                 pen(3, 1, "05:30", AWAY, 9), pen(4, 1, "05:30", HOME, 10)]
        self.assertEqual([r[1] for r in rows(snap(plays, 1, 331))], [7, 8])

    def test_pair_plus_major_in_same_stoppage_is_not_four_on_four(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", HOME, 8),
                 pen(3, 1, "05:00", AWAY, 9, code="MAJ", minutes=5)]
        self.assertEqual(rows(snap(plays, 1, 301)), [("pk", 9, "major", 299, False, False)])

    def test_coincidental_double_minors_are_substituted(self):
        plays = [pen(1, 1, "05:00", AWAY, 7, minutes=4), pen(2, 1, "05:00", HOME, 8, minutes=4)]
        self.assertEqual(snap(plays, 1, 301).penalties, [])

    def test_two_minors_one_team_one_other_cancels_a_single_pair(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", AWAY, 9), pen(3, 1, "05:00", HOME, 8)]
        s = snap(plays, 1, 301)
        self.assertEqual([r[1] for r in rows(s)], [9])
        self.assertFalse(rows(s)[0][5])

    def test_pair_goal_at_equal_strength_releases_nothing(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", HOME, 8), goal(3, 1, "05:30", HOME, "1441")]
        self.assertEqual(len(snap(plays, 1, 331).penalties), 2)

    def test_goal_releases_the_later_minor_not_the_coincidental_one(self):
        # Rule 16.2 + Table 12 G4: A15 (coincidental) has the least time, yet A23 (3:30) returns.
        plays = [pen(1, 1, "03:00", AWAY, 15), pen(2, 1, "03:00", HOME, 12), pen(3, 1, "03:30", AWAY, 23),
                 goal(4, 1, "04:30", HOME, "1341")]
        s = snap(plays, 1, 271)
        self.assertEqual(rows(s), [("pk", 15, "minor", 29, False, True), ("pp", 12, "minor", 29, False, True)])
        self.assertIsNone(s.advantage_end_abs)

    def test_goal_without_situation_with_pair_only_uses_equal_counts(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", HOME, 8), goal(3, 1, "05:30", HOME, None)]
        self.assertEqual(len(snap(plays, 1, 331).penalties), 2)

    def test_pair_players_second_penalty_chains_without_new_seat(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", HOME, 8), pen(3, 1, "05:30", AWAY, 7)]
        s = snap(plays, 1, 331)
        self.assertEqual([(r[1], r[4]) for r in rows(s)], [(7, False), (7, True), (8, False)])
        self.assertIsNone(s.advantage_end_abs)  # same seat: still one man down each

    def test_cancel_function_direct(self):
        a = penalty_box.BoxPenalty(0, 1, AWAY, 7, "minor", 0)
        b = penalty_box.BoxPenalty(1, 2, HOME, 8, "minor", 0)
        out = penalty_box._cancel_coincidental([b, a], HEADER, True)
        self.assertEqual([(p.order, p.coincidental) for p in out], [(0, True), (1, True)])
        self.assertEqual(penalty_box._cancel_coincidental([a, b], HEADER, False), [])
        self.assertEqual(penalty_box._cancel_coincidental([a], HEADER, True), [a])
        c = penalty_box.BoxPenalty(2, 3, AWAY, 9, "minor", 0)
        self.assertEqual(penalty_box._cancel_coincidental([a, c], HEADER, True), [a, c])


class TestReleaseLeastTimeRule16_2(unittest.TestCase):
    def test_plain_minor_with_less_time_beats_earlier_double_minor(self):
        # double minor 5:00 (to 9:00), plain minor 6:00 (to 8:00); PP goal 7:30: the plain minor has 30 s left.
        plays = [pen(1, 1, "05:00", AWAY, 7, minutes=4), pen(2, 1, "06:00", AWAY, 8),
                 goal(3, 1, "07:30", HOME, "1351")]
        self.assertEqual(rows(snap(plays, 1, 451)), [("pk", 7, "double_minor", 89, False, False)])

    def test_double_minor_first_half_with_less_time_is_halved(self):
        # double 5:00 (to 9:00), plain 6:30 (to 8:30); goal 6:45: double's current minor has 15 s, plain 105 s.
        plays = [pen(1, 1, "05:00", AWAY, 7, minutes=4), pen(2, 1, "06:30", AWAY, 8),
                 goal(3, 1, "06:45", HOME, "1351")]
        self.assertEqual(rows(snap(plays, 1, 405)),
                         [("pk", 7, "double_minor", 120, False, False), ("pk", 8, "minor", 105, False, False)])

    def test_earlier_minor_released_when_it_has_less_time(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:30", AWAY, 8), goal(3, 1, "06:00", HOME, "1351")]
        self.assertEqual([r[1] for r in rows(snap(plays, 1, 360))], [8])

    def test_tie_on_clock_released_in_event_order(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", AWAY, 8), goal(3, 1, "06:00", HOME, "1351")]
        self.assertEqual([r[1] for r in rows(snap(plays, 1, 360))], [8])

    def test_major_and_minor_only_minor_released(self):
        plays = [pen(1, 1, "05:00", AWAY, 7, code="MAJ", minutes=5), pen(2, 1, "05:30", AWAY, 8),
                 goal(3, 1, "06:00", HOME, "1351")]
        self.assertEqual([(r[1], r[2]) for r in rows(snap(plays, 1, 360))], [(7, "major")])

    def test_expiry_in_the_goal_second_is_processed_before_the_release(self):
        # p7 ends at 7:00, the goal's own second; the goal then releases p8 (to 7:10), not p7.
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:10", AWAY, 8), goal(3, 1, "07:00", HOME, "1351")]
        self.assertEqual(snap(plays, 1, 420).penalties, [])


class TestGoalSituationCodeIsPreGoalState(unittest.TestCase):
    """Observed in the cached games: the code on a goal is the strength before the goal."""

    def test_pp_goal_ending_5v4_carries_5v4_and_releases(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), goal(2, 1, "06:00", HOME, "1451"), fo(3, 1, "06:00", "1551")]
        s = snap(plays, 1, 360)
        self.assertEqual((s.penalties, s.advantage_end_abs), ([], None))

    def test_even_code_after_natural_expiry_releases_nothing(self):
        # previous event 5v4, the first minor ended at 7:00, goal 7:10 carries 5v5: not a PP goal.
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "06:50", AWAY, 8), goal(3, 1, "07:10", HOME, "1551")]
        self.assertEqual([r[1] for r in rows(snap(plays, 1, 430))], [8])

    def test_short_handed_goal_carries_pk_code_releases_nothing(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), goal(2, 1, "06:00", AWAY, "1451"), fo(3, 1, "06:00", "1551")]
        self.assertEqual(len(snap(plays, 1, 360).penalties), 1)

    def test_even_code_on_goal_wins_over_box(self):
        # 2 of ~1300 cached goals: box says PP, the code says 5v5. The code is the recorded fact.
        plays = [pen(1, 1, "05:00", AWAY, 7), goal(2, 1, "06:00", HOME, "1551")]
        self.assertEqual(len(snap(plays, 1, 360).penalties), 1)

    def test_pp_goal_from_5v3_leaves_one_minor(self):
        plays = [pen(1, 1, "05:00", AWAY, 7), pen(2, 1, "05:00", AWAY, 8), goal(3, 1, "05:30", HOME, "1351")]
        s = snap(plays, 1, 330)
        self.assertEqual(len(s.penalties), 1)
        self.assertEqual(s.advantage_end_abs, 420)

    def test_extra_attacker_goal_is_not_a_pp_goal(self):
        # 6v5 with the scoring side's goalie out is not a power play: nothing released.
        plays = [pen(1, 1, "05:00", AWAY, 7), goal(2, 1, "06:00", HOME, "1550")]
        self.assertEqual(len(snap(plays, 1, 360).penalties), 1)


class TestRestartEventSituationless(unittest.TestCase):
    def test_faceoff_without_situation_returns_none_not_a_later_faceoff(self):
        ev = events([pen(1, 1, "05:00", AWAY, 7, sit="1451"),
                     play(2, "faceoff", 1, "05:00", None, eventOwnerTeamId=HOME, winningPlayerId=1, losingPlayerId=2),
                     fo(3, 1, "05:00", "1451")])
        self.assertIsNone(restart_event(ev, 0, True))

    def test_build_segments_falls_back_to_opener_and_logs(self):
        plays = [fo(1, 1, "04:00", "1551"), pen(2, 1, "05:00", AWAY, 7, sit="1451"),
                 play(3, "faceoff", 1, "05:00", None, eventOwnerTeamId=HOME, winningPlayerId=1, losingPlayerId=2),
                 play(4, "shot-on-goal", 1, "05:20", "1451", eventOwnerTeamId=HOME)]
        with self.assertLogs("pipeline.segments", level="INFO") as logs:
            segs = build_segments(HEADER, events(plays))
        s = next(x for x in segs if x.start_t == 300)
        self.assertEqual(s.strength_source, STRENGTH_FROM_OPENER)
        self.assertIn("no restart faceoff", "\n".join(logs.output))

    def test_situationless_faceoff_after_live_event_still_none(self):
        ev = events([play(1, "shot-on-goal", 1, "05:00", "1451", eventOwnerTeamId=HOME),
                     play(2, "faceoff", 1, "05:10", None, eventOwnerTeamId=HOME, winningPlayerId=1, losingPlayerId=2)])
        self.assertIsNone(restart_event(ev, 0, True))

    def test_early_stamped_faceoff_is_skipped_like_any_early_event(self):
        # documented behaviour: events stamped before the opener are skipped, faceoffs included.
        ev = events([play(1, "stoppage", 1, "16:21", "1451"), fo(2, 1, "16:19", "1451")])
        self.assertIsNone(restart_event(ev, 0, True))

    def test_faceoff_in_other_period_without_situation(self):
        ev = events([pen(1, 1, "20:00", AWAY, 7, sit="1451"),
                     play(2, "faceoff", 2, "00:00", None, eventOwnerTeamId=HOME, winningPlayerId=1, losingPlayerId=2)])
        self.assertIsNone(restart_event(ev, 0, True))

    def test_faceoff_with_situation_found_after_dead_events(self):
        ev = events([pen(1, 1, "05:00", AWAY, 7, sit="1560"), play(2, "stoppage", 1, "05:00", "1460"),
                     fo(3, 1, "05:00", "1451")])
        self.assertIs(restart_event(ev, 0, True), ev[2])


if __name__ == "__main__":
    unittest.main()
