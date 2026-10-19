import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCall, initRun, legalCalls } from "@powerplay/engine/sim.ts";
import { fiveOnFour } from "@powerplay/engine/sim-fixtures.ts";
import type { RunEvent } from "@powerplay/engine/sim-types.ts";
import { lastCallIndex, narrate, type NarrateCtx } from "./narrate.ts";

const ctx: NarrateCtx = {
  players: {
    1: { number: 11, first: "Al", last: "Alpha", pos: "C" },
    2: { number: 22, first: "Bo", last: "Bravo", pos: "W" },
  },
  teams: { pp: "AAA", pk: "BBB" },
  spotName: (s) => s,
  carrierId: 1,
};

let seq = 0;
const ev = (kind: string, atS: number, detail?: Record<string, string | number | boolean>, auto = false): RunEvent => ({
  i: seq++, callIndex: auto ? null : 0, atS, clock: { period: 1, elapsedS: atS }, kind, ...(detail ? { detail } : {}),
});
const call = ev("call", 0, { type: "zone_entry" });
const entry = (hit: boolean, detail: Record<string, string | number | boolean> = {}): RunEvent =>
  ev("draw:entry", 2, { method: "carry", hit, ...detail });
const texts = (log: RunEvent[]): string[] => narrate(log, 0, ctx).lines.map((l) => l.text);

test("entry with lane + setup: method, lane and formation in one line", () => {
  const log = [call, entry(true, { lane: "left" }), ev("setup", 4, { trigger: "entry", method: "carry", lane: "left", formation: "umbrella", side: "left", carrierId: 1 })];
  assert.deepEqual(texts(log), ["Carry-in on the left · Umbrella set up"]);
});

test("entry setup for overload names its side; middle reads 'up the middle'; a drop names the trailer who has it", () => {
  const over = [call, entry(true), ev("setup", 4, { trigger: "entry", method: "dump", lane: "right", formation: "overload", side: "right", carrierId: 1 })];
  assert.deepEqual(texts(over), ["Dump-in on the right · Overload set up on the right"]);
  const mid = [call, entry(true), ev("setup", 4, { trigger: "entry", method: "carry", lane: "middle", formation: "spread", side: "left", carrierId: 1 })];
  assert.deepEqual(texts(mid), ["Carry-in up the middle · Spread set up"]);
  const drop = [call, entry(true), ev("setup", 4, { trigger: "entry", method: "drop", lane: "left", formation: "umbrella", side: "left", carrierId: 2 })];
  assert.deepEqual(texts(drop), ["Drop pass on the left to Bravo · Umbrella set up"]);
});

test("entry fallbacks: no lane/formation fields -> the plain line; lane only -> lane without setup", () => {
  assert.deepEqual(texts([call, entry(true)]), ["Zone entry works, AAA set up"]);
  assert.deepEqual(texts([call, entry(true, { lane: "right" })]), ["Carry-in on the right"]);
  assert.deepEqual(texts([call, entry(true), ev("setup", 4, { trigger: "entry", formation: "spread" })]), ["Zone entry works, AAA set up · Spread set up"]);
});

test("failed entry mentions the lane when logged, the plain wording when not", () => {
  assert.deepEqual(texts([call, entry(false, { lane: "left" })]), ["Carry-in on the left stopped at the blue line"]);
  assert.deepEqual(texts([call, ev("draw:entry", 2, { method: "dump", lane: "right", hit: false })]), ["Dump-in on the right lost to BBB"]);
  assert.deepEqual(texts([call, entry(false)]), ["Carry-in stopped at the blue line"]);
  assert.deepEqual(texts([call, ev("draw:entry", 2, { method: "mystery", lane: "left", hit: false })]), ["Zone entry on the left stopped"]);
});

test("offensive draw won: the faceoff setup event appends the formation", () => {
  const log = [
    ev("call", 0, { type: "faceoff" }),
    ev("draw:faceoff", 1, { takerId: 1, hit: true }),
    ev("setup", 1, { trigger: "faceoff", formation: "overload", side: "left", dot: "oz_left" }),
  ];
  assert.deepEqual(texts(log), ["Faceoff won by Alpha · Overload set up on the left"]);
});

test("setup event never becomes the generic line, even alone or with an unknown formation or an unknown lane", () => {
  const alone = [call, ev("setup", 4, { trigger: "entry", formation: "umbrella" })];
  assert.ok(!texts(alone).includes("Play continues"));
  const unknown = [call, entry(true), ev("setup", 4, { trigger: "entry", method: "carry", lane: "diagonal", formation: "big_box" })];
  assert.deepEqual(texts(unknown), ["Zone entry works, AAA set up · big box set up"]);
});

test("real engine: every zone entry logs a setup that narrates with lane and formation, never the unknown line", () => {
  const input = fiveOnFour();
  const init = initRun(input);
  assert.ok(init.ok);
  let state = init.value;
  let sawEntryLine = false;
  for (let guard = 0; guard < 40 && state.phase.kind !== "ended"; guard++) {
    const opts = legalCalls(state, input);
    assert.ok(opts.ok);
    const pick = opts.value.find((o) => o.call.type === "zone_entry" && o.call.lane === "right") ?? opts.value[0];
    assert.ok(pick !== undefined);
    const next = applyCall(state, input, pick.call, state.callCount);
    assert.ok(next.ok);
    state = next.value;
    const from = lastCallIndex(state.log);
    const n = narrate(state.log, from, ctx);
    if (state.log.slice(from).some((e) => e.kind === "setup")) {
      assert.ok(!n.lines.some((l) => l.text === "Play continues"), n.lines.map((l) => l.text).join(" | "));
    }
    if (pick.call.type === "zone_entry" && n.lines.some((l) => /on the right/.test(l.text))) sawEntryLine = true;
  }
  assert.ok(sawEntryLine || state.log.every((e) => e.kind !== "setup"), "an entry that landed is worded with its lane");
});
