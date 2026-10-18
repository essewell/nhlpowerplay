import { test } from "node:test";
import assert from "node:assert/strict";
import { NET, OZ_BOUNDS, OZ_SPOTS, PK, PK_TEMPLATES, PP_FORMATIONS } from "./constants.ts";
import type { SpotName } from "./constants.ts";
import { moveCarrierTo, nearestPp, pkPositions, placePp, spotPos } from "./formation.ts";
import { dist } from "./likelihood.ts";
import type { Vec2 } from "./likelihood.ts";
import type { Result } from "./result.ts";

function unwrap<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${r.error}`);
  return r.value;
}

function inZone(p: Vec2): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y)
    && p.x >= OZ_BOUNDS.X_MIN && p.x <= OZ_BOUNDS.X_MAX && Math.abs(p.y) <= OZ_BOUNDS.Y_ABS_MAX;
}

// ---------------------------------------------------------------- spotPos

test("spotPos: returns the OZ_SPOTS coordinates", () => {
  assert.deepEqual(spotPos("net_front"), OZ_SPOTS.net_front);
  assert.deepEqual(spotPos("point_left"), { x: 33, y: 22 });
});

test("spotPos: every spot is finite and inside the offensive zone", () => {
  for (const name of Object.keys(OZ_SPOTS) as SpotName[]) assert.ok(inZone(spotPos(name)), name);
});

test("spotPos: returns a fresh object (mutating it does not change OZ_SPOTS)", () => {
  const p = spotPos("slot");
  p.x = -999;
  assert.equal(OZ_SPOTS.slot.x, 75);
  assert.notEqual(spotPos("slot"), spotPos("slot"));
});

test("spotPos: left spots have y > 0 and right spots y < 0", () => {
  assert.ok(spotPos("half_wall_left").y > 0);
  assert.ok(spotPos("half_wall_right").y < 0);
});

test("spotPos: centre spots sit on y = 0", () => {
  for (const s of ["point_middle", "bumper_slot", "slot", "net_front"] as const) assert.equal(spotPos(s).y, 0);
});

// ---------------------------------------------------------------- PP_FORMATIONS table

test("PP_FORMATIONS: each list has the right length and distinct spots", () => {
  for (const [name, f] of Object.entries(PP_FORMATIONS)) {
    for (const n of [4, 5, 6] as const) {
      const spots = f[n];
      assert.equal(spots.length, n, `${name}/${n}`);
      assert.equal(new Set(spots).size, n, `${name}/${n} duplicates`);
    }
  }
});

// ---------------------------------------------------------------- placePp

test("placePp: umbrella 5 — carrier gets the first spot, others in input order", () => {
  const r = unwrap(placePp([10, 11, 12, 13, 14], "umbrella", 12));
  assert.deepEqual(r, [
    { id: 12, spot: "point_middle" },
    { id: 10, spot: "half_wall_left" },
    { id: 11, spot: "half_wall_right" },
    { id: 13, spot: "bumper_slot" },
    { id: 14, spot: "net_front" },
  ]);
});

test("placePp: one_three_one 4 and 6 use their own lists", () => {
  const four = unwrap(placePp([1, 2, 3, 4], "one_three_one", 1));
  assert.deepEqual(four.map((s) => s.spot), PP_FORMATIONS.one_three_one[4]);
  const six = unwrap(placePp([1, 2, 3, 4, 5, 6], "one_three_one", 6));
  assert.deepEqual(six.map((s) => s.spot), PP_FORMATIONS.one_three_one[6]);
  assert.deepEqual(six[0], { id: 6, spot: "half_wall_right" });
});

test("placePp: every placed skater holds a distinct spot", () => {
  const r = unwrap(placePp([7, 8, 9, 10, 11, 12], "umbrella", 9));
  assert.equal(new Set(r.map((s) => s.spot)).size, 6);
  assert.equal(new Set(r.map((s) => s.id)).size, 6);
});

test("placePp: bad skater counts are errors", () => {
  for (const ids of [[], [1], [1, 2, 3], [1, 2, 3, 4, 5, 6, 7]]) {
    const r = placePp(ids, "umbrella", 1);
    assert.equal(r.ok, false, `count ${ids.length}`);
  }
});

test("placePp: duplicate ids are an error", () => {
  const r = placePp([1, 2, 2, 3, 4], "umbrella", 1);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /duplicate/);
});

test("placePp: carrier not in the list is an error", () => {
  const r = placePp([1, 2, 3, 4, 5], "umbrella", 99);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /carrier/);
});

test("placePp: non-integer / non-finite ids are errors", () => {
  assert.equal(placePp([1, 2, 3, 4, Number.NaN], "umbrella", 1).ok, false);
  assert.equal(placePp([1, 2, 3, 4, 1.5], "umbrella", 1).ok, false);
});

test("placePp: unknown formation name is an error (untyped caller)", () => {
  const r = placePp([1, 2, 3, 4, 5], "two_three" as unknown as "umbrella", 1);
  assert.equal(r.ok, false);
});

test("placePp: does not mutate the input array", () => {
  const ids = [5, 4, 3, 2, 1];
  unwrap(placePp(ids, "umbrella", 3));
  assert.deepEqual(ids, [5, 4, 3, 2, 1]);
});

// ---------------------------------------------------------------- moveCarrierTo

const base = (): { id: number; spot: SpotName }[] => unwrap(placePp([1, 2, 3, 4, 5], "umbrella", 1));

test("moveCarrierTo: carrier moves to a free spot, nobody else moves", () => {
  const r = unwrap(moveCarrierTo(base(), 1, "slot"));
  assert.deepEqual(r, [
    { id: 1, spot: "slot" },
    { id: 2, spot: "half_wall_left" },
    { id: 3, spot: "half_wall_right" },
    { id: 4, spot: "bumper_slot" },
    { id: 5, spot: "net_front" },
  ]);
});

test("moveCarrierTo: occupied spot swaps the teammate to the carrier's old spot", () => {
  const r = unwrap(moveCarrierTo(base(), 1, "net_front"));
  assert.deepEqual(r.find((s) => s.id === 1), { id: 1, spot: "net_front" });
  assert.deepEqual(r.find((s) => s.id === 5), { id: 5, spot: "point_middle" });
  assert.equal(new Set(r.map((s) => s.spot)).size, 5);
});

test("moveCarrierTo: moving to the carrier's own spot is a no-op", () => {
  assert.deepEqual(unwrap(moveCarrierTo(base(), 3, "half_wall_right")), base());
});

test("moveCarrierTo: carrier not present is an error", () => {
  assert.equal(moveCarrierTo(base(), 42, "slot").ok, false);
});

test("moveCarrierTo: unknown spot name is an error (untyped caller)", () => {
  assert.equal(moveCarrierTo(base(), 1, "blue_paint" as unknown as SpotName).ok, false);
});

test("moveCarrierTo: does not mutate the input and preserves order", () => {
  const spots = base();
  const before = JSON.stringify(spots);
  const r = unwrap(moveCarrierTo(spots, 2, "point_middle"));
  assert.equal(JSON.stringify(spots), before);
  assert.deepEqual(r.map((s) => s.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(r[0], { id: 1, spot: "half_wall_left" });
});

test("moveCarrierTo: duplicate ids in the input are an error", () => {
  const spots = [{ id: 1, spot: "slot" as const }, { id: 1, spot: "net_front" as const }];
  assert.equal(moveCarrierTo(spots, 1, "point_middle").ok, false);
});

// ---------------------------------------------------------------- nearestPp

test("nearestPp: returns the skater whose spot is nearest", () => {
  assert.equal(unwrap(nearestPp(base(), { x: 85, y: 1 })), 5);
  assert.equal(unwrap(nearestPp(base(), { x: 30, y: 0 })), 1);
});

test("nearestPp: exact tie goes to the lowest id", () => {
  const spots = [{ id: 9, spot: "half_wall_left" as const }, { id: 4, spot: "half_wall_right" as const }];
  assert.equal(unwrap(nearestPp(spots, { x: 58, y: 0 })), 4);
  const rev = [{ id: 4, spot: "half_wall_left" as const }, { id: 9, spot: "half_wall_right" as const }];
  assert.equal(unwrap(nearestPp(rev, { x: 58, y: 0 })), 4);
});

test("nearestPp: empty list is an error", () => {
  assert.equal(nearestPp([], { x: 50, y: 0 }).ok, false);
});

test("nearestPp: non-finite point is an error", () => {
  assert.equal(nearestPp(base(), { x: Number.NaN, y: 0 }).ok, false);
  assert.equal(nearestPp(base(), { x: 0, y: Number.POSITIVE_INFINITY }).ok, false);
});

test("nearestPp: point outside the zone still resolves", () => {
  assert.equal(unwrap(nearestPp(base(), { x: -80, y: 0 })), 1);
});

test("nearestPp: single skater", () => {
  assert.equal(unwrap(nearestPp([{ id: 3, spot: "slot" }], { x: 0, y: 0 })), 3);
});

// ---------------------------------------------------------------- pkPositions

test("pkPositions: puck on the anchor puts the template on the anchor, nearest defender pressures", () => {
  const puck = { x: PK.ANCHOR.x, y: PK.ANCHOR.y };
  const r = unwrap(pkPositions(puck, 3));
  assert.equal(r.length, 3);
  // Triangle low defender (offset 8,0) is nearest the anchor; it pressures along puck->net.
  const t = PK_TEMPLATES.triangle;
  const t0 = t[0], t1 = t[1];
  assert.ok(t0 !== undefined && t1 !== undefined);
  assert.deepEqual(r[0], { x: PK.ANCHOR.x + t0.x, y: PK.ANCHOR.y + t0.y });
  assert.deepEqual(r[1], { x: PK.ANCHOR.x + t1.x, y: PK.ANCHOR.y + t1.y });
  assert.deepEqual(r[2], { x: PK.ANCHOR.x + PK.PRESSURE_GAP_FT, y: 0 });
});

test("pkPositions: counts 3/4/5 give 3/4/5 positions; 4 uses PK.FORMATION_4", () => {
  for (const n of [3, 4, 5]) assert.equal(unwrap(pkPositions({ x: 40, y: 10 }, n)).length, n);
  // Far-away puck: the template is only shifted, and the nearest one pressures.
  const puck = { x: 40, y: 0 };
  const r = unwrap(pkPositions(puck, 4));
  const tpl = PK_TEMPLATES[PK.FORMATION_4];
  const shifted = tpl.map((o) => ({
    x: PK.ANCHOR.x + o.x + PK.SHIFT_K * (puck.x - PK.ANCHOR.x),
    y: PK.ANCHOR.y + o.y + PK.SHIFT_K * (puck.y - PK.ANCHOR.y),
  }));
  let moved = 0;
  r.forEach((p, i) => {
    const s = shifted[i];
    assert.ok(s !== undefined);
    if (Math.abs(p.x - s.x) > 1e-9 || Math.abs(p.y - s.y) > 1e-9) moved++;
  });
  assert.equal(moved, 1);
});

test("pkPositions: pressuring defender is PRESSURE_GAP_FT from the puck, between puck and net", () => {
  const puck = { x: 58, y: -36 };
  const r = unwrap(pkPositions(puck, 4));
  const near = r.reduce((a, b) => (dist(a, puck) <= dist(b, puck) ? a : b));
  assert.ok(Math.abs(dist(near, puck) - PK.PRESSURE_GAP_FT) < 1e-9);
  assert.ok(Math.abs(dist(near, NET) + dist(near, puck) - dist(puck, NET)) < 1e-9);
});

test("pkPositions: bad PK counts are errors", () => {
  for (const n of [0, 1, 2, 6, 3.5, Number.NaN]) assert.equal(pkPositions({ x: 50, y: 0 }, n).ok, false, `n=${n}`);
});

test("pkPositions: NaN / infinite puck is an error", () => {
  assert.equal(pkPositions({ x: Number.NaN, y: 0 }, 4).ok, false);
  assert.equal(pkPositions({ x: 50, y: Number.NEGATIVE_INFINITY }, 4).ok, false);
});

test("pkPositions: puck exactly at the net is handled (finite, in zone)", () => {
  const r = unwrap(pkPositions({ x: NET.x, y: NET.y }, 4));
  for (const p of r) assert.ok(inZone(p));
  const near = r.reduce((a, b) => (dist(a, NET) <= dist(b, NET) ? a : b));
  assert.ok(Math.abs(dist(near, NET) - PK.PRESSURE_GAP_FT) < 1e-9);
  assert.ok(near.x < NET.x);
});

test("pkPositions: puck at the blue line keeps everyone in the zone", () => {
  for (const y of [-OZ_BOUNDS.Y_ABS_MAX, 0, OZ_BOUNDS.Y_ABS_MAX]) {
    for (const p of unwrap(pkPositions({ x: OZ_BOUNDS.X_MIN, y }, 4))) assert.ok(inZone(p), JSON.stringify(p));
  }
});

test("pkPositions: puck outside the zone (neutral zone, behind the boards) is clamped", () => {
  for (const puck of [{ x: -50, y: 0 }, { x: 140, y: 80 }, { x: 60, y: -200 }]) {
    for (const p of unwrap(pkPositions(puck, 5))) assert.ok(inZone(p), JSON.stringify({ puck, p }));
  }
});

test("pkPositions: all positions finite and inside the zone over a grid of pucks", () => {
  for (let x = OZ_BOUNDS.X_MIN; x <= OZ_BOUNDS.X_MAX; x += 5) {
    for (let y = -OZ_BOUNDS.Y_ABS_MAX; y <= OZ_BOUNDS.Y_ABS_MAX; y += 2.5) {
      for (const n of [3, 4, 5]) {
        const r = unwrap(pkPositions({ x, y }, n));
        assert.equal(r.length, n);
        for (const p of r) assert.ok(inZone(p), JSON.stringify({ x, y, n, p }));
      }
    }
  }
});

test("pkPositions: mirror symmetry — puck at -y mirrors positions (template is symmetric)", () => {
  const a = unwrap(pkPositions({ x: 60, y: 20 }, 4));
  const b = unwrap(pkPositions({ x: 60, y: -20 }, 4));
  const ys = (r: Vec2[]): number[] => r.map((p) => Math.round(p.y * 1e9) / 1e9).sort((u, v) => u - v);
  assert.deepEqual(ys(a), ys(b).map((v) => -v).sort((u, v) => u - v));
});

// ---------------------------------------------------------------- determinism

test("determinism: identical inputs give identical outputs across repeated calls", () => {
  const run = (): string => JSON.stringify([
    placePp([3, 1, 2, 5, 4], "one_three_one", 2),
    moveCarrierTo(base(), 1, "bumper_slot"),
    nearestPp(base(), { x: 61, y: 3 }),
    pkPositions({ x: 47.3, y: -12.9 }, 4),
    pkPositions({ x: 88, y: 2 }, 3),
    pkPositions({ x: 30, y: 40 }, 5),
  ]);
  const first = run();
  for (let i = 0; i < 5; i++) assert.equal(run(), first);
});
