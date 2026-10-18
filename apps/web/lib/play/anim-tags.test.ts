import { test } from "node:test";
import assert from "node:assert/strict";
import { OZ_SPOTS, type SpotName } from "@powerplay/engine/constants.ts";
import { estimateTagWidth, placeTag, type Size } from "./anim-tags.ts";
import { toRinkPercent } from "./geometry.ts";

const BOX: Size = { w: 350, h: 317 }; // 390 px phone, 20 px gutters, 85:77
const RADIUS = 22;
const MARGIN = 3;
const GAP = 4;

function placeAt(spot: SpotName, tag: Size, box: Size = BOX) {
  const r = toRinkPercent(OZ_SPOTS[spot]);
  assert.ok(r.ok);
  const anchor = { x: (r.value.leftPct / 100) * box.w, y: (r.value.topPct / 100) * box.h };
  const p = placeTag({ anchor, tokenRadius: RADIUS, tag, box, gap: GAP, margin: MARGIN });
  assert.ok(p.ok, p.ok ? "" : p.error);
  return { anchor, placed: p.value };
}

function assertInside(x: number, y: number, tag: Size, box: Size) {
  assert.ok(
    x >= 0 && y >= 0 && x + tag.w <= box.w && y + tag.h <= box.h,
    `tag at ${x},${y} ${tag.w}x${tag.h} escapes ${box.w}x${box.h}`,
  );
}

const SPOTS: SpotName[] = [
  "point_left", "point_right", "half_wall_left", "half_wall_right", "goal_line_left", "goal_line_right",
  "circle_top_left", "circle_top_right", "hash_left", "hash_right", "net_front", "slot", "bumper_slot", "point_middle",
];

test("a short name under a centred skater sits below the token, centred on it", () => {
  const { anchor, placed } = placeAt("slot", { w: 40, h: 17 });
  assert.equal(placed.side, "below");
  assert.equal(placed.x, anchor.x - 20);
  assert.ok(placed.y >= anchor.y + RADIUS);
});

test("every spot, long name: the tag stays fully inside the rink", () => {
  const tag = { w: 76, h: 17 };
  for (const spot of SPOTS) {
    const { placed } = placeAt(spot, tag);
    assertInside(placed.x, placed.y, tag, BOX);
    assert.equal(placed.fits, true);
  }
});

test("right-side spots slide left, left-side spots slide right (point, half wall, goal line)", () => {
  const tag = { w: 76, h: 17 };
  const pairs = [["point_left", "point_right"], ["half_wall_left", "half_wall_right"], ["goal_line_left", "goal_line_right"]] as const;
  for (const [l, r] of pairs) {
    const a = placeAt(l, tag);
    const b = placeAt(r, tag);
    assert.ok(a.placed.x >= MARGIN);
    assert.ok(b.placed.x + tag.w <= BOX.w - MARGIN);
    // still anchored to its own token: the token centre is within the tag's horizontal span
    assert.ok(a.anchor.x >= a.placed.x && a.anchor.x <= a.placed.x + tag.w);
    assert.ok(b.anchor.x >= b.placed.x && b.anchor.x <= b.placed.x + tag.w);
  }
});

test("a skater at the bottom edge flips the tag above the token", () => {
  const anchor = { x: 175, y: 300 };
  const p = placeTag({ anchor, tokenRadius: RADIUS, tag: { w: 60, h: 17 }, box: BOX, gap: GAP, margin: MARGIN });
  assert.ok(p.ok);
  assert.equal(p.value.side, "above");
  assert.ok(p.value.y + 17 <= anchor.y - RADIUS);
});

test("no room above or below: the tag is clamped inside rather than escaping", () => {
  const box = { w: 200, h: 60 };
  const p = placeTag({ anchor: { x: 100, y: 30 }, tokenRadius: RADIUS, tag: { w: 60, h: 17 }, box, gap: GAP, margin: MARGIN });
  assert.ok(p.ok);
  assertInside(p.value.x, p.value.y, { w: 60, h: 17 }, box);
});

test("a tag wider than the box is centred and reported as not fitting", () => {
  const p = placeTag({
    anchor: { x: 20, y: 20 }, tokenRadius: RADIUS, tag: { w: 120, h: 17 }, box: { w: 100, h: 100 }, gap: GAP, margin: MARGIN,
  });
  assert.ok(p.ok);
  assert.equal(p.value.fits, false);
  assert.equal(p.value.x, -10);
});

test("token in a corner of the box still yields an in-box tag", () => {
  const tag = { w: 76, h: 17 };
  for (const anchor of [{ x: 0, y: 0 }, { x: BOX.w, y: 0 }, { x: 0, y: BOX.h }, { x: BOX.w, y: BOX.h }]) {
    const p = placeTag({ anchor, tokenRadius: RADIUS, tag, box: BOX, gap: GAP, margin: MARGIN });
    assert.ok(p.ok);
    assertInside(p.value.x, p.value.y, tag, BOX);
  }
});

test("narrow 320 px phone box: long names on every spot still fit", () => {
  const box = { w: 280, h: 254 };
  const tag = { w: 80, h: 17 };
  for (const spot of SPOTS) {
    const { placed } = placeAt(spot, tag, box);
    assertInside(placed.x, placed.y, tag, box);
  }
});

test("bad input is an error, not NaN output", () => {
  const good = { anchor: { x: 10, y: 10 }, tokenRadius: RADIUS, tag: { w: 40, h: 17 }, box: BOX, gap: GAP, margin: MARGIN };
  assert.equal(placeTag({ ...good, anchor: { x: Number.NaN, y: 1 } }).ok, false);
  assert.equal(placeTag({ ...good, box: { w: 0, h: 100 } }).ok, false);
  assert.equal(placeTag({ ...good, tag: { w: 0, h: 17 } }).ok, false);
  assert.equal(placeTag({ ...good, gap: Infinity }).ok, false);
});

test("estimateTagWidth grows with the name and never goes negative", () => {
  assert.equal(estimateTagWidth("", 7, 7), 14);
  assert.ok(estimateTagWidth("SAMSONOV", 7, 7) > estimateTagWidth("LEE", 7, 7));
});
