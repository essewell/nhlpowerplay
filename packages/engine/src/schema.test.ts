/**
 * Run from repo root: node --test packages/engine/src/schema.test.ts.
 * SYNTHETIC data only: every id, name, team, number, rate and URL below is invented and is not
 * data about any real player, team or game.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Result } from "./result.ts";
import {
  EXPORT_FILES, isCalendarDate, parseBaseRates, parseEndlessIndex, parseFaceoffRatings, parseGoalieRatings,
  parsePlaymakerRatings, parseScenario, parseScenarioStrict, parseSchedule, parseShooterRatings, parseStrength,
  validateExportFile,
} from "./schema.ts";

function val<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(`expected ok, got error: ${r.error}`);
  return r.value;
}
function errOf<T>(r: Result<T>): string {
  if (r.ok) assert.fail(`expected error, got ${JSON.stringify(r.value).slice(0, 200)}`);
  return r.error;
}

// ---------------------------------------------------------------------------------- SYNTHETIC fixtures

const baseRow = (o: Record<string, unknown> = {}) => ({
  scope: "all", shot_type: "wrist", dist_bucket: 0, attempts: 100, on_net: 70, goals: 10,
  p_unblocked: 0.1, p_on_net: 0.1429, ...o,
});
const shooterRow = (o: Record<string, unknown> = {}) => ({
  player_id: 900001, scope: "all", attempts: 50, on_net: 35, goals: 5, xg: 4.5, finishing_mult: 1.1,
  accuracy: 0.7, rating: 70, low_sample: 0, ...o,
});
const goalieRow = (o: Record<string, unknown> = {}) => ({
  player_id: 900301, scope: "all", on_net: 100, ga: 10, xga: 11, ga_mult: 0.9, rating: 80, low_sample: 0, ...o,
});
const faceoffRow = (o: Record<string, unknown> = {}) => ({ player_id: 900001, scope: "all", won: 10, taken: 20, win_rate: 0.5, ...o });
const playRow = (o: Record<string, unknown> = {}) => ({ player_id: 900001, scope: "all", a1: 3, presence: 10, playmaking_mult: 1.05, ...o });

const PP_TEAM = 901, PK_TEAM = 902;
const skater = (id: number, team: number, number: number, pos = "C") =>
  ({ id, team_id: team, first: "Synth", last: `Player${id}`, number, pos });
const goalie = (id: number, team: number) => ({ id, team_id: team, first: "Synth", last: `Goalie${id}`, number: 1, pos: "G" });

/** SYNTHETIC curated-shape scenario (5v4, no penalties/bench: the pre-extension export shape). */
function scenario(): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    id: "synthetic-5v4",
    seed: 4242,
    game: { nhl_game_id: 2031030101, date: "2032-05-01", game_type: 3, home: "SYA", away: "SYB", stage: "P" },
    state: { period: 2, clock_elapsed_s: 300, strength: "5v4", score: { pp: 1, pk: 1 }, pp_remaining_s: 120 },
    pp: {
      team_id: PP_TEAM, abbrev: "SYA",
      skaters: [1, 2, 3, 4, 5].map((i) => skater(900000 + i, PP_TEAM, 10 + i)),
      goalie: goalie(900099, PP_TEAM), on_ice_source: "shifts",
    },
    pk: {
      team_id: PK_TEAM, abbrev: "SYB",
      skaters: [1, 2, 3, 4].map((i) => skater(900200 + i, PK_TEAM, 20 + i, "D")),
      goalie: goalie(900301, PK_TEAM), on_ice_source: "shifts",
    },
    real_outcome: { result: "no_goal", scorer_id: null, assist1_id: null, assist2_id: null, end_t: 420 },
    narrative: { title: "SYNTHETIC test moment", sources: ["https://example.invalid/synthetic"] },
    verification: { status: "synthetic", warnings: [] },
  };
}

// ---------------------------------------------------------------------------------- isCalendarDate

