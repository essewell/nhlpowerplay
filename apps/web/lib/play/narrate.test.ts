import { test } from "node:test";
import assert from "node:assert/strict";
import { applyCall, initRun, legalCalls } from "@powerplay/engine/sim.ts";
import { fiveOnFour, fiveSecondsLeft } from "@powerplay/engine/sim-fixtures.ts";
import type { RunEvent, RunInput, RunState } from "@powerplay/engine/sim-types.ts";
import { formatOffClock, lastCallIndex, MAX_NARRATION_LINES, narrate, type NarrateCtx } from "./narrate.ts";
import { fillCopy } from "./strings.ts";

const ctx: NarrateCtx = {
  players: {
    1: { number: 11, first: "Al", last: "Alpha", pos: "C" },
    2: { number: 22, first: "Bo", last: "Bravo", pos: "W" },
    5: { number: 55, first: "Ed", last: "Echo", pos: "D" },
  },
  teams: { pp: "AAA", pk: "BBB" },
  spotName: (s) => `spot:${s}`,
  carrierId: 5,
};

let seq = 0;
function ev(kind: string, atS: number, extra: Partial<RunEvent> = {}): RunEvent {
  return { i: seq++, callIndex: 0, atS, clock: { period: 1, elapsedS: atS }, kind, ...extra };
}
const call = (atS: number): RunEvent => ev("call", atS, { p: 0.5, detail: { type: "pass", to: 2 } });
const draw = (name: string, atS: number, hit: boolean, detail: Record<string, string | number | boolean> = {}, auto = false): RunEvent =>
  ev(`draw:${name}`, atS, { p: 0.5, u: 0.123, detail: { ...detail, hit }, callIndex: auto ? null : 0 });
const texts = (n: ReturnType<typeof narrate>): string[] => n.lines.map((l) => l.text);

test("happy path: connected pass -> one good line, 3 s off the clock", () => {
  const log = [call(100), draw("pass", 103, true, { to: 2 })];
  const n = narrate(log, 0, ctx);
  assert.deepEqual(texts(n), ["Pass to Bravo connects"]);
  assert.equal(n.elapsedS, 3);
  assert.equal(n.tone, "good");
});

test("pass picked off reads as a setback and the draw numbers never reach the text", () => {
  const log = [call(10), draw("pass", 12, false, { to: 2 }), draw("intercept", 12, true),
    draw("pk_possession", 14, true, { outcome: 2 }, true)];
  const n = narrate(log, 0, ctx);
  assert.equal(n.lines[0]?.text, "Pass picked off");
  assert.equal(n.tone, "bad");
  assert.ok(!texts(n).join(" ").match(/0\.123|0\.5/), "p and u must not be shown");
});

test("faceoff lost names the other team, loss then clear then regroup is grouped", () => {
  const log = [
    ev("call", 0, { detail: { type: "faceoff" } }),
    draw("faceoff", 1, false, { takerId: 1 }),
    draw("faceoff_loss_clear", 1, true),
    ev("clear", 1, { callIndex: null, detail: { remainingS: 80 } }),
    draw("breakout", 13, true, { method: "pass" }, true),
  ];
  const n = narrate(log, 0, ctx);
  assert.deepEqual(texts(n), ["Faceoff lost, BBB wins it back", "BBB clear the zone", "Regroup · 0:12 off the clock"]);
  assert.equal(n.elapsedS, 13);
  assert.equal(n.tone, "bad");
});

test("goal: scorer comes from the shot draw's shooter, tone is goal", () => {
  const log = [call(5), draw("block", 7, false, { shooterId: 1 }), ev("draw:shot", 7, { detail: { shooterId: 1, outcome: 0 } }),
    ev("goal", 7, { detail: { side: "pp" } }), ev("faceoff_setup", 7, { callIndex: null, detail: { dot: "centre" } })];
  const n = narrate(log, 0, ctx);
  assert.deepEqual(texts(n), ["GOAL! Alpha scores"]);
  assert.equal(n.tone, "goal");
});

