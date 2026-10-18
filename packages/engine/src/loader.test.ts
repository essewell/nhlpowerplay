/**
 * Run from repo root: node --test packages/engine/src/loader.test.ts.
 * SYNTHETIC data only: every id, name, team, number, rating and rate below is invented and is not
 * data about any real player, team or game. The season "20312032" is deliberately in the future.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { absS } from "./clock.ts";
import { FACEOFF, PENALTY_S, PP_FORMATIONS } from "./constants.ts";
import { spotPos } from "./formation.ts";
import {
  indexAllRatings, indexRatings, leagueOnNetShare, loadScenario, seasonScope, type Loaded, type RatingFlag,
  type RatingTables,
} from "./loader.ts";
import type { Result } from "./result.ts";
import {
  parseScenario, type BaseRatesFile, type FaceoffRatingRow, type GoalieRatingRow, type PlaymakerRatingRow,
  type Scenario, type ShooterRatingRow,
} from "./schema.ts";
import { initRun } from "./sim.ts";
import { synthRates } from "./sim-fixtures.ts";

function val<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(`expected ok, got error: ${r.error}`);
  return r.value;
}
function errOf<T>(r: Result<T>): string {
  if (r.ok) assert.fail("expected error, got ok");
  return r.error;
}

// ---------------------------------------------------------------------------------- SYNTHETIC fixtures

const SEASON = "20312032";
const GAME_ID = 2031030101;
const PP_TEAM = 901, PK_TEAM = 902;
const OPTS = { formation: "umbrella" as const, askEveryTouch: false };

/** SYNTHETIC base rates in export shape: synthRates() cells with invented on-net counts (70%). */
function rates(): BaseRatesFile {
  return synthRates().map((r) => {
    const onNet = Math.round(r.attempts * 0.7);
    const goals = Math.round(r.p_unblocked * r.attempts);
    return { scope: "all", shot_type: r.shot_type, dist_bucket: r.dist_bucket, attempts: r.attempts,
      on_net: onNet, goals, p_unblocked: r.p_unblocked, p_on_net: goals / onNet };
  });
}

type RawSkater = { id: number; team_id: number; first: string; last: string; number: number; pos: "C" | "L" | "R" | "D" };
const sk = (id: number, team: number, number: number): RawSkater =>
  ({ id, team_id: team, first: "Synth", last: `P${id}`, number, pos: "C" });

/** SYNTHETIC scenario JSON; `mut` edits the raw object before schema parsing. */
function scenario(mut: (s: Record<string, any>) => void = () => {}): Scenario { // eslint-disable-line @typescript-eslint/no-explicit-any
  const s: Record<string, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
    id: "synthetic-5v4",
    seed: 4242,
    game: { nhl_game_id: GAME_ID, date: "2032-05-01", game_type: 3, home: "SYA", away: "SYB", stage: "P" },
    state: { period: 2, clock_elapsed_s: 300, strength: "5v4", score: { pp: 1, pk: 1 }, pp_remaining_s: 120 },
    pp: {
      team_id: PP_TEAM, abbrev: "SYA",
      // listed out of sweater order on purpose: the loader orders by number
      skaters: [sk(900005, PP_TEAM, 55), sk(900001, PP_TEAM, 11), sk(900003, PP_TEAM, 33), sk(900002, PP_TEAM, 22), sk(900004, PP_TEAM, 44)],
      goalie: { id: 900099, team_id: PP_TEAM, first: "Synth", last: "G1", number: 1, pos: "G" }, on_ice_source: "shifts",
    },
    pk: {
      team_id: PK_TEAM, abbrev: "SYB",
      skaters: [sk(900201, PK_TEAM, 21), sk(900202, PK_TEAM, 22), sk(900203, PK_TEAM, 23), sk(900204, PK_TEAM, 24)],
      goalie: { id: 900301, team_id: PK_TEAM, first: "Synth", last: "G2", number: 30, pos: "G" }, on_ice_source: "shifts",
    },
    real_outcome: { result: "no_goal", scorer_id: null, assist1_id: null, assist2_id: null, end_t: 420 },
    narrative: { title: "SYNTHETIC test moment", sources: ["https://example.invalid/synthetic"] },
    verification: { status: "synthetic", warnings: [] },
  };
  mut(s);
  return val(parseScenario(s, "synthetic"));
}