test("isCalendarDate: real dates pass", () => {
  assert.equal(isCalendarDate("2026-11-01"), true);
  assert.equal(isCalendarDate("2024-02-29"), true); // leap year
  assert.equal(isCalendarDate("2000-02-29"), true); // divisible by 400
});
test("isCalendarDate edge: impossible days and months", () => {
  assert.equal(isCalendarDate("2026-02-30"), false);
  assert.equal(isCalendarDate("2026-04-31"), false);
  assert.equal(isCalendarDate("2026-13-01"), false);
  assert.equal(isCalendarDate("2026-00-10"), false);
  assert.equal(isCalendarDate("2026-01-00"), false);
});
test("isCalendarDate edge: century non-leap year", () => {
  assert.equal(isCalendarDate("1900-02-29"), false);
  assert.equal(isCalendarDate("2025-02-29"), false);
});
test("isCalendarDate edge: wrong format", () => {
  for (const s of ["2026-1-01", "2026/01/01", "20260101", "", "2026-01-01T00:00:00Z", " 2026-01-01"]) {
    assert.equal(isCalendarDate(s), false, s);
  }
});

// ---------------------------------------------------------------------------------- parseStrength

test("parseStrength: happy path and edge cases", () => {
  assert.deepEqual(parseStrength("5v4"), { pp: 5, pk: 4 });
  assert.deepEqual(parseStrength("6v4"), { pp: 6, pk: 4 });
  assert.equal(parseStrength("5-4"), null);
  assert.equal(parseStrength("5v"), null);
  assert.equal(parseStrength("v4"), null);
  assert.equal(parseStrength("5v4 "), null);
  assert.equal(parseStrength("five v four"), null);
});

// ---------------------------------------------------------------------------------- base rates

test("parseBaseRates: happy path", () => {
  const rows = val(parseBaseRates([baseRow(), baseRow({ dist_bucket: 1 })]));
  assert.equal(rows.length, 2);
});
test("parseBaseRates edge: negative attempts rejected with file-relative path", () => {
  const e = errOf(parseBaseRates([baseRow(), baseRow({ dist_bucket: 1, attempts: -1 })]));
  assert.match(e, /^base_rates\.json: \[1\]\.attempts: /);
});
test("parseBaseRates edge: probabilities outside [0,1]", () => {
  assert.match(errOf(parseBaseRates([baseRow({ p_unblocked: 1.2 })])), /\[0\]\.p_unblocked/);
  assert.match(errOf(parseBaseRates([baseRow({ p_on_net: -0.1 })])), /\[0\]\.p_on_net/);
});
test("parseBaseRates edge: on_net > attempts and goals > on_net", () => {
  assert.match(errOf(parseBaseRates([baseRow({ on_net: 101 })])), /on_net exceeds attempts/);
  assert.match(errOf(parseBaseRates([baseRow({ goals: 71 })])), /goals exceed on_net/);
});
test("parseBaseRates edge: duplicate cell, bad scope, non-integer bucket, not an array", () => {
  assert.match(errOf(parseBaseRates([baseRow(), baseRow()])), /duplicate/);
  assert.match(errOf(parseBaseRates([baseRow({ scope: "20232025" })])), /scope/);
  assert.match(errOf(parseBaseRates([baseRow({ dist_bucket: 1.5 })])), /dist_bucket/);
  assert.match(errOf(parseBaseRates({ rows: [] })), /\(root\)/);
});
test("parseBaseRates edge: empty file is valid (coverage is the engine's check)", () => {
  assert.deepEqual(val(parseBaseRates([])), []);
});

// ---------------------------------------------------------------------------------- ratings

