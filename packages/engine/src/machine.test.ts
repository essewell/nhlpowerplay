/**
 * Run from repo root: node --test packages/engine/src/machine.test.ts.
 * SYNTHETIC data only (sim-fixtures.ts): every player, rating and rate is invented.
 *
 * Drives the XState run machine through createActor and checks it against sim.replay(), the
 * server's scoring path: same input + same calls => deep-equal RunState.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createActor, type Actor } from "xstate";
import { runMachine, type RunMachineEvent } from "./machine.ts";
import type { Result } from "./result.ts";
import {
  ALL_FIXTURES, doubleMinor, fiveOnFour, major, playoffOt, regOtFourOnThree, type FixtureOpts,
} from "./sim-fixtures.ts";
import type { Call, CallOption, RunInput, RunState } from "./sim-types.ts";
import { applyCall, initRun, legalCalls, replay } from "./sim.ts";

type RunActor = Actor<typeof runMachine>;
type Chooser = (opts: CallOption[], state: RunState) => Call;

/** Safety bound for every loop below; a run is far shorter (sim caps calls per run). */
const MAX_DRIVE_STEPS = 500;
/** Seeds scanned when searching for a specific SYNTHETIC situation. */
const SEED_SCAN = 400;
const CALL_STATES = new Set(["faceoffCall", "zoneEntryCall", "breakoutCall", "decision"]);

function val<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(`expected ok, got error: ${r.error}`);
  return r.value;
}

const firstOption: Chooser = (opts) => {
  const o = opts[0];
  if (o === undefined) throw new Error("no legal options");
  return o.call;
};

/** Shoot with the highest-p shot whenever one is offered, else take the first option. O(C). */
const bestShot: Chooser = (opts) => {
  let best: CallOption | undefined;
  for (const o of opts) if (o.call.type === "shoot" && (best === undefined || o.p > best.p)) best = o;
  return (best ?? opts[0] ?? assert.fail("no legal options")).call;
};

function start(input: RunInput, state?: RunState): RunActor {
  const actor = createActor(runMachine, { input: { input, state: state ?? val(initRun(input)) } });
  actor.start();
  return actor;
}

const stateName = (a: RunActor): string => String(a.getSnapshot().value);
const ctx = (a: RunActor) => a.getSnapshot().context;

function sendCall(a: RunActor, call: Call, callIndex?: number): void {
  a.send({ type: "CALL", call, callIndex: callIndex ?? ctx(a).state.callCount });
}

/**
 * Drive an actor until `ended`/`error` (or `stopAfter` calls), acknowledging celebrations with
 * CONTINUE. Returns the calls sent and every machine state visited. O(N x applyCall).
 */
function drive(a: RunActor, choose: Chooser, stopAfter = Infinity): { calls: Call[]; visited: string[] } {
  const calls: Call[] = [];
  const visited: string[] = [stateName(a)];
  if (stateName(a) === "intro") { a.send({ type: "START" }); visited.push(stateName(a)); }
  for (let i = 0; i < MAX_DRIVE_STEPS && calls.length < stopAfter; i++) {
    const name = stateName(a);
    if (name === "ended" || name === "error") return { calls, visited };
    if (name === "celebrating") {
      a.send({ type: "CONTINUE" });
    } else if (CALL_STATES.has(name)) {
      const { state, input } = ctx(a);
      const call = choose(val(legalCalls(state, input)), state);
      calls.push(call);
      sendCall(a, call);
    } else {
      assert.fail(`unexpected machine state ${name}`);
    }
    visited.push(stateName(a));
  }
  if (calls.length >= stopAfter) return { calls, visited };
  return assert.fail(`run did not finish within ${MAX_DRIVE_STEPS} steps`);
}

/** Calls (via replay) up to and including the first PP goal that does not end the run. O(seeds x run). */
function findMidRunGoal(build: (o: FixtureOpts) => RunInput): { input: RunInput; calls: Call[] } {
  for (let seed = 1; seed <= SEED_SCAN; seed++) {
    const input = build({ seed });
    let s = val(initRun(input));
    const calls: Call[] = [];
    while (s.phase.kind !== "ended" && calls.length < MAX_DRIVE_STEPS) {
      const call = bestShot(val(legalCalls(s, input)), s);
      s = val(applyCall(s, input, call, calls.length));
      calls.push(call);
      if (s.justScored && s.phase.kind !== "ended") return { input, calls };
    }
  }
  return assert.fail(`no mid-run PP goal in ${SEED_SCAN} SYNTHETIC seeds`);
}

