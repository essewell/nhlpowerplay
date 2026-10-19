import { test } from "node:test";
import assert from "node:assert/strict";
import { OZ_SPOTS, PP_FORMATIONS } from "@powerplay/engine/constants.ts";
import { toRink } from "./geometry.ts";
import {
  availableFormations, clampSkaters, DEFAULT_FORMATION, FORMATION_ORDER, formationChipText, formationDiagram,
  formationLabel, formationSub, isFormationName,
} from "./formations.ts";

test("formationDiagram happy path: one dot per skater, positions are the engine spots through toRink", () => {
  const d = formationDiagram("umbrella", 5, "left");
  assert.ok(d.ok);
  assert.equal(d.value.length, 5);
  const first = d.value[0];
  assert.ok(first !== undefined);
  const expected = toRink(OZ_SPOTS.point_middle);
  assert.ok(expected.ok);
  assert.deepEqual({ x: first.x, y: first.y }, expected.value);
  assert.equal(first.id, "point_middle");
});

test("formationDiagram: skater count picks the 4 / 5 / 6 layout", () => {
  for (const n of [4, 5, 6]) {
    const d = formationDiagram("one_three_one", n, "left");
    assert.ok(d.ok);
    assert.equal(d.value.length, n);
  }
});

test("formationDiagram edge: counts outside 4..6 and junk clamp to the nearest layout", () => {
  const sizes = (n: number): number => {
    const d = formationDiagram("umbrella", n, "left");
    assert.ok(d.ok);
    return d.value.length;
  };
  assert.equal(sizes(3), 4);
  assert.equal(sizes(0), 4);
  assert.equal(sizes(7), 6);
  assert.equal(sizes(Number.NaN), 5);
  assert.equal(sizes(Number.POSITIVE_INFINITY), 5);
  assert.equal(clampSkaters(-2), 4);
});

test("formationDiagram edge: overload mirrors across the centre line for the right side", () => {
  const left = formationDiagram("overload", 5, "left");
  const right = formationDiagram("overload", 5, "right");
  assert.ok(left.ok && right.ok);
  assert.ok(left.value.some((d) => d.x !== 0), "overload actually has off-centre dots");
  const key = (ds: { x: number; y: number }[]): string[] => ds.map((d) => `${d.x},${d.y}`).sort();
  const mirrored = left.value.map((d) => ({ x: d.x === 0 ? 0 : -d.x, y: d.y }));
  assert.deepEqual(key(mirrored), key(right.value));
});

test("formationDiagram edge: formations other than overload ignore the side", () => {
  for (const f of ["umbrella", "one_three_one", "spread"] as const) {
    assert.deepEqual(formationDiagram(f, 5, "left"), formationDiagram(f, 5, "right"), f);
  }
});

test("availableFormations: the engine's formations in picker order; a table missing some is filtered; never empty", () => {
  assert.deepEqual(availableFormations(), [...FORMATION_ORDER]);
  assert.deepEqual(availableFormations({ spread: {}, umbrella: {} }), ["umbrella", "spread"]);
  assert.deepEqual(availableFormations({}), [DEFAULT_FORMATION]);
});

test("every engine formation yields a diagram for 4, 5 and 6 skaters on both sides, and the UI knows its name", () => {
  for (const f of availableFormations()) {
    for (const n of [4, 5, 6]) {
      for (const side of ["left", "right"] as const) {
        const d = formationDiagram(f, n, side);
        assert.ok(d.ok, `${f} ${n} ${side}: ${d.ok ? "" : d.error}`);
        assert.equal(d.value.length, n);
      }
    }
  }
  assert.ok(Object.keys(PP_FORMATIONS).every((k) => isFormationName(k)));
});

test("isFormationName and labels", () => {
  for (const f of FORMATION_ORDER) {
    assert.ok(isFormationName(f));
    assert.ok((formationLabel(f) ?? "").length > 0);
    assert.ok(formationSub(f).length > 0);
  }
  assert.equal(isFormationName("box"), false);
  assert.equal(isFormationName(undefined), false);
  assert.equal(isFormationName(5), false);
  assert.equal(formationLabel("box"), null);
});

test("formationChipText: overload carries its side, everything else is just the name; unknown names are prettified", () => {
  assert.equal(formationChipText("umbrella", "left"), "Umbrella");
  assert.equal(formationChipText("one_three_one", "right"), "1-3-1");
  assert.equal(formationChipText("overload", "left"), "Overload · left");
  assert.equal(formationChipText("overload", "right"), "Overload · right");
  assert.equal(formationChipText("overload", undefined), "Overload");
  assert.equal(formationChipText("big_box", "left"), "big box");
});