test("rating parsers: happy path for all four tables", () => {
  assert.equal(val(parseShooterRatings([shooterRow(), shooterRow({ scope: "20312032", rating: null, low_sample: 1 })])).length, 2);
  assert.equal(val(parseGoalieRatings([goalieRow()])).length, 1);
  assert.equal(val(parseFaceoffRatings([faceoffRow()])).length, 1);
  assert.equal(val(parsePlaymakerRatings([playRow()])).length, 1);
});
test("rating parsers edge: duplicate (player_id, scope)", () => {
  assert.match(errOf(parseShooterRatings([shooterRow(), shooterRow()])), /duplicate \(player_id, scope\)/);
  assert.match(errOf(parseFaceoffRatings([faceoffRow(), faceoffRow()])), /duplicate/);
  assert.match(errOf(parseGoalieRatings([goalieRow(), goalieRow()])), /duplicate/);
  assert.match(errOf(parsePlaymakerRatings([playRow(), playRow()])), /duplicate/);
});
test("rating parsers edge: out-of-range values", () => {
  assert.match(errOf(parseShooterRatings([shooterRow({ accuracy: 0 })])), /accuracy/);
  assert.match(errOf(parseShooterRatings([shooterRow({ finishing_mult: 0 })])), /finishing_mult/);
  assert.match(errOf(parseGoalieRatings([goalieRow({ ga_mult: -1 })])), /ga_mult/);
  assert.match(errOf(parseFaceoffRatings([faceoffRow({ win_rate: 1 })])), /win_rate/);
  assert.match(errOf(parsePlaymakerRatings([playRow({ playmaking_mult: 0 })])), /playmaking_mult/);
});
test("rating parsers edge: low_sample must be 0/1 and player_id an integer", () => {
  assert.match(errOf(parseShooterRatings([shooterRow({ low_sample: true })])), /low_sample/);
  assert.match(errOf(parseGoalieRatings([goalieRow({ player_id: 1.5 })])), /player_id/);
});
test("rating parsers edge: won > taken; season scope must be consecutive years", () => {
  assert.match(errOf(parseFaceoffRatings([faceoffRow({ won: 21 })])), /won exceeds taken/);
  assert.match(errOf(parsePlaymakerRatings([playRow({ scope: "2031" })])), /scope/);
});
test("rating parsers edge: goalie rating null allowed, missing field rejected", () => {
  val(parseGoalieRatings([goalieRow({ rating: null })]));
  const noXga: Record<string, unknown> = goalieRow();
  delete noXga.xga;
  assert.match(errOf(parseGoalieRatings([noXga])), /xga/);
});

// ---------------------------------------------------------------------------------- schedule, endless

test("parseSchedule: happy path", () => {
  const s = val(parseSchedule([{ date: "2032-01-01", scenario_id: "synthetic-a" }, { date: "2032-01-02", scenario_id: "synthetic-a" }]));
  assert.equal(s.length, 2);
});
test("parseSchedule edge: impossible calendar date", () => {
  assert.match(errOf(parseSchedule([{ date: "2032-02-30", scenario_id: "synthetic-a" }])), /\[0\]\.date: must be a real calendar date/);
});
test("parseSchedule edge: duplicate date, bad id, missing field, non-string date", () => {
  assert.match(errOf(parseSchedule([{ date: "2032-01-01", scenario_id: "a" }, { date: "2032-01-01", scenario_id: "b" }])), /duplicate date/);
  assert.match(errOf(parseSchedule([{ date: "2032-01-01", scenario_id: "../etc" }])), /scenario_id/);
  assert.match(errOf(parseSchedule([{ date: "2032-01-01" }])), /scenario_id/);
  assert.match(errOf(parseSchedule([{ date: 20320101, scenario_id: "a" }])), /date/);
});
test("parseEndlessIndex: happy path and edge cases", () => {
  assert.deepEqual(val(parseEndlessIndex(["synthetic-a", "synthetic-b"])), ["synthetic-a", "synthetic-b"]);
  assert.deepEqual(val(parseEndlessIndex([])), []);
  assert.match(errOf(parseEndlessIndex(["synthetic-a", "synthetic-b", "synthetic-a"])), /\[2\]: duplicate scenario id/);
  assert.match(errOf(parseEndlessIndex([1, 2])), /\[0\]/);
  assert.match(errOf(parseEndlessIndex([""])), /\[0\]/);
  assert.match(errOf(parseEndlessIndex("synthetic-a")), /\(root\)/);
});

// ---------------------------------------------------------------------------------- scenario