// ---------------------------------------------------------------------------- happy path

test("intro waits for START, then routes the opening OZ faceoff to faceoffCall", () => {
  const input = fiveOnFour();
  const a = start(input);
  assert.equal(stateName(a), "intro");
  assert.equal(a.getSnapshot().status, "active");
  a.send({ type: "START" });
  assert.equal(stateName(a), "faceoffCall");
  const { state, error } = ctx(a);
  assert.equal(error, null);
  assert.equal(state.phase.kind, "faceoff");
  assert.deepEqual(state, val(initRun(input)));
});

for (const [name, build] of Object.entries(ALL_FIXTURES)) {
  test(`full run (${name}): actor ends and deep-equals replay(input, calls)`, () => {
    const input = build();
    const a = start(input);
    const { calls } = drive(a, firstOption);
    const snap = a.getSnapshot();
    assert.equal(snap.value, "ended", `error: ${snap.context.error}`);
    assert.equal(snap.status, "done");
    assert.equal(snap.context.state.phase.kind, "ended");
    assert.equal(snap.context.state.callCount, calls.length);
    assert.deepEqual(snap.context.state, val(replay(input, calls)));
  });
}

test("determinism: two actors with the same seed and calls produce identical states", () => {
  const input = fiveOnFour({ seed: 777 });
  const a = start(input);
  const { calls } = drive(a, bestShot);
  const b = start(fiveOnFour({ seed: 777 }));
  b.send({ type: "START" });
  for (const c of calls) {
    while (stateName(b) === "celebrating") b.send({ type: "CONTINUE" });
    sendCall(b, c);
  }
  while (stateName(b) === "celebrating") b.send({ type: "CONTINUE" });
  assert.equal(stateName(b), stateName(a));
  assert.deepEqual(ctx(b).state, ctx(a).state);
});

// ---------------------------------------------------------------------------- edge cases

test("edge 9 double tap: a repeated CALL with the same callIndex records one call", () => {
  const input = fiveOnFour();
  const a = start(input);
  a.send({ type: "START" });
  const call = firstOption(val(legalCalls(ctx(a).state, input)), ctx(a).state);
  sendCall(a, call, 0);
  const after = structuredClone(ctx(a).state);
  const nameAfter = stateName(a);
  sendCall(a, call, 0); // second tap, stale index
  assert.equal(stateName(a), nameAfter);
  assert.equal(ctx(a).error, null);
  assert.equal(ctx(a).state.callCount, 1);
  assert.equal(ctx(a).state.log.length, after.log.length);
  assert.deepEqual(ctx(a).state, after);
  assert.deepEqual(ctx(a).state, val(replay(input, [call])));
});

test("gap callIndex (callCount + 1) -> error state with a message; later CALLs ignored", () => {
  const input = fiveOnFour();
  const a = start(input);
  a.send({ type: "START" });
  const before = structuredClone(ctx(a).state);
  const call = firstOption(val(legalCalls(before, input)), before);
  sendCall(a, call, before.callCount + 1);
  assert.equal(stateName(a), "error");
  assert.equal(a.getSnapshot().status, "done");
  assert.match(ctx(a).error ?? "", /call index 1 does not follow 0/);
  assert.deepEqual(ctx(a).state, before);
  sendCall(a, call, 0);
  assert.equal(stateName(a), "error");
  assert.deepEqual(ctx(a).state, before);
});

for (const bad of [0.5, Number.NaN, Number.POSITIVE_INFINITY, -0.5, Number.NEGATIVE_INFINITY]) {
  test(`non-integer callIndex ${bad} -> error state, no CALL accepted after`, () => {
    const input = fiveOnFour();
    const a = start(input);
    a.send({ type: "START" });
    const before = structuredClone(ctx(a).state);
    const call = firstOption(val(legalCalls(before, input)), before);
    sendCall(a, call, bad);
    assert.equal(stateName(a), "error");
    assert.ok((ctx(a).error ?? "").length > 0, "error message expected");
    sendCall(a, call, 0);
    assert.equal(stateName(a), "error");
    assert.deepEqual(ctx(a).state, before);
  });
}

