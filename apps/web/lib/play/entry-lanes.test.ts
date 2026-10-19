import { test } from "node:test";
import assert from "node:assert/strict";
import type { CallOption, EntryLane, EntryMethod, PpFormationName } from "@powerplay/engine/sim-types.ts";
import {
  bestLaneChance, currentSetup, defaultEntryLane, entryLanes, entryMethods, entryOption, groupOptions, ppOnIce,
  withFormation, type OptionOf,
} from "./options.ts";

const opt = (method: EntryMethod, lane: EntryLane | undefined, p: number, cutByClock = false): OptionOf<"zone_entry"> => ({
  call: lane === undefined ? { type: "zone_entry", method } : { type: "zone_entry", method, lane },
  p, breakdown: {}, durationS: 4, cutByClock,
});

/** All nine method x lane options with chances that make "right" the best lane. */
const FULL = [
  opt("carry", "left", 0.5), opt("carry", "middle", 0.4), opt("carry", "right", 0.7),
  opt("drop", "left", 0.45), opt("drop", "middle", 0.35), opt("drop", "right", 0.6),
  opt("dump", "left", 0.5), opt("dump", "middle", 0.3), opt("dump", "right", 0.55),
];
const LEGACY = [opt("carry", undefined, 0.5), opt("drop", undefined, 0.4), opt("dump", undefined, 0.6)];

test("entryLanes happy path: lanes in display order whatever order the engine lists them", () => {
  assert.deepEqual(entryLanes(FULL), ["left", "middle", "right"]);
  assert.deepEqual(entryLanes([opt("carry", "right", 0.5), opt("carry", "left", 0.5)]), ["left", "right"]);
});

test("entryLanes edge: options without a lane (older engine) -> no lanes, selector hidden", () => {
  assert.deepEqual(entryLanes(LEGACY), []);
  assert.deepEqual(entryLanes([]), []);
  assert.equal(defaultEntryLane(LEGACY), null);
});

test("entryMethods: unique, in the engine's order", () => {
  assert.deepEqual(entryMethods(FULL), ["carry", "drop", "dump"]);
  assert.deepEqual(entryMethods(LEGACY), ["carry", "drop", "dump"]);
  assert.deepEqual(entryMethods([]), []);
});

test("entryOption: the option for a method in the selected lane; its odds, not another lane's", () => {
  assert.equal(entryOption(FULL, "carry", "left")?.p, 0.5);
  assert.equal(entryOption(FULL, "carry", "right")?.p, 0.7);
  assert.equal(entryOption(FULL, "drop", "middle")?.call.lane, "middle");
});

test("entryOption edge: lane null takes the method's first option; an unpriced lane is null, never invented", () => {
  assert.equal(entryOption(LEGACY, "dump", null)?.p, 0.6);
  assert.equal(entryOption(FULL, "dump", null)?.call.lane, "left");
  assert.equal(entryOption([opt("carry", "left", 0.5)], "carry", "right"), null);
  assert.equal(entryOption([opt("carry", "left", 0.5)], "drop", "left"), null);
  assert.equal(entryOption(LEGACY, "carry", "left"), null, "a lane was asked for but options carry none");
});

test("bestLaneChance: best method in the lane, ignoring options the clock cuts", () => {
  assert.equal(bestLaneChance(FULL, "right"), 0.7);
  assert.equal(bestLaneChance([opt("carry", "left", 0.9, true), opt("drop", "left", 0.2)], "left"), 0.2);
  assert.equal(bestLaneChance([opt("carry", "left", 0.9, true)], "left"), null);
  assert.equal(bestLaneChance(FULL, "middle"), 0.4);
  assert.equal(bestLaneChance([], "left"), null);
});

test("defaultEntryLane: the lane with the best top chance", () => {
  assert.equal(defaultEntryLane(FULL), "right");
});

test("defaultEntryLane edge: ties prefer middle; all cut -> middle; no middle on offer -> first lane", () => {
  const tie = [opt("carry", "left", 0.5), opt("carry", "middle", 0.5), opt("carry", "right", 0.5)];
  assert.equal(defaultEntryLane(tie), "middle");
  assert.equal(defaultEntryLane([opt("carry", "right", 0.5), opt("carry", "left", 0.5)]), "left", "display order breaks a tie without middle");
  const allCut = [opt("carry", "left", 0.9, true), opt("carry", "middle", 0.1, true), opt("carry", "right", 0.5, true)];
  assert.equal(defaultEntryLane(allCut), "middle");
  assert.equal(defaultEntryLane([opt("carry", "right", 0.1, true), opt("carry", "left", 0.2, true)]), "left");
});

test("withFormation: sets the chosen formation only when it changes what the engine would do", () => {
  const withCurrent = { type: "zone_entry", method: "carry", lane: "left", formation: "umbrella" } as const;
  assert.equal(withFormation(withCurrent, "umbrella", "umbrella"), withCurrent, "unchanged: same object");
  assert.deepEqual(withFormation(withCurrent, "overload", "umbrella"), { ...withCurrent, formation: "overload" });
  const legacy = { type: "zone_entry", method: "carry" } as const;
  assert.equal(withFormation(legacy, "umbrella", "umbrella"), legacy, "no field and no change: call stays minimal");
  assert.deepEqual(withFormation(legacy, "one_three_one", "umbrella"), { ...legacy, formation: "one_three_one" });
  const faceoff = { type: "faceoff", takerId: 1, target: "point" } as const;
  assert.deepEqual(withFormation(faceoff, "spread", "umbrella"), { ...faceoff, formation: "spread" });
});

test("withFormation does not mutate its input", () => {
  const call = { type: "zone_entry", method: "drop", lane: "right", formation: "umbrella" } as const;
  const before = JSON.stringify(call);
  withFormation(call, "spread", "umbrella");
  assert.equal(JSON.stringify(call), before);
});

test("groupOptions keeps lane options in zoneEntry, in the engine's order", () => {
  const options: CallOption[] = [...FULL];
  assert.equal(groupOptions(options).zoneEntry.length, 9);
});

test("currentSetup: the formation on the ice, or the run's start for a state that has none; ppOnIce falls back to strength", () => {
  const input = { settings: { formation: "one_three_one" as PpFormationName } };
  assert.deepEqual(currentSetup({ state: { formation: "overload", formationSide: "right" }, input }), { formation: "overload", side: "right" });
  assert.deepEqual(currentSetup({ state: {}, input }), { formation: "one_three_one", side: "left" });
  type S = Parameters<typeof ppOnIce>[0];
  const scenario = { strength: { pp: 4, pk: 3 } } as S["scenario"];
  const empty = { ppSpots: [] } as unknown as S["state"];
  const five = { ppSpots: [1, 2, 3, 4, 5].map((id) => ({ id, spot: "slot" as const })) } as unknown as S["state"];
  assert.equal(ppOnIce({ state: empty, scenario }), 4);
  assert.equal(ppOnIce({ state: five, scenario }), 5);
});
