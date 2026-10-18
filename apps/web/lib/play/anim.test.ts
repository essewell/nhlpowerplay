import { test } from "node:test";
import assert from "node:assert/strict";
import { FACEOFF_DOTS, NET, OZ_SPOTS } from "@powerplay/engine/constants.ts";
import type { RunEvent } from "@powerplay/engine/sim-types.ts";
import {
  ANIM_MAX_MS, ANIM_MIN_MS, buildPuckPath, clipToArt, durationMs, easeInOutCubic, isContinuation, MEMO_STALE_MS,
  pathLength, pkAt, planMotion, ppAt, puckAt, toMemo, type RinkSnapshot,
} from "./anim.ts";
import { advanceRink, resetRinkMemory } from "./anim-memory.ts";
import { RINK_VIEWBOX } from "./geometry.ts";

const ev = (i: number, kind: string, detail?: RunEvent["detail"]): RunEvent => ({
  i, callIndex: null, atS: i, clock: { period: 1, elapsedS: i }, kind, ...(detail === undefined ? {} : { detail }),
});
const call = (i: number, type: string): RunEvent => ev(i, "call", { type });

const snap = (over: Partial<RinkSnapshot> & { log: RunEvent[] }): RinkSnapshot => ({
  puck: OZ_SPOTS.point_left,
  pkPos: [{ x: 70, y: 0 }],
  ppSpots: [{ id: 1, spot: "point_left" }, { id: 2, spot: "point_right" }],
  carrier: { kind: "pp", id: 1 },
  ...over,
});

const near = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

// ---------------------------------------------------------------- easing and path sampling
test("easeInOutCubic: endpoints, midpoint, shape", () => {
  assert.equal(easeInOutCubic(0), 0);
  assert.equal(easeInOutCubic(1), 1);
  near(easeInOutCubic(0.5), 0.5);
  assert.ok(easeInOutCubic(0.25) < 0.25 && easeInOutCubic(0.75) > 0.75);
});

test("easeInOutCubic: out-of-range and NaN input clamp (NaN means finished)", () => {
  assert.equal(easeInOutCubic(-3), 0);
  assert.equal(easeInOutCubic(9), 1);
  assert.equal(easeInOutCubic(Number.NaN), 1);
});

test("puckAt: samples by length across a multi-segment path", () => {
  const path = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }]; // 10 + 30 = 40
  const quarter = puckAt(path, 0.25);
  assert.ok(quarter.ok);
  near(quarter.value.x, 10);
  near(quarter.value.y, 0);
  const mid = puckAt(path, 0.5);
  assert.ok(mid.ok);
  near(mid.value.y, 10);
});

test("puckAt: t=0 and t=1 are the first and last point", () => {
  const path = [{ x: 1, y: 2 }, { x: 5, y: 6 }];
  const a = puckAt(path, 0);
  const b = puckAt(path, 1);
  assert.ok(a.ok && b.ok);
  assert.deepEqual(a.value, path[0]);
  assert.deepEqual(b.value, path[1]);
});

test("puckAt: zero-length path, single point and empty path", () => {
  const same = puckAt([{ x: 3, y: 3 }, { x: 3, y: 3 }], 0.5);
  assert.ok(same.ok);
  assert.deepEqual(same.value, { x: 3, y: 3 });
  assert.ok(puckAt([{ x: 3, y: 3 }], 0.7).ok);
  assert.equal(puckAt([], 0.5).ok, false);
});

test("puckAt: zero-length middle segment does not divide by zero", () => {
  const r = puckAt([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 10, y: 0 }], 0.5);
  assert.ok(r.ok);
  near(r.value.x, 5);
});

// ---------------------------------------------------------------- clipToArt
test("clipToArt: a clear toward centre ice leaves through the bottom edge of the art", () => {
  const exit = clipToArt({ x: 60, y: 10 }, FACEOFF_DOTS.centre);
  near(exit.x, 100 - RINK_VIEWBOX.height);
  assert.ok(exit.y > 0 && exit.y < 10, "stays on the line toward the centre");
});

test("clipToArt: a target already inside the art is returned unchanged", () => {
  assert.deepEqual(clipToArt({ x: 60, y: 0 }, { x: 80, y: 5 }), { x: 80, y: 5 });
});

test("clipToArt: a target past the side boards is cut at the boards", () => {
  near(clipToArt({ x: 60, y: 0 }, { x: 60, y: 90 }).y, 42.5);
  near(clipToArt({ x: 60, y: 0 }, { x: 60, y: -90 }).y, -42.5);
});

test("clipToArt: starting outside the art falls back to the target", () => {
  assert.deepEqual(clipToArt({ x: 10, y: 0 }, { x: 0, y: 0 }), { x: 0, y: 0 });
});