test("illegal call (pass to unknown id) -> error state carrying the sim's message", () => {
  const input = fiveOnFour();
  // Reach a decision pause with the deterministic policy.
  const a = start(input);
  a.send({ type: "START" });
  for (let i = 0; i < MAX_DRIVE_STEPS && stateName(a) !== "decision"; i++) {
    const name = stateName(a);
    if (name === "celebrating") { a.send({ type: "CONTINUE" }); continue; }
    if (!CALL_STATES.has(name)) assert.fail(`run left play (${name}) before a decision pause`);
    sendCall(a, firstOption(val(legalCalls(ctx(a).state, input)), ctx(a).state));
  }
  assert.equal(stateName(a), "decision");
  const before = structuredClone(ctx(a).state);
  const bogus: Call = { type: "pass", to: 999_999 };
  const simErr = applyCall(before, input, bogus, before.callCount);
  assert.equal(simErr.ok, false);
  sendCall(a, bogus);
  assert.equal(stateName(a), "error");
  assert.equal(ctx(a).error, simErr.ok ? null : simErr.error);
  assert.deepEqual(ctx(a).state, before, "state untouched on a rejected call");
});

test("illegal call for the phase (shoot during a faceoff) -> error state", () => {
  const input = fiveOnFour();
  const a = start(input);
  a.send({ type: "START" });
  assert.equal(stateName(a), "faceoffCall");
  sendCall(a, { type: "zone_entry", method: "carry" });
  assert.equal(stateName(a), "error");
  assert.ok((ctx(a).error ?? "").length > 0);
});

// A goal on a single minor releases it and ends the PP, so use penalties that survive a goal.
for (const [fx, build] of [["major", major], ["doubleMinor", doubleMinor]] as const) {
  test(`celebration (${fx}): mid-run PP goal -> celebrating, CALL ignored, CONTINUE -> centre faceoffCall`, () => {
    const { input, calls } = findMidRunGoal(build);
    const a = start(input);
    a.send({ type: "START" });
    calls.forEach((c, i) => {
      assert.ok(CALL_STATES.has(stateName(a)), `call ${i} sent in ${stateName(a)}`);
      sendCall(a, c);
    });
    assert.equal(stateName(a), "celebrating");
    const atGoal = structuredClone(ctx(a).state);
    assert.equal(atGoal.justScored, true);
    assert.deepEqual(atGoal, val(replay(input, calls)));

    const next = firstOption(val(legalCalls(atGoal, input)), atGoal);
    sendCall(a, next); // ignored while celebrating
    assert.equal(stateName(a), "celebrating");
    assert.deepEqual(ctx(a).state, atGoal);
    a.send({ type: "START" }); // wrong state: ignored
    assert.equal(stateName(a), "celebrating");

    a.send({ type: "CONTINUE" });
    assert.equal(stateName(a), "faceoffCall");
    assert.deepEqual(ctx(a).state.phase, { kind: "faceoff", dot: "centre" });
    assert.equal(ctx(a).celebratedAt, atGoal.callCount);
    assert.deepEqual(ctx(a).state, atGoal, "CONTINUE does not touch the run state");

    // The run continues normally and still matches replay.
    const rest = drive(a, firstOption);
    assert.equal(stateName(a), "ended");
    assert.deepEqual(ctx(a).state, val(replay(input, [...calls, ...rest.calls])));
  });
}

test("PP goal on a lone minor ends the run (pp_expired) without celebrating", () => {
  for (let seed = 1; seed <= SEED_SCAN; seed++) {
    const input = fiveOnFour({ seed });
    const a = start(input);
    const { visited } = drive(a, bestShot);
    const { state } = ctx(a);
    if (!state.justScored) continue;
    assert.equal(stateName(a), "ended");
    assert.deepEqual(state.phase, { kind: "ended", reason: "pp_expired", detail: null });
    assert.ok(!visited.includes("celebrating"));
    return;
  }
  assert.fail(`no PP goal in ${SEED_SCAN} SYNTHETIC seeds`);
});

for (const [name, build] of [["regOtFourOnThree", regOtFourOnThree], ["playoffOt", playoffOt]] as const) {
  test(`OT goal (${name}) goes straight to ended, never celebrating`, () => {
    for (let seed = 1; seed <= SEED_SCAN; seed++) {
      const input = build({ seed });
      const a = start(input);
      const { calls, visited } = drive(a, bestShot);
      const { state } = ctx(a);
      if (state.phase.kind !== "ended" || state.phase.detail !== "ot_goal") continue;
      assert.equal(stateName(a), "ended");
      assert.equal(state.justScored, true);
      assert.ok(!visited.includes("celebrating"), `visited: ${visited.join(",")}`);
      assert.deepEqual(state, val(replay(input, calls)));
      return;
    }
    assert.fail(`no OT goal in ${SEED_SCAN} SYNTHETIC seeds`);
  });
}

