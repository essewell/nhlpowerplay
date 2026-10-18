/** Run from repo root: node --test "packages/engine/src/*.test.ts"   (Node 22.18+, native TypeScript type stripping) */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  baseRate, distanceBucket, laneThreat, passLikelihood, passSubtext, pct, shotLikelihood, skateLikelihood,
  zoneFor, type BaseRateRow, type Goalie, type Skater,
} from "./likelihood.ts";
import { dailyScenario, EndlessQueue, fnv1a, mulberry32 } from "./modes.ts";
import { OZ_SPOTS, ZONE_FACTOR } from "./constants.ts";

// Synthetic fixture values for tests only (not real ratings).
const sk = (id: number, name: string, x: number, y: number, over: Partial<Skater> = {}): Skater => ({
  id, name, pos: { x, y }, playmakingMult: 1, finishingMult: 1, puckControlMult: 1, accuracy: 0.6,
  shootsLeft: true, ...over,
});
const goalie: Goalie = { id: 99, name: "G", gaMult: 1, catchesLeft: true };
const rates: BaseRateRow[] = [
  { shot_type: "wrist", dist_bucket: 2, attempts: 1000, p_unblocked: 0.08 },
  { shot_type: "slap", dist_bucket: 2, attempts: 1000, p_unblocked: 0.06 },
  { shot_type: "snap", dist_bucket: 2, attempts: 1000, p_unblocked: 0.09 },
  { shot_type: "wrist", dist_bucket: 4, attempts: 1000, p_unblocked: 0.03 },
  { shot_type: "wrap-around", dist_bucket: 0, attempts: 10, p_unblocked: 0.05 },
  { shot_type: "tip-in", dist_bucket: 0, attempts: 500, p_unblocked: 0.2 },
];

// --- happy paths -------------------------------------------------------------
test("open pass beats a pass through a defender", () => {
  const passer = sk(77, "D-man", 60, 25), receiver = sk(86, "Winger", 69, -18);
  const open = passLikelihood(passer, receiver, []);
  const blocked = passLikelihood(passer, receiver, [{ pos: { x: 64.5, y: 3.5 } }]);
  assert.ok(open.ok && blocked.ok);
  assert.ok(open.value.p > blocked.value.p);
  assert.match(passSubtext(open.value, receiver), /^Pass to Winger · \d+% connects$/);
});

test("better playmaker raises completion", () => {
  const recv = sk(2, "R", 70, -15), defs = [{ pos: { x: 66, y: 0 } }];
  const avg = passLikelihood(sk(1, "A", 60, 20), recv, defs);
  const elite = passLikelihood(sk(1, "A", 60, 20, { playmakingMult: 1.5 }), recv, defs);
  assert.ok(avg.ok && elite.ok && elite.value.p > avg.value.p);
});

test("shot from slot beats shot from point; high glove beats low blocker", () => {
  const slot = shotLikelihood(sk(1, "S", 66, 0), goalie, "wrist", "high_glove", [], rates);
  const point = shotLikelihood(sk(1, "S", 40, 20), goalie, "wrist", "high_glove", [], rates);
  const low = shotLikelihood(sk(1, "S", 66, 0), goalie, "wrist", "low_blocker", [], rates);
  assert.ok(slot.ok && point.ok && low.ok);
  assert.ok(slot.value.pGoal > point.value.pGoal);
  assert.ok(slot.value.pGoal > low.value.pGoal);
});

test("skate to an open spot is likelier than into a defender", () => {
  const c = sk(1, "C", 60, 25);
  const open = skateLikelihood(c, "circle_top_left", []);
  const crowded = skateLikelihood(c, "circle_top_left", [{ pos: OZ_SPOTS.circle_top_left }]);
  assert.ok(open.ok && crowded.ok && open.value.p > crowded.value.p);
});

// --- edge cases (>= 5) ---------------------------------------------------------
test("edge: pass to self is an error, not a number", () => {
  const a = sk(1, "A", 60, 0);
  assert.deepEqual(passLikelihood(a, a, []).ok, false);
});

test("edge: non-positive multipliers are rejected", () => {
  assert.equal(passLikelihood(sk(1, "A", 60, 0, { playmakingMult: 0 }), sk(2, "B", 70, 0), []).ok, false);
  assert.equal(shotLikelihood(sk(1, "A", 70, 0, { finishingMult: -1 }), goalie, "wrist", "five_hole", [], rates).ok, false);
  assert.equal(shotLikelihood(sk(1, "A", 70, 0, { accuracy: 0 }), goalie, "wrist", "five_hole", [], rates).ok, false);
});