const shooter = (id: number, scope: string, o: Partial<ShooterRatingRow> = {}): ShooterRatingRow => ({
  player_id: id, scope, attempts: 50, on_net: 35, goals: 5, xg: 4.5, finishing_mult: 1.2, accuracy: 0.75,
  rating: 70, low_sample: 0, ...o,
});
const goalieR = (id: number, scope: string, o: Partial<GoalieRatingRow> = {}): GoalieRatingRow => ({
  player_id: id, scope, on_net: 100, ga: 9, xga: 10, ga_mult: 0.9, rating: 80, low_sample: 0, ...o,
});
const faceoffR = (id: number, scope: string, rate: number): FaceoffRatingRow => ({ player_id: id, scope, won: 10, taken: 20, win_rate: rate });
const playR = (id: number, scope: string, m: number): PlaymakerRatingRow => ({ player_id: id, scope, a1: 3, presence: 10, playmaking_mult: m });

function tables(): RatingTables {
  return {
    shooter: [
      shooter(900001, SEASON, { finishing_mult: 1.3 }),                          // season row used
      shooter(900002, SEASON, { low_sample: 1, rating: null, finishing_mult: 2 }), // low sample -> all
      shooter(900002, "all", { finishing_mult: 1.1 }),
      shooter(900003, "all", { finishing_mult: 0.9 }),                            // season missing -> all
      shooter(900004, SEASON, { low_sample: 1, rating: null }),                   // low sample, no all -> default
      // 900005: no rows -> default
    ],
    goalie: [goalieR(900301, SEASON, { ga_mult: 0.85 })],
    faceoff: [faceoffR(900001, SEASON, 0.55), faceoffR(900201, "all", 0.45)],
    playmaker: [playR(900001, SEASON, 1.25), playR(900002, "all", 0.95)],
  };
}

const has = (flags: RatingFlag[], playerId: number, field: RatingFlag["field"], reason: RatingFlag["reason"]): boolean =>
  flags.some((f) => f.playerId === playerId && f.field === field && f.reason === reason);
const skaterOf = (l: Loaded, id: number) => {
  const s = l.input.pp.skaters.find((x) => x.id === id);
  if (s === undefined) assert.fail(`no PP skater ${id}`);
  return s;
};
const pen = (side: "pp" | "pk", kind: "minor" | "double_minor" | "major", remaining_s: number, queued = false) =>
  ({ side, player_id: null, kind, remaining_s, queued });

// ---------------------------------------------------------------------------------- loadScenario

test("loadScenario: happy path 5v4 (pre-extension export) loads and the engine accepts it", () => {
  const l = val(loadScenario(scenario(), tables(), rates(), OPTS));
  const now = val(absS({ period: 2, elapsedS: 300 }, 3));
  assert.deepEqual(l.input.penalties, [{ id: 1, side: "pk", kind: "minor", expiresAtS: now + 120, durationS: PENALTY_S.minor }]);
  assert.equal(l.input.goaliePulled, false);
  assert.deepEqual(l.input.pp.skaters.map((s) => s.id), [900001, 900002, 900003, 900004, 900005]);
  assert.deepEqual(l.input.pk.skaters.map((s) => s.id), [900201, 900202, 900203, 900204]);
  assert.equal(l.input.seed, 4242);
  assert.equal(l.input.scenarioId, "synthetic-5v4");
  assert.equal(l.input.gameType, 3);
  assert.deepEqual(l.input.score, { pp: 1, pk: 1 });
  assert.equal(l.input.rates.length, rates().length);
  assert.deepEqual(l.fallbacks.map((f) => f.field).sort(), ["bench", "goalie_pulled", "penalties"]);
  // positions: start formation for 5, carrier (lowest number) on the first spot
  const spots = PP_FORMATIONS.umbrella[5];
  assert.deepEqual(skaterOf(l, 900001).pos, spotPos(spots[0]));
  assert.equal(skaterOf(l, 900001).name, "Synth P900001");
  val(initRun(l.input));
});

test("loadScenario: ratings — season row, low-sample fallback, season-missing fallback", () => {
  const l = val(loadScenario(scenario(), tables(), rates(), OPTS));
  assert.equal(skaterOf(l, 900001).finishingMult, 1.3);
  assert.equal(skaterOf(l, 900001).playmakingMult, 1.25);
  assert.equal(skaterOf(l, 900001).faceoffWinRate, 0.55);
  assert.ok(!l.flags.some((f) => f.playerId === 900001 && f.field === "shooter"));
  assert.equal(skaterOf(l, 900002).finishingMult, 1.1);
  assert.ok(has(l.flags, 900002, "shooter", "low_sample_fallback_all"));
  assert.ok(has(l.flags, 900002, "playmaker", "season_missing_fallback_all"));
  assert.equal(skaterOf(l, 900003).finishingMult, 0.9);
  assert.ok(has(l.flags, 900003, "shooter", "season_missing_fallback_all"));
  assert.equal(l.input.pk.goalie.gaMult, 0.85);
  assert.equal(l.input.pk.skaters[0]?.faceoffWinRate, 0.45);
});