test("edge 6 resume: actor built from replay(first N) + remaining calls == uninterrupted run", () => {
  const input = fiveOnFour({ seed: 4242 });
  const full = start(input);
  const { calls } = drive(full, bestShot);
  assert.ok(calls.length >= 3, `need a run with >= 3 calls, got ${calls.length}`);
  for (const n of [0, 1, Math.floor(calls.length / 2), calls.length - 1]) {
    const resumed = start(input, val(replay(input, calls.slice(0, n))));
    resumed.send({ type: "START" });
    for (const c of calls.slice(n)) {
      while (stateName(resumed) === "celebrating") resumed.send({ type: "CONTINUE" });
      assert.ok(CALL_STATES.has(stateName(resumed)), `resume N=${n}: in ${stateName(resumed)}`);
      sendCall(resumed, c);
    }
    assert.equal(stateName(resumed), stateName(full), `resume N=${n}`);
    assert.deepEqual(ctx(resumed).state, ctx(full).state, `resume N=${n}`);
  }
});

test("CONTINUE and START in call states are ignored", () => {
  const input = fiveOnFour();
  const a = start(input);
  a.send({ type: "CONTINUE" }); // in intro
  assert.equal(stateName(a), "intro");
  a.send({ type: "START" });
  const before = structuredClone(ctx(a).state);
  a.send({ type: "CONTINUE" });
  a.send({ type: "START" });
  assert.equal(stateName(a), "faceoffCall");
  assert.deepEqual(ctx(a).state, before);
  assert.equal(ctx(a).error, null);
});

test("CALL before START is ignored (intro accepts only START)", () => {
  const input = fiveOnFour();
  const init = val(initRun(input));
  const a = start(input, init);
  sendCall(a, firstOption(val(legalCalls(init, input)), init), 0);
  assert.equal(stateName(a), "intro");
  assert.deepEqual(ctx(a).state, init);
});

test("events after ended do nothing", () => {
  const input = fiveOnFour();
  const a = start(input);
  drive(a, firstOption);
  assert.equal(stateName(a), "ended");
  const snap = structuredClone(ctx(a));
  const events: RunMachineEvent[] = [
    { type: "START" }, { type: "CONTINUE" },
    { type: "CALL", call: { type: "zone_entry", method: "carry" }, callIndex: snap.state.callCount },
    { type: "CALL", call: { type: "zone_entry", method: "carry" }, callIndex: snap.state.callCount + 5 },
  ];
  for (const e of events) a.send(e);
  assert.equal(stateName(a), "ended");
  assert.equal(a.getSnapshot().status, "done");
  assert.deepEqual(ctx(a), snap);
});

test("resuming an already-ended state routes straight to ended", () => {
  const input = fiveOnFour();
  const a = start(input);
  const { calls } = drive(a, firstOption);
  const b = start(input, val(replay(input, calls)));
  b.send({ type: "START" });
  assert.equal(stateName(b), "ended");
});

test("breakoutCall is reached with settings.askEveryTouch and matches replay", () => {
  for (const choose of [firstOption, bestShot]) {
    for (let seed = 1; seed <= SEED_SCAN; seed++) {
      const input = fiveOnFour({ seed, askEveryTouch: true });
      const a = start(input);
      const { calls, visited } = drive(a, choose);
      if (!visited.includes("breakoutCall")) continue;
      assert.equal(stateName(a), "ended", `error: ${ctx(a).error}`);
      assert.deepEqual(ctx(a).state, val(replay(input, calls)));
      return;
    }
  }
  assert.fail(`no breakout pause in ${SEED_SCAN} SYNTHETIC seeds`);
});

test("without askEveryTouch the machine never stops in breakoutCall", () => {
  for (let seed = 1; seed <= 40; seed++) {
    const a = start(fiveOnFour({ seed }));
    const { visited } = drive(a, bestShot);
    assert.ok(!visited.includes("breakoutCall"), `seed ${seed}`);
  }
});