test("parseScenario: happy path (pre-extension shape without penalties/bench)", () => {
  const s = val(parseScenario(scenario()));
  assert.equal(s.id, "synthetic-5v4");
  assert.equal(s.state.penalties, undefined);
});
test("parseScenario: extended shape with penalties, goalie_pulled and bench", () => {
  const sc = scenario();
  sc.state.strength = "5v3";
  sc.pk.skaters = sc.pk.skaters.slice(0, 3);
  sc.state.penalties = [
    { side: "pk", player_id: 900201, kind: "minor", remaining_s: 60, queued: false },
    { side: "pk", player_id: null, kind: "minor", remaining_s: 120, queued: false },
  ];
  sc.state.goalie_pulled = false;
  sc.pp.bench = [skater(900006, PP_TEAM, 30)];
  val(parseScenario(sc));
  val(parseScenarioStrict(sc));
});
test("parseScenario: coincidental pair + one PK minor (4v3) accepted; field must be a boolean", () => {
  const sc = scenario();
  sc.state.strength = "4v3";
  sc.pp.skaters = sc.pp.skaters.slice(0, 4);
  sc.pk.skaters = sc.pk.skaters.slice(0, 3);
  sc.state.penalties = [
    { side: "pk", player_id: null, kind: "minor", remaining_s: 60, queued: false, coincidental: true },
    { side: "pp", player_id: null, kind: "minor", remaining_s: 60, queued: false, coincidental: true },
    { side: "pk", player_id: null, kind: "minor", remaining_s: 120, queued: false },
  ];
  sc.state.goalie_pulled = false;
  sc.pp.bench = [skater(900006, PP_TEAM, 30)];
  const s = val(parseScenario(sc));
  assert.equal(s.state.penalties?.[0]?.coincidental, true);
  assert.equal(s.state.penalties?.[2]?.coincidental, undefined);
  for (const bad of ["yes", 1, null]) {
    const b = structuredClone(sc);
    b.state.penalties[0].coincidental = bad;
    assert.match(errOf(parseScenario(b)), /coincidental/);
  }
});
test("parseScenario edge: raw mined segment shape is rejected", () => {
  const raw = { game_id: 2031030101, game_type: 3, period: 3, start_t: 100, strength: "5v4", pp_remaining_s: 120, shots: [] };
  assert.match(errOf(parseScenario(raw)), /id: /);
});
test("parseScenario edge: on-ice counts inconsistent with strength", () => {
  const sc = scenario();
  sc.pk.skaters = sc.pk.skaters.slice(0, 3);
  assert.match(errOf(parseScenario(sc)), /pk\.skaters: strength 5v4 needs 4 PK skaters/);
  const sc2 = scenario();
  sc2.state.strength = "6v4";
  assert.match(errOf(parseScenario(sc2)), /pp\.skaters: strength 6v4 needs 6 PP skaters/);
});
test("parseScenario edge: penalties inconsistent with strength", () => {
  const sc = scenario();
  sc.state.penalties = [
    { side: "pk", player_id: null, kind: "minor", remaining_s: 60, queued: false },
    { side: "pk", player_id: null, kind: "minor", remaining_s: 100, queued: false },
  ];
  assert.match(errOf(parseScenario(sc)), /state\.penalties: penalties do not produce strength 5v4/);
});
test("parseScenario edge: queued penalty does not count; remaining_s over the penalty length rejected", () => {
  const sc = scenario();
  sc.state.penalties = [
    { side: "pk", player_id: null, kind: "minor", remaining_s: 60, queued: false },
    { side: "pk", player_id: null, kind: "minor", remaining_s: 120, queued: true },
  ];
  val(parseScenario(sc));
  sc.state.penalties[0].remaining_s = 121;
  assert.match(errOf(parseScenario(sc)), /remaining_s exceeds the penalty length/);
});
test("parseScenario edge: malformed strength, non-integer id, elapsed past period end", () => {
  const a = scenario(); a.state.strength = "5-4";
  assert.match(errOf(parseScenario(a)), /state\.strength/);
  const b = scenario(); b.pp.skaters[0].id = 900001.5;
  assert.match(errOf(parseScenario(b)), /pp\.skaters\[0\]\.id/);
  const c = scenario(); c.state.clock_elapsed_s = 1201;
  assert.match(errOf(parseScenario(c)), /clock_elapsed_s: exceeds period length/);
});
test("parseScenario edge: duplicate player, wrong team, unknown abbrev, bad URL, bad result", () => {
  const a = scenario(); a.pk.skaters[0].id = a.pp.skaters[0].id; a.pk.skaters[0].team_id = PK_TEAM;
  assert.match(errOf(parseScenario(a)), /listed twice/);
  const b = scenario(); b.pp.skaters[1].team_id = PK_TEAM;
  assert.match(errOf(parseScenario(b)), /is not on team/);
  const c = scenario(); c.pp.abbrev = "SYZ";
  assert.match(errOf(parseScenario(c)), /pp\.abbrev/);
  const d = scenario(); d.narrative.sources = ["not a url"];
  assert.match(errOf(parseScenario(d)), /narrative\.sources\[0\]/);
  const e = scenario(); e.real_outcome.result = "maybe";
  assert.match(errOf(parseScenario(e)), /real_outcome\.result/);
});
test("parseScenario edge: regular-season period 5 does not exist; impossible game date", () => {
  const a = scenario(); a.game.game_type = 2; a.state.period = 5;
  assert.match(errOf(parseScenario(a)), /state\.period/);
  const b = scenario(); b.game.date = "2032-02-31";
  assert.match(errOf(parseScenario(b)), /game\.date/);
});
test("parseScenarioStrict edge: requires penalties, goalie_pulled and bench", () => {
  const e = errOf(parseScenarioStrict(scenario()));
  assert.match(e, /state\.penalties/);
  assert.match(e, /state\.goalie_pulled/);
  assert.match(e, /pp\.bench/);
});