test("edge: sparse cell pools across shot types for the bucket", () => {
  const r = baseRate(rates, "wrap_around", 0);   // only 10 wrap-arounds -> pooled with tips
  assert.ok(r.ok);
  assert.ok(Math.abs(r.value - (10 * 0.05 + 500 * 0.2) / 510) < 1e-9);
});

test("edge: missing bucket returns an error", () => {
  assert.equal(baseRate(rates, "wrist", 5).ok, false);
});

test("edge: probabilities stay inside [0,1] at extreme inputs", () => {
  const hot = sk(1, "Hot", 88, 0, { finishingMult: 50, accuracy: 1 });
  const r = shotLikelihood(hot, { ...goalie, gaMult: 50 }, "tip", "high_glove", [], rates);
  assert.ok(r.ok && r.value.pGoal <= 0.9 && r.value.pGoal >= 0);
  const p = passLikelihood(sk(1, "A", -80, 40), sk(2, "B", 88, -40), []);
  assert.ok(p.ok && p.value.p >= 0.02 && p.value.p <= 0.98);
});

test("edge: defender behind the passer adds no lane threat", () => {
  assert.deepEqual(laneThreat({ x: 60, y: 0 }, { x: 80, y: 0 }, [{ pos: { x: 50, y: 0 } }], 4), { ok: true, value: 0 });
});

test("edge: zero-length lane is safe", () => {
  assert.deepEqual(laneThreat({ x: 60, y: 0 }, { x: 60, y: 0 }, [{ pos: { x: 60, y: 0 } }], 4), { ok: true, value: 0 });
});

test("edge: corner mapping flips with goalie catching hand", () => {
  assert.equal(zoneFor("top_right", goalie), "high_glove");
  assert.equal(zoneFor("top_right", { ...goalie, catchesLeft: false }), "high_blocker");
  assert.equal(zoneFor("five_hole", goalie), "five_hole");
});

test("zone factors average to 1 (calibration invariant)", () => {
  const v = Object.values(ZONE_FACTOR);
  assert.ok(Math.abs(v.reduce((a, b) => a + b, 0) / v.length - 1) < 1e-9);
});

test("pct formatting", () => {
  assert.equal(pct(0.004), "<1%");
  assert.equal(pct(0.784), "78%");
  assert.deepEqual(distanceBucket(500), { ok: true, value: 5 });
});

// --- modes ---------------------------------------------------------------------
test("daily: schedule hit, deterministic fallback, bad date", () => {
  const sched = [{ date: "2026-11-01", scenario_id: "A" }];
  assert.deepEqual(dailyScenario("2026-11-01", sched, ["X"]), { ok: true, value: "A" });
  const f1 = dailyScenario("2027-01-01", sched, ["b", "a", "c"]);
  const f2 = dailyScenario("2027-01-01", sched, ["c", "b", "a"]);
  assert.deepEqual(f1, f2);                       // export order does not matter
  assert.equal(dailyScenario("Nov 1", sched, ["a"]).ok, false);
  assert.equal(dailyScenario("2027-01-01", [], []).ok, false);
});

test("endless: no repeats within a pass, reproducible by seed, dedupes pool", () => {
  const pool = ["a", "b", "c", "d", "e", "a"];
  const c1 = EndlessQueue.create(pool, 42), c2 = EndlessQueue.create(pool, 42);
  assert.ok(c1.ok && c2.ok);
  const q1 = c1.value, q2 = c2.value;
  const pass1 = Array.from({ length: 5 }, () => q1.next());
  assert.equal(new Set(pass1.map((r) => (r.ok ? r.value : r.error))).size, 5);
  assert.deepEqual(pass1, Array.from({ length: 5 }, () => q2.next()));
  assert.equal(q1.size, 5);
  assert.equal(EndlessQueue.create([], 1).ok, false);
});

test("prng and hash are stable", () => {
  assert.equal(fnv1a("2026-11-01"), fnv1a("2026-11-01"));
  const r = mulberry32(7);
  const xs = Array.from({ length: 1000 }, r);
  assert.ok(xs.every((x) => x >= 0 && x < 1));
});