// ---------------------------------------------------------------- buildPuckPath
test("buildPuckPath: a pass goes straight from the old puck to the new one", () => {
  const r = buildPuckPath(OZ_SPOTS.point_left, OZ_SPOTS.half_wall_left, [call(5, "pass"), ev(6, "draw:pass", { hit: true })]);
  assert.ok(r.ok);
  assert.deepEqual(r.value, [OZ_SPOTS.point_left, OZ_SPOTS.half_wall_left]);
});

test("buildPuckPath: a skate is a straight line too", () => {
  const r = buildPuckPath(OZ_SPOTS.point_left, OZ_SPOTS.circle_top_left, [call(5, "skate")]);
  assert.ok(r.ok);
  assert.equal(r.value.length, 2);
});

test("buildPuckPath: a saved shot goes to the net, then to the rebound spot", () => {
  const events = [call(5, "shoot"), ev(6, "draw:block", { hit: false }), ev(7, "save")];
  const r = buildPuckPath(OZ_SPOTS.slot, OZ_SPOTS.net_front, events);
  assert.ok(r.ok);
  assert.deepEqual(r.value, [OZ_SPOTS.slot, { x: NET.x, y: NET.y }, OZ_SPOTS.net_front]);
});

test("buildPuckPath: a blocked shot never reaches the net", () => {
  const r = buildPuckPath(OZ_SPOTS.slot, OZ_SPOTS.slot, [call(5, "shoot"), ev(6, "draw:block", { hit: true })]);
  assert.ok(r.ok);
  assert.ok(!r.value.some((p) => p.x === NET.x && p.y === NET.y));
});

test("buildPuckPath: a shot that misses goes straight to the wide spot, not via the net", () => {
  const r = buildPuckPath(OZ_SPOTS.slot, OZ_SPOTS.goal_line_left, [call(5, "shoot"), ev(7, "miss")]);
  assert.ok(r.ok);
  assert.deepEqual(r.value, [OZ_SPOTS.slot, OZ_SPOTS.goal_line_left]);
});

test("buildPuckPath: a PP goal ends at the net, not at the next faceoff", () => {
  const r = buildPuckPath(OZ_SPOTS.slot, FACEOFF_DOTS.centre, [call(5, "shoot"), ev(7, "goal", { side: "pp" })]);
  assert.ok(r.ok);
  assert.deepEqual(r.value, [OZ_SPOTS.slot, { x: NET.x, y: NET.y }]);
});

test("buildPuckPath: a clear runs off the bottom edge, then back to the new puck", () => {
  const r = buildPuckPath(OZ_SPOTS.point_left, OZ_SPOTS.point_middle, [call(5, "pass"), ev(8, "clear", { remainingS: 30 })]);
  assert.ok(r.ok);
  assert.equal(r.value.length, 3);
  near(r.value[1]?.x ?? Number.NaN, 100 - RINK_VIEWBOX.height);
});

test("buildPuckPath: no movement still yields two points; non-finite input is an error", () => {
  const still = buildPuckPath(OZ_SPOTS.slot, OZ_SPOTS.slot, [call(5, "pass")]);
  assert.ok(still.ok);
  assert.equal(still.value.length, 2);
  assert.equal(buildPuckPath({ x: Number.NaN, y: 0 }, OZ_SPOTS.slot, []).ok, false);
  assert.equal(buildPuckPath(OZ_SPOTS.slot, { x: 0, y: Infinity }, []).ok, false);
});

// ---------------------------------------------------------------- skaters
test("ppAt: interpolates a skater that moved, leaves one that did not, drops in a newcomer", () => {
  const prev = [{ id: 1, spot: "point_left" as const }, { id: 2, spot: "point_right" as const }];
  const next = [
    { id: 1, spot: "point_middle" as const }, { id: 2, spot: "point_right" as const }, { id: 3, spot: "slot" as const },
  ];
  const half = ppAt(prev, next, 0.5);
  near(half[0]?.pos.y ?? Number.NaN, 11);
  assert.deepEqual(half[1]?.pos, OZ_SPOTS.point_right);
  assert.deepEqual(half[2]?.pos, OZ_SPOTS.slot);
  assert.deepEqual(ppAt(prev, next, 0)[0]?.pos, OZ_SPOTS.point_left);
  assert.deepEqual(ppAt(prev, next, 1)[0]?.pos, OZ_SPOTS.point_middle);
});

test("pkAt: matches by index; extra defenders on either side are not invented", () => {
  const prev = [{ x: 60, y: 0 }];
  const next = [{ x: 70, y: 0 }, { x: 50, y: 5 }];
  const half = pkAt(prev, next, 0.5);
  assert.equal(half.length, 2);
  near(half[0]?.x ?? Number.NaN, 65);
  assert.deepEqual(half[1], { x: 50, y: 5 });
  assert.equal(pkAt(next, prev, 0.5).length, 1);
  assert.deepEqual(pkAt([], [], 0.5), []);
});