test("loadScenario edge: missing ratings default to league average and are flagged", () => {
  const l = val(loadScenario(scenario(), tables(), rates(), OPTS));
  const share = val(leagueOnNetShare(rates()));
  for (const id of [900004, 900005]) {
    const s = skaterOf(l, id);
    assert.equal(s.finishingMult, 1);
    assert.equal(s.accuracy, share);
    assert.equal(s.playmakingMult, 1);
    assert.equal(s.puckControlMult, 1);
    assert.equal(s.faceoffWinRate, FACEOFF.PRIOR_RATE);
    assert.ok(has(l.flags, id, "shooter", "missing"));
    assert.ok(has(l.flags, id, "playmaker", "missing"));
    assert.ok(has(l.flags, id, "faceoff", "missing"));
  }
  assert.ok(has(l.flags, 900202, "faceoff", "missing"));
  // every PP skater's shooting hand and the goalie's catch hand are unknown in the export
  for (const s of l.input.pp.skaters) assert.ok(has(l.flags, s.id, "shoots_left", "unknown_shoot_hand"));
  assert.ok(has(l.flags, 900301, "catches_left", "unknown_catch_hand"));
  assert.equal(l.input.pk.goalie.catchesLeft, true);
});

test("loadScenario edge: no ratings at all still loads, everything flagged missing", () => {
  const l = val(loadScenario(scenario(), { shooter: [], goalie: [], faceoff: [], playmaker: [] }, rates(), OPTS));
  assert.equal(l.input.pk.goalie.gaMult, 1);
  assert.ok(has(l.flags, 900301, "goalie", "missing"));
  assert.equal(l.flags.filter((f) => f.reason === "missing").length, 5 * 3 + 4 + 1);
});

test("loadScenario edge: missing penalties fallback by pp_remaining_s (minor / double minor / major / too long)", () => {
  const kind = (rem: number) => val(loadScenario(scenario((s) => { s.state.pp_remaining_s = rem; }), tables(), rates(), OPTS))
    .input.penalties[0]?.kind;
  assert.equal(kind(1), "minor");
  assert.equal(kind(120), "minor");
  assert.equal(kind(121), "double_minor");
  assert.equal(kind(240), "double_minor");
  assert.equal(kind(300), "major");
  assert.match(errOf(loadScenario(scenario((s) => { s.state.pp_remaining_s = 301; }), tables(), rates(), OPTS)),
    /longer than any single penalty/);
});

test("loadScenario edge: 6v4 without penalties -> goalie pulled, six skaters", () => {
  const sc = scenario((s) => {
    s.state.strength = "6v4";
    s.pp.skaters.push(sk(900006, PP_TEAM, 66));
  });
  const l = val(loadScenario(sc, tables(), rates(), OPTS));
  assert.equal(l.input.goaliePulled, true);
  assert.equal(l.input.pp.skaters.length, 6);
  assert.ok(l.fallbacks.some((f) => f.field === "goalie_pulled" && f.detail.includes("6v4")));
});

test("loadScenario edge: strength other than 5v4/6v4 without penalties is an error", () => {
  const sc = scenario((s) => { s.state.strength = "5v3"; s.pk.skaters = s.pk.skaters.slice(0, 3); });
  assert.match(errOf(loadScenario(sc, tables(), rates(), OPTS)), /penalties is absent and strength 5v3 cannot be inferred/);
});