test("shorthanded goal against: tone against, ends with the end event but no extra line", () => {
  const log = [call(5), draw("pass", 7, false, { to: 2 }), draw("intercept", 7, true),
    ev("sh_chance", 9, { callIndex: null }), draw("sh_goal", 9, true, {}, true),
    ev("goal", 9, { callIndex: null, detail: { side: "pk" } }),
    ev("end", 9, { callIndex: null, detail: { reason: "sh_goal", detail: "none" } })];
  const n = narrate(log, 0, ctx);
  assert.equal(n.tone, "against");
  assert.ok(texts(n).some((t) => t.startsWith("Shorthanded goal against, BBB")));
  assert.ok(!texts(n).some((t) => t.includes("Power play over")));
});

test("clock cut: not enough time, then power play over", () => {
  const log = [call(190), ev("cut_by_clock", 196, { detail: { step: "pass", durationS: 3 } }),
    ev("end", 196, { callIndex: null, detail: { reason: "pp_expired", detail: "none" } })];
  const n = narrate(log, 0, ctx);
  assert.deepEqual(texts(n), ["Not enough time left", "Power play over"]);
  assert.equal(n.elapsedS, 6);
  assert.equal(n.tone, "bad");
});

test("cleared with too little time left to re-enter", () => {
  const log = [call(0), draw("breakout", 2, false, { method: "carry" }), ev("clear", 2, { callIndex: null, detail: { remainingS: 4 } }),
    ev("end", 2, { callIndex: null, detail: { reason: "cleared_out", detail: "none" } })];
  const n = narrate(log, 0, ctx);
  assert.deepEqual(texts(n), ["Breakout stopped", "BBB clear the zone", "Not enough time to re-enter, power play over"]);
});

test("period end", () => {
  const log = [call(1195), ev("period_end", 1200, { detail: { period: 2 } }), ev("faceoff_setup", 1200, { callIndex: null, detail: { dot: "centre" } })];
  assert.deepEqual(texts(narrate(log, 0, ctx)), ["End of period 2"]);
});

test("multi-step regroup: several clears collapse to at most four lines, first and last kept", () => {
  const log: RunEvent[] = [call(0)];
  let t = 1;
  for (let k = 0; k < 4; k++) {
    log.push(draw("breakout", t, false, { method: "pass" }, true), ev("clear", t, { callIndex: null, detail: { remainingS: 60 } }));
    t += 10;
    log.push(draw("pk_possession", t, false, { outcome: 9 }, true));
  }
  const n = narrate(log, 0, ctx);
  assert.equal(n.lines.length, MAX_NARRATION_LINES);
  assert.equal(n.lines[0]?.text, "Breakout stopped");
  assert.match(n.lines[1]?.text ?? "", /^\d+ more plays$/);
});

test("empty slice, past-the-end and negative/NaN index never throw", () => {
  const log = [call(0), draw("pass", 2, true, { to: 2 })];
  assert.deepEqual(narrate([], 0, ctx), { lines: [], elapsedS: 0, tone: "neutral" });
  assert.deepEqual(narrate(log, 99, ctx), { lines: [], elapsedS: 0, tone: "neutral" });
  assert.equal(narrate(log, -5, ctx).lines.length, 1);
  assert.equal(narrate(log, Number.NaN, ctx).lines.length, 1);
});

test("unknown kind becomes one neutral generic line, repeated unknowns collapse", () => {
  const log = [call(0), ev("zamboni", 1), ev("draw:mystery", 2, { p: 0.4, u: 0.9, detail: { hit: true } })];
  const n = narrate(log, 0, ctx);
  assert.deepEqual(texts(n), ["Play continues"]);
  assert.equal(n.tone, "neutral");
});