// ---------------------------------------------------------------- duration
test("durationMs: 400-700 ms, longer for longer moves, safe on junk", () => {
  assert.equal(durationMs(0), ANIM_MIN_MS);
  assert.equal(durationMs(10_000), ANIM_MAX_MS);
  assert.ok(durationMs(30) > durationMs(10));
  assert.equal(durationMs(Number.NaN), ANIM_MIN_MS);
  assert.equal(durationMs(-5), ANIM_MIN_MS);
});

// ---------------------------------------------------------------- memory -> plan
const base = (): RinkSnapshot => snap({ log: [ev(0, "faceoff_setup"), ev(1, "call"), ev(2, "draw:faceoff")] });
const after = (): RinkSnapshot =>
  snap({
    puck: OZ_SPOTS.half_wall_left,
    carrier: { kind: "pp", id: 2 },
    log: [...(base().log ?? []), call(3, "pass"), ev(4, "draw:pass", { hit: true })],
  });
const NO_PLAN = { ok: true, value: null };

test("planMotion: a later state of the same run animates with a path and a duration", () => {
  const plan = planMotion(toMemo(base(), 1000), after(), 1200, false);
  assert.ok(plan.ok && plan.value !== null);
  assert.deepEqual(plan.value.puckPath, [OZ_SPOTS.point_left, OZ_SPOTS.half_wall_left]);
  assert.ok(plan.value.durationMs >= ANIM_MIN_MS && plan.value.durationMs <= ANIM_MAX_MS);
  assert.equal(plan.value.prevPuckHeld, true);
});

test("planMotion: reduced motion, first draw and missing log give no plan", () => {
  const memo = toMemo(base(), 1000);
  assert.deepEqual(planMotion(memo, after(), 1200, true), NO_PLAN);
  assert.deepEqual(planMotion(null, after(), 1200, false), NO_PLAN);
  const noLog: RinkSnapshot = { ...after() };
  delete noLog.log;
  assert.deepEqual(planMotion(memo, noLog, 1200, false), NO_PLAN);
});

test("planMotion: stale memory, a clock that went backwards, or non-finite now give no plan", () => {
  const memo = toMemo(base(), 1000);
  assert.deepEqual(planMotion(memo, after(), 1000 + MEMO_STALE_MS + 1, false), NO_PLAN);
  assert.deepEqual(planMotion(memo, after(), 500, false), NO_PLAN);
  assert.deepEqual(planMotion(memo, after(), Number.NaN, false), NO_PLAN);
});

test("planMotion: the same state again, or a different run, gives no plan", () => {
  const memo = toMemo(base(), 1000);
  assert.deepEqual(planMotion(memo, base(), 1100, false), NO_PLAN);
  const other = snap({ log: [ev(0, "end"), ev(1, "call"), ev(2, "draw:x"), ev(3, "draw:y")] });
  assert.equal(isContinuation(memo, other), false);
  assert.deepEqual(planMotion(memo, other, 1100, false), NO_PLAN);
});

test("planMotion: new events but nothing moved gives no plan", () => {
  const next = snap({ log: [...(base().log ?? []), ev(3, "period_end")] });
  assert.deepEqual(planMotion(toMemo(base(), 1000), next, 1100, false), NO_PLAN);
});

test("planMotion: a skater that only changes spot still animates (puck unchanged)", () => {
  const next = snap({
    ppSpots: [{ id: 1, spot: "point_left" }, { id: 2, spot: "half_wall_right" }],
    log: [...(base().log ?? []), call(3, "skate")],
  });
  const plan = planMotion(toMemo(base(), 1000), next, 1100, false);
  assert.ok(plan.ok && plan.value !== null);
});

test("planMotion: a memo from an empty log accepts any later log", () => {
  assert.equal(isContinuation(toMemo(snap({ log: [] }), 0), after()), true);
});

test("planMotion: non-finite puck surfaces as an error", () => {
  const bad = { ...after(), puck: { x: Number.NaN, y: 0 } };
  assert.equal(planMotion(toMemo(base(), 1000), bad, 1100, false).ok, false);
});

test("pathLength sums segments", () => {
  near(pathLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 3, y: 10 }]), 11);
  assert.equal(pathLength([]), 0);
});

// ---------------------------------------------------------------- module memory (remount / StrictMode)
test("advanceRink: first call has no plan, the next later state does, a repeat within a second reuses it", () => {
  resetRinkMemory();
  assert.deepEqual(advanceRink(base(), 1000, false), NO_PLAN);
  const second = advanceRink(after(), 1500, false);
  assert.ok(second.ok && second.value !== null);
  const again = advanceRink(after(), 1600, false); // StrictMode's second effect run
  assert.ok(again.ok && again.value !== null);
  assert.deepEqual(advanceRink(after(), 5000, false), NO_PLAN); // a remount much later: nothing to animate
  resetRinkMemory();
});

test("advanceRink: reduced motion never returns a plan, even for a cached state", () => {
  resetRinkMemory();
  advanceRink(base(), 1000, false);
  advanceRink(after(), 1500, false);
  assert.deepEqual(advanceRink(after(), 1600, true), NO_PLAN);
  resetRinkMemory();
});