test("loadScenario edge: 5v3 with an explicit penalties list (one queued)", () => {
  const sc = scenario((s) => {
    s.state.strength = "5v3";
    s.pk.skaters = s.pk.skaters.slice(0, 3);
    s.state.penalties = [pen("pk", "minor", 60), pen("pk", "minor", 120), pen("pk", "double_minor", 240, true)];
    s.state.goalie_pulled = false;
    s.pp.bench = [];
  });
  const l = val(loadScenario(sc, tables(), rates(), OPTS));
  const now = val(absS({ period: 2, elapsedS: 300 }, 3));
  assert.deepEqual(l.input.penalties, [
    { id: 1, side: "pk", kind: "minor", expiresAtS: now + 60, durationS: PENALTY_S.minor },
    { id: 2, side: "pk", kind: "minor", expiresAtS: now + 120, durationS: PENALTY_S.minor },
    { id: 3, side: "pk", kind: "double_minor", expiresAtS: null, durationS: PENALTY_S.double_minor },
  ]);
  assert.deepEqual(l.fallbacks, []);
  assert.equal(l.input.pk.skaters.length, 3);
});

test("loadScenario edge: coincidental flag is carried to the engine penalties (absent stays absent)", () => {
  const sc = scenario((s) => {
    s.state.strength = "4v3";
    s.pp.skaters = s.pp.skaters.slice(0, 4);
    s.pk.skaters = s.pk.skaters.slice(0, 3);
    s.state.penalties = [
      { ...pen("pk", "minor", 60), coincidental: true }, { ...pen("pp", "minor", 60), coincidental: true },
      pen("pk", "minor", 120),
    ];
    s.state.goalie_pulled = false;
    s.pp.bench = [sk(900007, PP_TEAM, 77)];
  });
  const l = val(loadScenario(sc, tables(), rates(), OPTS));
  assert.deepEqual(l.input.penalties.map((p) => p.coincidental), [true, true, undefined]);
  assert.equal("coincidental" in (l.input.penalties[2] ?? {}), false);
});

test("loadScenario edge: goalie_pulled absent with explicit penalties is inferred and flagged", () => {
  const sc = scenario((s) => { s.state.penalties = [pen("pk", "minor", 90)]; s.pp.bench = []; });
  const l = val(loadScenario(sc, tables(), rates(), OPTS));
  assert.equal(l.input.goaliePulled, false);
  assert.deepEqual(l.fallbacks.map((f) => f.field), ["goalie_pulled"]);
});

test("loadScenario edge: empty bench when strength can rise -> error; bench fills and is truncated", () => {
  // 4v3: one PP minor (ends first, at +30 s) and two PK minors; PP strength rises to 5.
  const base = (bench: RawSkater[]) => scenario((s) => {
    s.state.strength = "4v3";
    s.pp.skaters = s.pp.skaters.slice(0, 4);
    s.pk.skaters = s.pk.skaters.slice(0, 3);
    s.state.penalties = [pen("pp", "minor", 30), pen("pk", "minor", 90), pen("pk", "minor", 120)];
    s.state.goalie_pulled = false;
    s.pp.bench = bench;
  });
  assert.match(errOf(loadScenario(base([]), tables(), rates(), OPTS)), /reaches 5 PP skaters but only 4 are listed/);
  const l = val(loadScenario(base([sk(900008, PP_TEAM, 88), sk(900007, PP_TEAM, 77)]), tables(), rates(), OPTS));
  // on-ice by number (11, 22, 33, 55 -> 900004 was dropped by slice), then the lowest-numbered bench skater
  assert.equal(l.input.pp.skaters.length, 5);
  assert.equal(l.input.pp.skaters[4]?.id, 900007);
  assert.ok(!l.flags.some((f) => f.playerId === 900008), "a truncated bench skater gets no flags");
});

test("loadScenario edge: invalid formation is rejected (engine never sees it)", () => {
  const r = loadScenario(scenario(), tables(), rates(), { formation: "diamond" as never, askEveryTouch: false });
  assert.match(errOf(r), /formation/);
});

test("loadScenario edge: base rates that do not cover every shot are rejected by the engine", () => {
  const r = loadScenario(scenario(), tables(), rates().filter((x) => x.dist_bucket !== 0), OPTS);
  assert.match(errOf(r), /engine rejected the input: base-rate coverage/);
});

test("loadScenario edge: duplicate rating rows are an error", () => {
  const t = tables();
  const dup: RatingTables = { ...t, goalie: [...t.goalie, ...t.goalie] };
  assert.match(errOf(loadScenario(scenario(), dup, rates(), OPTS)), /goalie_ratings: duplicate rating row/);
});

test("loadScenario: determinism — same input gives deepEqual output, raw tables == prebuilt indexes", () => {
  const a = val(loadScenario(scenario(), tables(), rates(), OPTS));
  const b = val(loadScenario(scenario(), tables(), rates(), OPTS));
  assert.deepEqual(a, b);
  const c = val(loadScenario(scenario(), val(indexAllRatings(tables())), rates(), OPTS));
  assert.deepEqual(a, c);
  assert.deepEqual(val(initRun(a.input)), val(initRun(b.input)));
});