test("unknown player id falls back to wording without a name, never a made-up one", () => {
  const log = [call(0), draw("pass", 2, true, { to: 99 })];
  assert.deepEqual(texts(narrate(log, 0, ctx)), ["Play continues"]);
  const noHolder: NarrateCtx = { ...ctx, carrierId: null };
  const saveLog = [call(0), ev("save", 2), draw("rebound", 2, true)];
  assert.deepEqual(texts(narrate(saveLog, 0, noHolder)), ["Save, rebound stays with AAA"]);
});

test("save with rebound names the holder; freeze reads as a whistle", () => {
  assert.deepEqual(texts(narrate([call(0), ev("save", 2), draw("freeze", 2, false), draw("rebound", 2, true)], 0, ctx)),
    ["Save, rebound to Echo"]);
  assert.deepEqual(texts(narrate([call(0), ev("save", 2), draw("freeze", 2, true)], 0, ctx)), ["Save, whistle for a faceoff"]);
});

test("fromIndex ignores earlier calls", () => {
  const log = [call(0), draw("pass", 2, true, { to: 2 }), call(2), draw("entry", 5, false, { method: "carry" })];
  assert.equal(lastCallIndex(log), 2);
  assert.deepEqual(texts(narrate(log, lastCallIndex(log), ctx)), ["Carry-in stopped at the blue line"]);
  assert.equal(lastCallIndex([]), -1);
});

test("formatOffClock", () => {
  assert.equal(formatOffClock(12), "0:12");
  assert.equal(formatOffClock(75.9), "1:15");
  assert.equal(formatOffClock(-3), "0:00");
  assert.equal(formatOffClock(Number.NaN), "0:00");
});

// ---------------------------------------------------------------- real engine: every logged kind has wording

function playAll(input: RunInput, pick: (n: number) => number): { calls: RunEvent[][]; players: NarrateCtx["players"] } {
  const players: NarrateCtx["players"] = {};
  for (const s of input.pp.skaters) players[s.id] = { number: s.id, first: "S", last: `Skater${s.id}`, pos: "C" };
  const init = initRun(input);
  assert.ok(init.ok);
  let state: RunState = init.value;
  const slices: RunEvent[][] = [];
  for (let k = 0; k < 40 && state.phase.kind !== "ended"; k++) {
    if (state.justScored) state = { ...state, justScored: false };
    const opts = legalCalls(state, input);
    assert.ok(opts.ok);
    const choice = opts.value[pick(opts.value.length)];
    assert.ok(choice !== undefined);
    const from = state.log.length;
    const next = applyCall(state, input, choice.call, state.callCount);
    assert.ok(next.ok);
    slices.push(next.value.log.slice(from));
    state = next.value;
  }
  return { calls: slices, players };
}

test("real engine: across seeds and inputs, narration never falls back to the unknown line and never exceeds 4 lines", () => {
  const generic = fillCopy("narrate.unknown");
  let total = 0;
  for (const make of [fiveOnFour, fiveSecondsLeft]) {
    for (let seed = 1; seed <= 25; seed++) {
      const input = make({ seed });
      const { calls, players } = playAll(input, (n) => (seed + n) % n);
      for (const slice of calls) {
        const n = narrate(slice, 0, { players, teams: { pp: "AAA", pk: "BBB" }, spotName: (s) => s, carrierId: null });
        total++;
        assert.ok(n.lines.length >= 1 && n.lines.length <= MAX_NARRATION_LINES, JSON.stringify(slice.map((e) => e.kind)));
        assert.ok(!n.lines.some((l) => l.text === generic), `unmapped: ${slice.map((e) => e.kind).join(",")}`);
        assert.ok(n.elapsedS >= 0);
      }
    }
  }
  assert.ok(total > 50);
});

test("determinism: same log, same narration", () => {
  const input = fiveOnFour({ seed: 7 });
  const { calls, players } = playAll(input, () => 0);
  const c: NarrateCtx = { players, teams: { pp: "AAA", pk: "BBB" }, spotName: (s) => s };
  for (const slice of calls) assert.deepEqual(narrate(slice, 0, c), narrate(slice, 0, c));
});
