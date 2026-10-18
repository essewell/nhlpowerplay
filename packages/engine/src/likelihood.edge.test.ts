/**
 * Edge-case tests for likelihood.ts. Run from repo root:
 *   node --test packages/engine/src/likelihood.edge.test.ts
 * All fixture values below are SYNTHETIC (invented for tests); none are real player or league stats.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseRate, dist, distanceBucket, laneThreat, passLikelihood, passSubtext, pct, shotLikelihood,
  shotSubtext, skateLikelihood, skateSubtext, validPos, zoneFor,
  type BaseRateRow, type Corner, type Defender, type Goalie, type PassLikelihood, type ShotLikelihood,
  type SkateLikelihood, type Skater,
} from "./likelihood.ts";
import { DISTANCE_BUCKETS_FT, MIN_BASE_SAMPLE, ZONE_FACTOR, type ShotOption, type SpotName } from "./constants.ts";

// --- SYNTHETIC fixtures -------------------------------------------------------------------------
const sk = (id: number, name: string, x: number, y: number, over: Partial<Skater> = {}): Skater => ({
  id, name, pos: { x, y }, playmakingMult: 1, finishingMult: 1, puckControlMult: 1, accuracy: 0.6,
  shootsLeft: true, ...over,
});
const SYNTH_GOALIE_L: Goalie = { id: 900, name: "SynthGoalieL", gaMult: 1, catchesLeft: true };
const SYNTH_GOALIE_R: Goalie = { id: 901, name: "SynthGoalieR", gaMult: 1, catchesLeft: false };
const SYNTH_RATES: BaseRateRow[] = [
  { shot_type: "wrist", dist_bucket: 1, attempts: 400, p_unblocked: 0.10 },
  { shot_type: "slap", dist_bucket: 1, attempts: 200, p_unblocked: 0.05 },
  { shot_type: "snap", dist_bucket: 1, attempts: 200, p_unblocked: 0.15 },
  { shot_type: "wrist", dist_bucket: 2, attempts: 1000, p_unblocked: 0.08 },
  { shot_type: "backhand", dist_bucket: 3, attempts: MIN_BASE_SAMPLE, p_unblocked: 0.04 },
  { shot_type: "wrist", dist_bucket: 3, attempts: 950, p_unblocked: 0.02 },
];
const NAN = Number.NaN, INF = Number.POSITIVE_INFINITY;
const close = (a: number, b: number, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

// --- dist / validPos ------------------------------------------------------------------------------
test("dist: 3-4-5 triangle, symmetric, zero for same point", () => {
  assert.equal(dist({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  assert.equal(dist({ x: 3, y: 4 }, { x: 0, y: 0 }), 5);
  assert.equal(dist({ x: -7, y: 2 }, { x: -7, y: 2 }), 0);
});

test("validPos: rejects NaN and +/-Infinity in either coordinate", () => {
  assert.equal(validPos({ x: 0, y: 0 }), true);
  assert.equal(validPos({ x: NAN, y: 0 }), false);
  assert.equal(validPos({ x: 0, y: INF }), false);
  assert.equal(validPos({ x: -INF, y: 0 }), false);
});

// --- baseRate -------------------------------------------------------------------------------------
test("baseRate happy path: well-sampled cell uses only that shot type", () => {
  assert.deepEqual(baseRate(SYNTH_RATES, "wrist", 2), { ok: true, value: 0.08 });
});

test("baseRate edge: empty rows -> error", () => {
  assert.equal(baseRate([], "wrist", 2).ok, false);
});

test("baseRate edge: unknown option -> error", () => {
  assert.equal(baseRate(SYNTH_RATES, "laser" as ShotOption, 2).ok, false);
});

test("baseRate edge: bucket with no rows (incl. negative / fractional bucket) -> error", () => {
  assert.equal(baseRate(SYNTH_RATES, "wrist", 9).ok, false);
  assert.equal(baseRate(SYNTH_RATES, "wrist", -1).ok, false);
  assert.equal(baseRate(SYNTH_RATES, "wrist", 1.5).ok, false);
});

test("baseRate edge: exactly MIN_BASE_SAMPLE attempts is enough (no pooling)", () => {
  assert.deepEqual(baseRate(SYNTH_RATES, "backhand", 3), { ok: true, value: 0.04 });
});

test("baseRate edge: option with no rows in the bucket pools the whole bucket (attempt-weighted)", () => {
  const r = baseRate(SYNTH_RATES, "backhand", 1);
  assert.ok(r.ok);
  close(r.value, (400 * 0.10 + 200 * 0.05 + 200 * 0.15) / 800);
});

test("baseRate edge: multi-key option (one_timer) pools its keys weighted by attempts", () => {
  const r = baseRate(SYNTH_RATES, "one_timer", 1);   // slap + snap = 400 >= MIN_BASE_SAMPLE
  assert.ok(r.ok);
  close(r.value, (200 * 0.05 + 200 * 0.15) / 400);
});

test("baseRate edge: rows with zero attempts in the bucket -> error, not NaN", () => {
  const rows: BaseRateRow[] = [{ shot_type: "wrist", dist_bucket: 0, attempts: 0, p_unblocked: 0.5 }];
  assert.equal(baseRate(rows, "wrist", 0).ok, false);
});

test("baseRate determinism: row order does not change the result", () => {
  assert.deepEqual(baseRate(SYNTH_RATES, "backhand", 1), baseRate([...SYNTH_RATES].reverse(), "backhand", 1));
});

// --- zoneFor --------------------------------------------------------------------------------------
test("zoneFor happy path: left-catching goalie, glove is on shooter's right", () => {
  assert.equal(zoneFor("top_right", SYNTH_GOALIE_L), "high_glove");
  assert.equal(zoneFor("top_left", SYNTH_GOALIE_L), "high_blocker");
});

test("zoneFor edge: bottom corners map to low zones for a left catcher", () => {
  assert.equal(zoneFor("bottom_right", SYNTH_GOALIE_L), "low_glove");
  assert.equal(zoneFor("bottom_left", SYNTH_GOALIE_L), "low_blocker");
});

test("zoneFor edge: right-catching goalie mirrors every side corner", () => {
  assert.equal(zoneFor("top_right", SYNTH_GOALIE_R), "high_blocker");
  assert.equal(zoneFor("top_left", SYNTH_GOALIE_R), "high_glove");
  assert.equal(zoneFor("bottom_right", SYNTH_GOALIE_R), "low_blocker");
  assert.equal(zoneFor("bottom_left", SYNTH_GOALIE_R), "low_glove");
});

test("zoneFor edge: five_hole is hand-independent", () => {
  assert.equal(zoneFor("five_hole", SYNTH_GOALIE_L), "five_hole");
  assert.equal(zoneFor("five_hole", SYNTH_GOALIE_R), "five_hole");
});

test("zoneFor edge: every corner x hand yields a known ZONE_FACTOR key", () => {
  const corners: Corner[] = ["top_left", "top_right", "bottom_left", "bottom_right", "five_hole"];
  for (const g of [SYNTH_GOALIE_L, SYNTH_GOALIE_R]) {
    for (const c of corners) assert.ok(Object.hasOwn(ZONE_FACTOR, zoneFor(c, g)), `${c}`);
  }
});

test("zoneFor edge: gaMult and name do not affect mapping; goalie is not mutated", () => {
  const g = { ...SYNTH_GOALIE_L, gaMult: 5, name: "" };
  const before = { ...g };
  assert.equal(zoneFor("top_right", g), "high_glove");
  assert.deepEqual(g, before);
});

// --- pct ------------------------------------------------------------------------------------------
test("pct happy path: rounds to whole percent", () => {
  assert.equal(pct(0.5), "50%");
  assert.equal(pct(0.784), "78%");
});

test("pct edge: zero and tiny values show <1%", () => {
  assert.equal(pct(0), "<1%");
  assert.equal(pct(0.0049), "<1%");
  assert.equal(pct(Number.MIN_VALUE), "<1%");
});

test("pct edge: rounding boundary 0.005 -> 1%, 0.995 -> 100%", () => {
  assert.equal(pct(0.005), "1%");
  assert.equal(pct(0.995), "100%");
  assert.equal(pct(1), "100%");
});

test("pct edge: out-of-range values are clamped to [0,1]", () => {
  assert.equal(pct(-0.3), "<1%");
  assert.equal(pct(1.7), "100%");
  assert.equal(pct(1e300), "100%");
});

test("pct edge: NaN and +/-Infinity -> n/a", () => {
  assert.equal(pct(NAN), "n/a");
  assert.equal(pct(INF), "n/a");
  assert.equal(pct(-INF), "n/a");
});

// --- distanceBucket ---------------------------------------------------------------------------------
test("distanceBucket happy path: interior value", () => {
  assert.deepEqual(distanceBucket(25), { ok: true, value: 2 });
});

test("distanceBucket edge: 0 and -0 are bucket 0", () => {
  assert.deepEqual(distanceBucket(0), { ok: true, value: 0 });
  assert.deepEqual(distanceBucket(-0), { ok: true, value: 0 });
});

test("distanceBucket edge: buckets are [edge, next) at every interior edge", () => {
  const last = DISTANCE_BUCKETS_FT.length - 2;
  DISTANCE_BUCKETS_FT.forEach((edge, i) => {
    if (i === 0 || i > last) return;
    assert.deepEqual(distanceBucket(edge), { ok: true, value: i }, `at ${edge}`);
    assert.deepEqual(distanceBucket(edge - 1e-9), { ok: true, value: i - 1 }, `below ${edge}`);
  });
});

test("distanceBucket edge: at and past the last edge clamp to the last bucket", () => {
  const last = DISTANCE_BUCKETS_FT.length - 2;
  const top = DISTANCE_BUCKETS_FT[DISTANCE_BUCKETS_FT.length - 1];
  assert.ok(top !== undefined);
  assert.deepEqual(distanceBucket(top), { ok: true, value: last });
  assert.deepEqual(distanceBucket(Number.MAX_VALUE), { ok: true, value: last });
});

test("distanceBucket edge: negative distance -> error", () => {
  assert.equal(distanceBucket(-1).ok, false);
  assert.equal(distanceBucket(-1e-12).ok, false);
});

test("distanceBucket edge: NaN and Infinity -> error", () => {
  assert.equal(distanceBucket(NAN).ok, false);
  assert.equal(distanceBucket(INF).ok, false);
  assert.equal(distanceBucket(-INF).ok, false);
});

// --- laneThreat -----------------------------------------------------------------------------------
const A = { x: 0, y: 0 }, B = { x: 20, y: 0 };

test("laneThreat happy path: defender on the lane midpoint contributes exactly 1", () => {
  assert.deepEqual(laneThreat(A, B, [{ pos: { x: 10, y: 0 } }], 4), { ok: true, value: 1 });
});

test("laneThreat edge: no defenders -> 0", () => {
  assert.deepEqual(laneThreat(A, B, [], 4), { ok: true, value: 0 });
});

test("laneThreat edge: defenders at the endpoints (t=0, t=1) are excluded", () => {
  assert.deepEqual(laneThreat(A, B, [{ pos: { ...A } }, { pos: { ...B } }], 4), { ok: true, value: 0 });
});

test("laneThreat edge: threat is additive and decays with perpendicular distance", () => {
  const one = laneThreat(A, B, [{ pos: { x: 10, y: 4 } }], 4);
  const two = laneThreat(A, B, [{ pos: { x: 10, y: 4 } }, { pos: { x: 5, y: -4 } }], 4);
  const far = laneThreat(A, B, [{ pos: { x: 10, y: 400 } }], 4);
  assert.ok(one.ok && two.ok && far.ok);
  close(one.value, Math.exp(-1));
  close(two.value, 2 * Math.exp(-1));
  assert.equal(far.value, 0);
});

test("laneThreat edge: sigma <= 0, NaN or Infinity -> error", () => {
  for (const s of [0, -0, -4, NAN, INF]) assert.equal(laneThreat(A, B, [], s).ok, false, `sigma ${s}`);
});

test("laneThreat edge: non-finite endpoints or defender -> error", () => {
  assert.equal(laneThreat({ x: NAN, y: 0 }, B, [], 4).ok, false);
  assert.equal(laneThreat(A, { x: 0, y: INF }, [], 4).ok, false);
  assert.equal(laneThreat(A, B, [{ pos: { x: 10, y: NAN } }], 4).ok, false);
});

test("laneThreat determinism: direction of the lane does not change threat", () => {
  const defs: Defender[] = [{ pos: { x: 7, y: 2 } }, { pos: { x: 13, y: -1 } }];
  const fwd = laneThreat(A, B, defs, 4), back = laneThreat(B, A, defs, 4);
  assert.ok(fwd.ok && back.ok);
  close(fwd.value, back.value);
});

// --- pass / skate / shot non-finite inputs ----------------------------------------------------------
const passer = sk(1, "SynthPasser", 60, 20), receiver = sk(2, "SynthReceiver", 70, -15);

test("passLikelihood happy path: finite inputs give p within [FLOOR, CAP]", () => {
  const r = passLikelihood(passer, receiver, [{ pos: { x: 65, y: 0 } }]);
  assert.ok(r.ok && r.value.p > 0 && r.value.p < 1);
});

test("passLikelihood edge: NaN passer, Infinity receiver, NaN defender -> errors naming the cause", () => {
  const a = passLikelihood(sk(1, "SynthNaN", NAN, 0), receiver, []);
  assert.ok(!a.ok && a.error.includes("SynthNaN"));
  assert.equal(passLikelihood(passer, sk(2, "R", 70, INF), []).ok, false);
  const c = passLikelihood(passer, receiver, [{ pos: { x: NAN, y: 0 } }]);
  assert.ok(!c.ok && c.error.includes("defender"));
});

test("passLikelihood edge: NaN / Infinity playmakingMult -> error", () => {
  assert.equal(passLikelihood(sk(1, "P", 60, 20, { playmakingMult: NAN }), receiver, []).ok, false);
  assert.equal(passLikelihood(sk(1, "P", 60, 20, { playmakingMult: INF }), receiver, []).ok, false);
});

test("passLikelihood edge: co-located passer and receiver (distinct ids) is finite", () => {
  const r = passLikelihood(passer, sk(2, "R", 60, 20), []);
  assert.ok(r.ok && Number.isFinite(r.value.p) && r.value.distanceFt === 0);
});

test("skateLikelihood happy path: open ice to a named spot", () => {
  const r = skateLikelihood(sk(1, "C", 40, 10), "slot", []);
  assert.ok(r.ok && r.value.target === "slot" && r.value.p > 0.5);
});

test("skateLikelihood edge: NaN carrier, Infinity defender, unknown spot, NaN puckControl -> errors", () => {
  assert.equal(skateLikelihood(sk(1, "C", NAN, 0), "slot", []).ok, false);
  assert.equal(skateLikelihood(sk(1, "C", 40, 10), "slot", [{ pos: { x: -INF, y: 0 } }]).ok, false);
  assert.equal(skateLikelihood(sk(1, "C", 40, 10), "toString" as SpotName, []).ok, false);
  assert.equal(skateLikelihood(sk(1, "C", 40, 10, { puckControlMult: NAN }), "slot", []).ok, false);
});

test("shotLikelihood happy path: open shot from synthetic bucket 2", () => {
  const r = shotLikelihood(sk(1, "S", 64, 0), SYNTH_GOALIE_L, "wrist", "high_glove", [], SYNTH_RATES);
  assert.ok(r.ok);
  assert.equal(r.value.pBlocked, 0);
  close(r.value.pGoal, 0.08 * ZONE_FACTOR.high_glove);
});

test("shotLikelihood edge: NaN shooter / Infinity defender -> error", () => {
  assert.equal(shotLikelihood(sk(1, "S", NAN, 0), SYNTH_GOALIE_L, "wrist", "high_glove", [], SYNTH_RATES).ok, false);
  assert.equal(shotLikelihood(sk(1, "S", 64, 0), SYNTH_GOALIE_L, "wrist", "high_glove",
    [{ pos: { x: 70, y: INF } }], SYNTH_RATES).ok, false);
});

test("shotLikelihood edge: NaN accuracy / NaN gaMult / unknown zone -> error", () => {
  assert.equal(shotLikelihood(sk(1, "S", 64, 0, { accuracy: NAN }), SYNTH_GOALIE_L, "wrist", "high_glove", [],
    SYNTH_RATES).ok, false);
  assert.equal(shotLikelihood(sk(1, "S", 64, 0), { ...SYNTH_GOALIE_L, gaMult: NAN }, "wrist", "high_glove", [],
    SYNTH_RATES).ok, false);
  assert.equal(shotLikelihood(sk(1, "S", 64, 0), SYNTH_GOALIE_L, "wrist", "upper_90" as "five_hole", [],
    SYNTH_RATES).ok, false);
});

test("shotLikelihood edge: shooter exactly on the net is finite (zero-length lane)", () => {
  const rates: BaseRateRow[] = [{ shot_type: "tip-in", dist_bucket: 0, attempts: 100, p_unblocked: 0.3 }];
  const r = shotLikelihood(sk(1, "S", 89, 0), SYNTH_GOALIE_L, "tip", "five_hole", [{ pos: { x: 89, y: 0 } }], rates);
  assert.ok(r.ok && r.value.distanceFt === 0 && r.value.pBlocked === 0 && Number.isFinite(r.value.pGoal));
});

test("likelihood determinism: identical inputs give identical results", () => {
  const defs: Defender[] = [{ pos: { x: 66, y: 3 } }];
  assert.deepEqual(passLikelihood(passer, receiver, defs), passLikelihood(passer, receiver, defs));
  assert.deepEqual(skateLikelihood(passer, "slot", defs), skateLikelihood(passer, "slot", defs));
  assert.deepEqual(
    shotLikelihood(sk(1, "S", 64, 0), SYNTH_GOALIE_L, "wrist", "low_glove", defs, SYNTH_RATES),
    shotLikelihood(sk(1, "S", 64, 0), SYNTH_GOALIE_L, "wrist", "low_glove", defs, SYNTH_RATES),
  );
});

// --- subtexts -------------------------------------------------------------------------------------
const passR = (p: number): PassLikelihood => ({ p, distanceFt: 10, laneThreat: 0, receiverThreat: 0 });
const skateR = (p: number, target: SpotName): SkateLikelihood => ({ p, target, distanceFt: 10, pathThreat: 0 });
const shotR = (pGoal: number, pBlocked: number, zone: ShotLikelihood["zone"]): ShotLikelihood =>
  ({ pGoal, pBlocked, pOnNet: 0.5, distanceFt: 20, zone });

test("passSubtext happy path", () => {
  assert.equal(passSubtext(passR(0.78), sk(2, "SynthWinger", 0, 0)), "Pass to SynthWinger · 78% connects");
});

test("passSubtext edge: tiny p, NaN p, empty name, unicode name", () => {
  assert.equal(passSubtext(passR(0.001), sk(2, "X", 0, 0)), "Pass to X · <1% connects");
  assert.equal(passSubtext(passR(NAN), sk(2, "X", 0, 0)), "Pass to X · n/a connects");
  assert.equal(passSubtext(passR(1), sk(2, "", 0, 0)), "Pass to  · 100% connects");
  assert.equal(passSubtext(passR(0.5), sk(2, "Synthé Ünïcode", 0, 0)), "Pass to Synthé Ünïcode · 50% connects");
});

test("skateSubtext happy path: underscores become spaces", () => {
  assert.equal(skateSubtext(skateR(0.9, "circle_top_left")), "Skate to circle top left · 90% keeps puck");
});

test("skateSubtext edge: single-word spot, out-of-range p, NaN p", () => {
  assert.equal(skateSubtext(skateR(0.5, "slot")), "Skate to slot · 50% keeps puck");
  assert.equal(skateSubtext(skateR(2, "net_front")), "Skate to net front · 100% keeps puck");
  assert.equal(skateSubtext(skateR(-1, "net_front")), "Skate to net front · <1% keeps puck");
  assert.equal(skateSubtext(skateR(NAN, "net_front")), "Skate to net front · n/a keeps puck");
});

test("shotSubtext happy path: option and zone formatting", () => {
  assert.equal(shotSubtext(shotR(0.12, 0.3, "high_glove"), "one_timer"), "one-timer · high glove · 12% goal · 30% blocked");
});

test("shotSubtext edge: wrap_around hyphenates, zero values show <1%, NaN shows n/a", () => {
  assert.equal(shotSubtext(shotR(0, 0, "five_hole"), "wrap_around"), "wrap-around · five hole · <1% goal · <1% blocked");
  assert.equal(shotSubtext(shotR(NAN, INF, "low_blocker"), "wrist"), "wrist · low blocker · n/a goal · n/a blocked");
  assert.equal(shotSubtext(shotR(1, 1, "low_glove"), "tip"), "tip · low glove · 100% goal · 100% blocked");
});