test("loadScenario: askEveryTouch and formation pass through to settings", () => {
  const l = val(loadScenario(scenario(), tables(), rates(), { formation: "one_three_one", askEveryTouch: true }));
  assert.deepEqual(l.input.settings, { formation: "one_three_one", askEveryTouch: true });
  assert.deepEqual(skaterOf(l, 900001).pos, spotPos(PP_FORMATIONS.one_three_one[5][0]));
});

// ---------------------------------------------------------------------------------- indexRatings

test("indexRatings: happy path keyed by (player_id, scope)", () => {
  const idx = val(indexRatings([playR(1, "all", 1.1), playR(1, SEASON, 1.2), playR(2, "all", 0.9)]));
  assert.equal(idx.size, 3);
  assert.equal(idx.get(`1|${SEASON}`)?.playmaking_mult, 1.2);
  assert.equal(idx.get("2|all")?.playmaking_mult, 0.9);
});
test("indexRatings edge: empty, duplicate, missing key, same player many scopes, many players one scope", () => {
  assert.equal(val(indexRatings([])).size, 0);
  assert.match(errOf(indexRatings([playR(1, "all", 1), playR(1, "all", 2)])), /duplicate rating row for player 1, scope all/);
  assert.equal(val(indexRatings([playR(1, "all", 1)])).get("2|all"), undefined);
  assert.equal(val(indexRatings([playR(1, "20302031", 1), playR(1, "20312032", 1), playR(1, "all", 1)])).size, 3);
  assert.equal(val(indexRatings([playR(1, "all", 1), playR(2, "all", 1), playR(3, "all", 1)])).size, 3);
});
test("indexAllRatings edge: names the offending table", () => {
  const t = tables();
  assert.match(errOf(indexAllRatings({ ...t, faceoff: [...t.faceoff, ...t.faceoff] })), /^faceoff_ratings:/);
  assert.match(errOf(indexAllRatings({ ...t, shooter: [...t.shooter, ...t.shooter] })), /^shooter_ratings:/);
  assert.match(errOf(indexAllRatings({ ...t, playmaker: [...t.playmaker, ...t.playmaker] })), /^playmaker_ratings:/);
});

// ---------------------------------------------------------------------------------- seasonScope

test("seasonScope: happy path and edge cases", () => {
  assert.equal(val(seasonScope(2031030101)), "20312032");
  assert.equal(val(seasonScope(1999020001)), "19992000");
  assert.match(errOf(seasonScope(203103010)), /invalid NHL game id/);   // 9 digits
  assert.match(errOf(seasonScope(20310301011)), /invalid NHL game id/); // 11 digits
  assert.match(errOf(seasonScope(-2031030101)), /invalid NHL game id/);
  assert.match(errOf(seasonScope(2031030101.5)), /invalid NHL game id/);
  assert.match(errOf(seasonScope(Number.NaN)), /invalid NHL game id/);
});

// ---------------------------------------------------------------------------------- leagueOnNetShare

test("leagueOnNetShare: sum(on_net) / sum(attempts) over scope all", () => {
  const r = rates();
  const expect = r.reduce((n, x) => n + x.on_net, 0) / r.reduce((n, x) => n + x.attempts, 0);
  assert.equal(val(leagueOnNetShare(r)), expect);
});
test("leagueOnNetShare edge: weighting, season rows ignored, empty, zero attempts, zero on-net", () => {
  const row = (scope: string, attempts: number, on_net: number) =>
    ({ scope, shot_type: "wrist", dist_bucket: 0, attempts, on_net, goals: 0, p_unblocked: 0, p_on_net: 0 });
  assert.equal(val(leagueOnNetShare([row("all", 100, 80), { ...row("all", 300, 120), dist_bucket: 1 }])), 0.5);
  assert.equal(val(leagueOnNetShare([row("all", 10, 5), row(SEASON, 1000, 1000)])), 0.5);
  assert.match(errOf(leagueOnNetShare([])), /no scope "all" attempts/);
  assert.match(errOf(leagueOnNetShare([row("all", 0, 0)])), /no scope "all" attempts/);
  assert.match(errOf(leagueOnNetShare([row("all", 10, 0)])), /outside \(0, 1\]/);
});