// ---------------------------------------------------------------------------------- validateExportFile

test("validateExportFile: every top-level file and a scenario", () => {
  const good: Record<string, unknown> = {
    "base_rates.json": [baseRow()], "shooter_ratings.json": [shooterRow()], "goalie_ratings.json": [goalieRow()],
    "faceoff_ratings.json": [faceoffRow()], "playmaker_ratings.json": [playRow()],
    "schedule.json": [{ date: "2032-01-01", scenario_id: "synthetic-5v4" }], "endless_index.json": ["synthetic-5v4"],
  };
  assert.deepEqual([...EXPORT_FILES.files].sort(), Object.keys(good).sort());
  for (const f of EXPORT_FILES.files) val(validateExportFile(f, good[f]));
  val(validateExportFile(EXPORT_FILES.scenarioFile("synthetic-5v4"), scenario()));
});
test("validateExportFile edge: unknown file name", () => {
  assert.match(errOf(validateExportFile("players.json", [])), /not an export file/);
  assert.match(errOf(validateExportFile("scenarios/nested/x.json", scenario())), /not an export file/);
});
test("validateExportFile edge: scenario id must match its file name", () => {
  assert.match(errOf(validateExportFile("scenarios/other-id.json", scenario())), /does not match the file name/);
});
test("validateExportFile edge: Windows separators are normalised", () => {
  val(validateExportFile("scenarios\\synthetic-5v4.json", scenario()));
});
test("validateExportFile edge: errors carry the file-relative path", () => {
  assert.match(errOf(validateExportFile("schedule.json", [{ date: "2032-02-30", scenario_id: "a" }])), /^schedule\.json: \[0\]\.date/);
  const sc = scenario(); delete sc.seed;
  assert.match(errOf(validateExportFile("scenarios/synthetic-5v4.json", sc)), /^scenarios\/synthetic-5v4\.json: seed/);
});
test("validateExportFile edge: wrong type for a file, and many issues are capped", () => {
  assert.match(errOf(validateExportFile("endless_index.json", {})), /\(root\)/);
  const e = errOf(validateExportFile("base_rates.json", Array.from({ length: 10 }, () => baseRow({ attempts: -1, dist_bucket: "x" }))));
  assert.match(e, /\(\+\d+ more\)$/);
});
