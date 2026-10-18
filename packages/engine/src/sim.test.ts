/** Run from repo root: node --test packages/engine/src/sim.test.ts. SYNTHETIC data only (sim-fixtures.ts). */
import { test } from "node:test";
import assert from "node:assert/strict";
import { absS, strengthOf } from "./clock.ts";
import {
  CLEAR_REENTRY_MIN_S, FACEOFF_DOTS, MAX_CALLS_PER_RUN, OZ_SPOTS, SET_PLAYS, SHOT_OPTIONS, TIME,
} from "./constants.ts";
import { pkPositions, spotPos } from "./formation.ts";
import { mulberry32 } from "./modes.ts";
import type { Result } from "./result.ts";
import {
  ALL_FIXTURES, fiveOnFour, fiveSecondsLeft, fourOnThreePpPenalty, regOtPpPenalty, synthRates, playoffOt, regOtFourOnThree, sixOnFourGoaliePulled,
  staggeredFiveOnThree, thirdPenaltyQueued, type FixtureOpts,
} from "./sim-fixtures.ts";
import type { Call, CallOption, RunEvent, RunInput, RunState } from "./sim-types.ts";
import { applyCall, autoPlay, initRun, legalCalls, replay, type Policy } from "./sim.ts";

function val<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(`expected ok, got error: ${r.error}`);
  return r.value;
}
function isErr<T>(r: Result<T>, re?: RegExp): void {
  assert.equal(r.ok, false, `expected error, got ok`);
  if (re && !r.ok) assert.match(r.error, re);
}
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const firstPolicy: Policy = (opts) => {
  const o = opts[0];
  if (o === undefined) throw new Error("no options");
  return o.call;
};
const randomPolicy = (seed: number): Policy => {
  const rand = mulberry32(seed);
  return (opts) => {
    const o = opts[Math.floor(rand() * opts.length)];
    if (o === undefined) throw new Error("no options");
    return o.call;
  };
};
const isDraw = (e: RunEvent) => e.kind.startsWith("draw:");
const nowS = (s: RunState, input: RunInput) => val(absS(s.clock, input.gameType));
const eventsAfterCall = (s: RunState, ci: number) => s.log.filter((e) => e.callIndex === ci);

/** A state paused at a decision with `carrierId` holding the puck, PK positions recomputed. */
function decisionState(input: RunInput, carrierId: number, patch: Partial<RunState> = {}): RunState {
  const s = val(initRun(input));
  const spot = s.ppSpots.find((x) => x.id === carrierId);
  if (spot === undefined) assert.fail(`carrier ${carrierId} not on ice`);
  const out: RunState = { ...s, phase: { kind: "decision" }, carrier: { kind: "pp", id: carrierId },
    puck: spotPos(spot.spot), ...patch };
  const st = val(strengthOf(out.penalties, out.goaliePulled, out.clock.period, input.gameType));
  return { ...out, pkPos: val(pkPositions(out.puck, st.pk)) };
}
/** Id of the PP skater on `spot` in a fresh run. */
function idOn(input: RunInput, spot: string): number {
  const s = val(initRun(input));
  const h = s.ppSpots.find((x) => x.spot === spot);
  if (h === undefined) assert.fail(`nobody on ${spot}`);
  return h.id;
}
/** Deterministic scan over PRNG states; returns the first result accepted by `pick`. */
function scan<T>(limit: number, f: (rng: number) => T | null): T {
  for (let rng = 1; rng <= limit; rng++) {
    const r = f(rng);
    if (r !== null) return r;
  }
  return assert.fail(`no PRNG state in 1..${limit} produced the wanted outcome`);
}
function findOption(opts: CallOption[], pred: (c: Call) => boolean): CallOption {
  const o = opts.find((x) => pred(x.call));
  if (o === undefined) assert.fail("option not found");
  return o;
}
/** Faceoff-hopeless PP: the PK wins nearly every draw. */
function loseFaceoffs(input: RunInput): RunInput {
  return { ...input, pp: { skaters: input.pp.skaters.map((s) => ({ ...s, faceoffWinRate: 0.01 })) },
    pk: { ...input.pk, skaters: input.pk.skaters.map((s) => ({ ...s, faceoffWinRate: 0.99 })) } };
}

// ================================================================== initRun
test("initRun: happy path for every fixture", () => {
  for (const [name, mk] of Object.entries(ALL_FIXTURES)) {
    const input = mk();
    const s = val(initRun(input));
    assert.equal(s.v, 1, name);
    assert.equal(s.callCount, 0);
    assert.equal(s.phase.kind, "faceoff", name);
    if (s.phase.kind === "faceoff") assert.ok(s.phase.dot === "oz_left" || s.phase.dot === "oz_right");
    const st = val(strengthOf(input.penalties, input.goaliePulled, input.clock.period, input.gameType));
    assert.equal(s.ppSpots.length, st.pp, name);
    assert.equal(s.pkPos.length, st.pk, name);
    assert.equal(s.log.filter(isDraw).length, 1, "one logged draw for the opening dot");
    assert.deepEqual(s.clock, input.clock);
    assert.equal(s.justScored, false);
  }
});
test("initRun: opening dot comes from the seed and puck sits on it", () => {
  const dots = new Set<string>();
  for (let seed = 0; seed < 20; seed++) {
    const s = val(initRun(fiveOnFour({ seed })));
    if (s.phase.kind !== "faceoff") assert.fail("not a faceoff");
    dots.add(s.phase.dot);
    assert.deepEqual(s.puck, { ...FACEOFF_DOTS[s.phase.dot] });
  }
  assert.deepEqual([...dots].sort(), ["oz_left", "oz_right"]);
});
test("initRun: does not mutate the input", () => {
  const input = fiveOnFour();
  const before = clone(input);
  val(initRun(input));
  assert.deepEqual(input, before);
});
test("initRun edge: skater counts must match strength", () => {
  const i = fiveOnFour();
  isErr(initRun({ ...i, pp: { skaters: i.pp.skaters.slice(0, 4) } }), /PP skaters/);
  isErr(initRun({ ...i, pk: { ...i.pk, skaters: i.pk.skaters.slice(0, 3) } }), /PK skaters/);
  isErr(initRun({ ...i, goaliePulled: true }), /PP skaters/);
});
test("initRun edge: duplicate ids rejected (within and across teams)", () => {
  const i = fiveOnFour();
  const pp = i.pp.skaters.map((s, k) => (k === 1 ? { ...s, id: i.pp.skaters[0]?.id ?? 0 } : s));
  isErr(initRun({ ...i, pp: { skaters: pp } }), /duplicate/);
  const pk = i.pk.skaters.map((s, k) => (k === 0 ? { ...s, id: i.pp.skaters[0]?.id ?? 0 } : s));
  isErr(initRun({ ...i, pk: { ...i.pk, skaters: pk } }), /duplicate/);
});
test("initRun edge: non-finite positions and multipliers rejected", () => {
  const i = fiveOnFour();
  const bad = (patch: object) => ({ ...i, pp: { skaters: i.pp.skaters.map((s, k) => (k === 2 ? { ...s, ...patch } : s)) } });
  isErr(initRun(bad({ pos: { x: NaN, y: 0 } })));
  isErr(initRun(bad({ playmakingMult: Infinity })));
  isErr(initRun(bad({ finishingMult: 0 })));
  isErr(initRun(bad({ puckControlMult: -1 })));
  isErr(initRun({ ...i, pk: { ...i.pk, goalie: { ...i.pk.goalie, gaMult: NaN } } }));
});
test("initRun edge: faceoffWinRate must be strictly inside (0,1)", () => {
  const i = fiveOnFour();
  for (const r of [0, 1, NaN, 1.5]) {
    isErr(initRun({ ...i, pp: { skaters: i.pp.skaters.map((s) => ({ ...s, faceoffWinRate: r })) } }), /faceoff/);
    isErr(initRun({ ...i, pk: { ...i.pk, skaters: i.pk.skaters.map((s) => ({ ...s, faceoffWinRate: r })) } }), /faceoff/);
  }
});
test("initRun edge: no power play, bad game type, bad clock, bad seed, unknown formation", () => {
  const i = fiveOnFour();
  isErr(initRun({ ...i, penalties: [] }), /power play/);
  isErr(initRun({ ...i, gameType: 1 as unknown as 2 }), /gameType/);
  isErr(initRun({ ...i, clock: { period: 2, elapsedS: 5000 } }));
  isErr(initRun({ ...i, clock: { period: 5, elapsedS: 0 } }));
  for (const seed of [-1, 1.5, 2 ** 32, NaN]) isErr(initRun({ ...i, seed }), /seed/);
  isErr(initRun({ ...i, settings: { ...i.settings, formation: "box" as unknown as "umbrella" } }), /formation/);
});
test("initRun edge: penalty that already expired is rejected", () => {
  const i = fiveOnFour();
  const now = val(absS(i.clock, i.gameType));
  isErr(initRun({ ...i, penalties: [{ id: 1, side: "pk", kind: "minor", expiresAtS: now - 1, durationS: 120 }] }), /penalty/);
});
test("initRun: seed 0 and max uint32 are valid", () => {
  val(initRun(fiveOnFour({ seed: 0 })));
  val(initRun(fiveOnFour({ seed: 2 ** 32 - 1 })));
});

// ================================================================== legalCalls
test("legalCalls: faceoff phase offers every PP skater x 3 targets with log5 odds", () => {
  const input = fiveOnFour();
  const s = val(initRun(input));
  const opts = val(legalCalls(s, input));
  assert.equal(opts.length, 5 * 3);
  const pB = Math.max(...input.pk.skaters.map((k) => k.faceoffWinRate));
  for (const o of opts) {
    if (o.call.type !== "faceoff") assert.fail("not a faceoff call");
    const takerId = o.call.takerId;
    const pA = input.pp.skaters.find((x) => x.id === takerId)?.faceoffWinRate ?? NaN;
    const want = (pA * (1 - pB)) / (pA * (1 - pB) + pB * (1 - pA));
    assert.ok(Math.abs(o.p - want) < 1e-15);
    assert.equal(o.durationS, TIME.FACEOFF_S);
  }
});
test("legalCalls: decision phase offers passes, skates, shots and available set plays", () => {
  const input = fiveOnFour();
  const s = decisionState(input, idOn(input, "point_middle"));
  const opts = val(legalCalls(s, input));
  const n = (t: string) => opts.filter((o) => o.call.type === t).length;
  assert.equal(n("pass"), 4);
  assert.equal(n("skate"), Object.keys(OZ_SPOTS).length - 1);
  assert.equal(n("shoot"), Object.keys(SHOT_OPTIONS).length * 5);
  // umbrella 5: bumper_slot and net_front held by teammates; point_middle held by the carrier;
  // circle_top_right is nobody's and nothing is within range.
  const sp = opts.filter((o) => o.call.type === "set_play").map((o) => (o.call.type === "set_play" ? o.call.id : ""));
  assert.deepEqual(sp.sort(), ["bumper_one_timer", "net_front_tip"]);
  for (const o of opts) {
    assert.ok(Number.isFinite(o.p) && o.p >= 0 && o.p <= 1, JSON.stringify(o));
    assert.ok(Number.isInteger(o.durationS) && o.durationS >= 1);
  }
  const sh = findOption(opts, (c) => c.type === "shoot");
  assert.equal(sh.p, sh.breakdown.pGoal);
  const setp = findOption(opts, (c) => c.type === "set_play");
  assert.ok(Math.abs(setp.p - (setp.breakdown.passP ?? NaN) * (setp.breakdown.pGoal ?? NaN)) < 1e-15);
});
test("legalCalls: skate duration is max(1, ceil(dist / speed))", () => {
  const input = fiveOnFour();
  const s = decisionState(input, idOn(input, "point_middle"));
  const opts = val(legalCalls(s, input));
  const far = findOption(opts, (c) => c.type === "skate" && c.to === "goal_line_left");
  const d = Math.sqrt((89 - 33) ** 2 + 15 ** 2);
  assert.equal(far.durationS, Math.max(1, Math.ceil(d / 20)));
  assert.ok(far.durationS >= 2);
});
test("legalCalls: zone entry and breakout phases", () => {
  const input = fiveOnFour();
  const base = val(initRun(input));
  const ze = val(legalCalls({ ...base, phase: { kind: "zone_entry" }, carrier: { kind: "pp", id: 101 } }, input));
  assert.deepEqual(ze.map((o) => o.call.type === "zone_entry" ? o.call.method : "").sort(), ["carry", "drop", "dump"]);
  const bo = val(legalCalls({ ...base, phase: { kind: "breakout" }, carrier: { kind: "pp", id: 101 } }, input));
  assert.deepEqual(bo.map((o) => o.call.type === "breakout" ? o.call.method : "").sort(), ["carry", "pass", "rim"]);
  for (const o of [...ze, ...bo]) assert.ok(o.p > 0 && o.p < 1);
});
test("legalCalls: entry odds use the carrier's multipliers", () => {
  const input = fiveOnFour();
  const base = val(initRun(input));
  const ze = val(legalCalls({ ...base, phase: { kind: "zone_entry" }, carrier: { kind: "pp", id: 103 } }, input));
  const carry = findOption(ze, (c) => c.type === "zone_entry" && c.method === "carry");
  const logit = Math.log(0.6 / 0.4) + Math.log(0.9); // Synth C puckControlMult 0.9
  assert.ok(Math.abs(carry.p - 1 / (1 + Math.exp(-logit))) < 1e-12);
});
test("legalCalls edge: ended phase is an error", () => {
  const input = fiveOnFour();
  const s = val(initRun(input));
  isErr(legalCalls({ ...s, phase: { kind: "ended", reason: "pp_expired", detail: null } }, input), /ended/);
});
test("legalCalls edge: cutByClock flags options that outlast the period", () => {
  const input = fiveSecondsLeft();
  const s = decisionState(input, idOn(input, "point_middle"), { clock: { period: 1, elapsedS: 1199 } });
  const opts = val(legalCalls(s, input));
  for (const o of opts) assert.equal(o.cutByClock, o.durationS > 1, JSON.stringify(o.call));
});
test("legalCalls edge: decision without a PP carrier is an error", () => {
  const input = fiveOnFour();
  const s = decisionState(input, 101);
  isErr(legalCalls({ ...s, carrier: { kind: "pk" } }, input), /carrier/);
});
test("legalCalls edge: 4-skater OT roster and 6-skater goalie-pulled roster", () => {
  const ot = regOtFourOnThree();
  assert.equal(val(legalCalls(val(initRun(ot)), ot)).length, 4 * 3);
  const en = sixOnFourGoaliePulled();
  assert.equal(val(legalCalls(val(initRun(en)), en)).length, 6 * 3);
  const d = decisionState(en, idOn(en, "point_middle"));
  assert.equal(val(legalCalls(d, en)).filter((o) => o.call.type === "pass").length, 5);
});
test("legalCalls edge: set play receiver must hold the spot", () => {
  const input = fiveOnFour({ formation: "one_three_one" });
  // one_three_one 5 = half_wall_right, point_middle, bumper_slot, circle_top_left, net_front.
  const s = decisionState(input, idOn(input, "half_wall_right"));
  const ids = val(legalCalls(s, input)).flatMap((o) => (o.call.type === "set_play" ? [o.call.id] : []));
  assert.deepEqual(ids.sort(), ["bumper_one_timer", "net_front_tip", "point_one_timer"]);
});

// ================================================================== applyCall
test("applyCall: happy path consumes the call and pauses again", () => {
  const input = fiveOnFour();
  const s0 = val(initRun(input));
  const opt = val(legalCalls(s0, input))[0];
  if (opt === undefined) assert.fail("no options");
  const s1 = val(applyCall(s0, input, opt.call, 0));
  assert.equal(s1.callCount, 1);
  assert.ok(["faceoff", "decision", "zone_entry", "ended"].includes(s1.phase.kind), s1.phase.kind);
  assert.ok(nowS(s1, input) >= nowS(s0, input) + TIME.FACEOFF_S || s1.phase.kind === "ended");
  assert.ok(s1.log.length > s0.log.length);
  assert.equal(s0.callCount, 0, "input state is not mutated");
});
test("applyCall: probabilities shown equal probabilities sampled", () => {
  for (let seed = 0; seed < 40; seed++) {
    const input = fiveOnFour({ seed });
    let s = val(initRun(input));
    for (let k = 0; k < 12 && s.phase.kind !== "ended"; k++) {
      const opts = val(legalCalls(s, input));
      const o = opts[(seed * 7 + k * 13) % opts.length];
      if (o === undefined) assert.fail("no option");
      const next = val(applyCall(s, input, o.call, s.callCount));
      const draws = eventsAfterCall(next, s.callCount).filter(isDraw);
      if (!o.cutByClock) {
        const first = draws[0];
        if (first === undefined) assert.fail("resolved call with no draw");
        if (o.call.type === "shoot") {
          const shot = draws.find((e) => e.kind === "draw:shot");
          assert.equal(first.p, o.breakdown.pBlocked);
          if (shot !== undefined) assert.ok(Math.abs((1 - (first.p ?? NaN)) * (shot.p ?? NaN) - o.p) < 1e-12);
        } else if (o.call.type === "set_play") {
          assert.equal(first.p, o.breakdown.passP);
        } else {
          assert.equal(first.p, o.p, o.call.type);
        }
      } else {
        assert.equal(draws.length, 0, "a call cut by the clock draws nothing");
      }
      for (const e of next.log) {
        if (!isDraw(e)) continue;
        assert.ok(e.p !== undefined && e.p >= 0 && e.p <= 1);
        assert.ok(e.u !== undefined && e.u >= 0 && e.u < 1);
      }
      s = next;
    }
  }
});
test("applyCall edge 9: stale or repeated callIndex is an error and leaves state unchanged", () => {
  const input = fiveOnFour();
  const s0 = val(initRun(input));
  const call = val(legalCalls(s0, input))[0]?.call;
  if (call === undefined) assert.fail("no call");
  const s1 = val(applyCall(s0, input, call, 0));
  const snap = clone(s1);
  isErr(applyCall(s1, input, call, 0), /callIndex/);   // double tap: same index again
  isErr(applyCall(s1, input, call, 5), /callIndex/);   // from the future
  isErr(applyCall(s1, input, call, -1), /callIndex/);
  isErr(applyCall(s1, input, call, 1.5), /callIndex/);
  assert.deepEqual(s1, snap);
});
test("applyCall edge: ended run rejects calls", () => {
  const input = fiveOnFour();
  const s = val(initRun(input));
  const ended: RunState = { ...s, phase: { kind: "ended", reason: "pp_expired", detail: null } };
  isErr(applyCall(ended, input, { type: "faceoff", takerId: 101, target: "point" }, 0), /ended/);
});
test("applyCall edge: call not legal in the phase", () => {
  const input = fiveOnFour();
  const s = val(initRun(input));
  isErr(applyCall(s, input, { type: "pass", to: 102 }, 0), /phase/);
  isErr(applyCall(s, input, { type: "faceoff", takerId: 999, target: "point" }, 0), /taker/);
  isErr(applyCall(s, input, { type: "faceoff", takerId: 201, target: "point" }, 0), /taker/);
  isErr(applyCall(s, input, { type: "faceoff", takerId: 101, target: "slot" as unknown as "point" }, 0), /target/);
  isErr(applyCall(s, input, { type: "teleport" } as unknown as Call, 0));
});
test("applyCall edge: unknown pass target, self pass, unknown spot, unavailable set play", () => {
  const input = fiveOnFour();
  const carrier = idOn(input, "point_middle");
  const s = decisionState(input, carrier);
  isErr(applyCall(s, input, { type: "pass", to: 999 }, 0), /target/);
  isErr(applyCall(s, input, { type: "pass", to: carrier }, 0), /self/);
  isErr(applyCall(s, input, { type: "skate", to: "blue_paint" as unknown as "slot" }, 0), /spot/);
  isErr(applyCall(s, input, { type: "skate", to: "point_middle" }, 0), /spot/);
  isErr(applyCall(s, input, { type: "set_play", id: "cross_seam_one_timer" }, 0), /set play/);
  isErr(applyCall(s, input, { type: "shoot", option: "laser" as unknown as "wrist", corner: "top_left" }, 0));
  isErr(applyCall(s, input, { type: "shoot", option: "wrist", corner: "crossbar" as unknown as "top_left" }, 0));
});
test("applyCall edge: call cap", () => {
  const input = fiveOnFour();
  const s = val(initRun(input));
  const capped = { ...s, callCount: MAX_CALLS_PER_RUN };
  isErr(applyCall(capped, input, { type: "faceoff", takerId: 101, target: "point" }, MAX_CALLS_PER_RUN), /MAX_CALLS|cap/);
});
test("applyCall: pass success hands the puck to the receiver", () => {
  const input = fiveOnFour();
  const from = idOn(input, "point_middle");
  const to = idOn(input, "half_wall_left");
  const out = scan(500, (rng) => {
    const s = val(applyCall(decisionState(input, from, { rng }), input, { type: "pass", to }, 0));
    return s.log.some((e) => e.kind === "draw:pass" && e.detail?.hit === true) ? s : null;
  });
  assert.deepEqual(out.carrier, { kind: "pp", id: to });
  assert.deepEqual(out.puck, spotPos("half_wall_left"));
  assert.equal(out.phase.kind, "decision");
});
test("applyCall: skate success moves the carrier (teammate swaps)", () => {
  const input = fiveOnFour();
  const from = idOn(input, "point_middle");
  const mate = idOn(input, "bumper_slot");
  const out = scan(500, (rng) => {
    const s = val(applyCall(decisionState(input, from, { rng }), input, { type: "skate", to: "bumper_slot" }, 0));
    return s.log.some((e) => e.kind === "draw:skate" && e.detail?.hit === true) ? s : null;
  });
  assert.equal(out.ppSpots.find((x) => x.id === from)?.spot, "bumper_slot");
  assert.equal(out.ppSpots.find((x) => x.id === mate)?.spot, "point_middle");
  assert.equal(out.phase.kind, "decision");
});

// ================================================================== KICKOFF edge cases
test("edge 1: a goal at the exact expiry second counts as a PP goal", () => {
  const input = fiveOnFour();
  const shooter = idOn(input, "net_front");
  const now = val(absS(input.clock, input.gameType));
  const expiry = now + TIME.SHOT_S;
  const penalties = [{ id: 1, side: "pk" as const, kind: "minor" as const, expiresAtS: expiry, durationS: 120 }];
  const call: Call = { type: "shoot", option: "tip", corner: "five_hole" };
  const opt = findOption(val(legalCalls(decisionState(input, shooter, { penalties }), input)),
    (c) => c.type === "shoot" && c.option === "tip" && c.corner === "five_hole");
  assert.equal(opt.cutByClock, false);
  const out = scan(5000, (rng) => {
    const s = val(applyCall(decisionState(input, shooter, { penalties, rng }), input, call, 0));
    return s.score.pp === input.score.pp + 1 ? s : null;
  });
  const goal = out.log.find((e) => e.kind === "goal");
  assert.equal(goal?.atS, expiry);
  assert.deepEqual(out.penalties, []);
  assert.deepEqual(out.phase, { kind: "ended", reason: "pp_expired", detail: null });
  assert.equal(out.justScored, true);
});
test("edge 2: a 5v3 goal releases only the earlier minor; play continues 5v4", () => {
  const input = staggeredFiveOnThree();
  const shooter = idOn(input, "net_front");
  const call: Call = { type: "shoot", option: "tip", corner: "five_hole" };
  const out = scan(5000, (rng) => {
    const s = val(applyCall(decisionState(input, shooter, { rng }), input, call, 0));
    return s.score.pp === input.score.pp + 1 ? s : null;
  });
  assert.deepEqual(out.penalties.map((p) => p.id), [2]);
  assert.deepEqual(out.phase, { kind: "faceoff", dot: "centre" });
  assert.equal(out.justScored, true);
  const st = val(strengthOf(out.penalties, out.goaliePulled, out.clock.period, input.gameType));
  assert.deepEqual(st, { pp: 5, pk: 4 });
  assert.equal(out.pkPos.length, 4);
  // the next call clears justScored
  const next = val(applyCall(out, input, { type: "faceoff", takerId: 101, target: "point" }, 1));
  assert.equal(next.justScored, false);
});
test("edge 2b: a goal with a third penalty queued promotes it at the goal second", () => {
  const input = thirdPenaltyQueued();
  const shooter = idOn(input, "net_front");
  const out = scan(5000, (rng) => {
    const s = val(applyCall(decisionState(input, shooter, { rng }), input, { type: "shoot", option: "tip", corner: "five_hole" }, 0));
    return s.score.pp === input.score.pp + 1 ? s : null;
  });
  const goalAt = out.log.find((e) => e.kind === "goal")?.atS ?? NaN;
  const promoted = out.penalties.find((p) => p.id === 3);
  assert.equal(promoted?.expiresAtS, goalAt + 120);
  assert.deepEqual(out.phase, { kind: "faceoff", dot: "centre" });
});
test("edge 3: period ends mid-PP: penalty carries over, centre faceoff, nothing drawn", () => {
  const input = fiveSecondsLeft();
  const s = decisionState(input, idOn(input, "point_middle"), { clock: { period: 1, elapsedS: 1199 } });
  const opt = findOption(val(legalCalls(s, input)), (c) => c.type === "skate" && c.to === "goal_line_left");
  assert.equal(opt.cutByClock, true);
  const out = val(applyCall(s, input, opt.call, 0));
  assert.deepEqual(out.clock, { period: 2, elapsedS: 0 });
  assert.deepEqual(out.phase, { kind: "faceoff", dot: "centre" });
  assert.deepEqual(out.penalties, s.penalties);
  assert.equal(eventsAfterCall(out, 0).filter(isDraw).length, 0);
  assert.ok(out.log.some((e) => e.kind === "cut_by_clock"));
  assert.deepEqual(out.puck, { ...FACEOFF_DOTS.centre });
});
test("edge 3b: end of a tied P3 in the regular season goes to OT at 4v3", () => {
  const input = fiveOnFour();
  const t = val(absS({ period: 3, elapsedS: 1199 }, 2));
  const s = decisionState(input, idOn(input, "point_middle"), { clock: { period: 3, elapsedS: 1199 },
    score: { pp: 2, pk: 2 },
    penalties: [{ id: 1, side: "pk", kind: "minor", expiresAtS: t + 60, durationS: 120 }] });
  const out = val(applyCall(s, input, { type: "skate", to: "goal_line_left" }, 0));
  assert.deepEqual(out.clock, { period: 4, elapsedS: 0 });
  assert.deepEqual(out.phase, { kind: "faceoff", dot: "centre" });
  assert.equal(out.ppSpots.length, 4);
  assert.equal(out.pkPos.length, 3);
  assert.equal(val(legalCalls(out, input)).length, 4 * 3);
});
test("edge 3c: end of an untied P3 ends the game", () => {
  const input = fiveOnFour();
  const t = val(absS({ period: 3, elapsedS: 1199 }, 2));
  const s = decisionState(input, idOn(input, "point_middle"), { clock: { period: 3, elapsedS: 1199 },
    score: { pp: 1, pk: 2 },
    penalties: [{ id: 1, side: "pk", kind: "minor", expiresAtS: t + 60, durationS: 120 }] });
  const out = val(applyCall(s, input, { type: "skate", to: "goal_line_left" }, 0));
  assert.deepEqual(out.phase, { kind: "ended", reason: "game_end", detail: "regulation_end" });
});
test("edge 3d: PP ending before the period is pp_expired, not a period change", () => {
  const input = fiveOnFour();
  const now = val(absS(input.clock, input.gameType));
  const s = decisionState(input, idOn(input, "point_middle"), {
    penalties: [{ id: 1, side: "pk", kind: "minor", expiresAtS: now + 1, durationS: 120 }] });
  const out = val(applyCall(s, input, { type: "skate", to: "goal_line_left" }, 0));
  assert.deepEqual(out.phase, { kind: "ended", reason: "pp_expired", detail: null });
  assert.equal(nowS(out, input), now + 1);
});
test("edge 3e: a PP goal in OT ends the game", () => {
  for (const input of [regOtFourOnThree(), playoffOt()]) {
    const shooter = idOn(input, "net_front");
    const out = scan(5000, (rng) => {
      const s = val(applyCall(decisionState(input, shooter, { rng }), input, { type: "shoot", option: "tip", corner: "five_hole" }, 0));
      return s.score.pp === input.score.pp + 1 ? s : null;
    });
    assert.deepEqual(out.phase, { kind: "ended", reason: "game_end", detail: "ot_goal" });
  }
});

function clearScenario(remainingAfterFaceoff: number, opts: FixtureOpts): { input: RunInput; s0: RunState } {
  const input = loseFaceoffs(fiveOnFour(opts));
  const s = val(initRun(input));
  const now = val(absS(input.clock, input.gameType));
  const expiry = now + TIME.FACEOFF_S + remainingAfterFaceoff;
  return { input, s0: { ...s, penalties: [{ id: 1, side: "pk", kind: "minor", expiresAtS: expiry, durationS: 120 }] } };
}
test("edge 4: a clear with too little time left ends the run cleanly", () => {
  const { input, s0 } = clearScenario(CLEAR_REENTRY_MIN_S - 1, {});
  const out = scan(500, (rng) => {
    const s = val(applyCall({ ...s0, rng }, input, { type: "faceoff", takerId: 101, target: "point" }, 0));
    const c = s.log.find((e) => e.kind === "clear");
    return c !== undefined && c.detail?.remainingS === CLEAR_REENTRY_MIN_S - 1 ? s : null;
  });
  assert.deepEqual(out.phase, { kind: "ended", reason: "cleared_out", detail: null });
});
test("edge 4b: a clear with exactly CLEAR_REENTRY_MIN_S left continues", () => {
  const { input, s0 } = clearScenario(CLEAR_REENTRY_MIN_S, { askEveryTouch: true });
  const out = scan(500, (rng) => {
    const s = val(applyCall({ ...s0, rng }, input, { type: "faceoff", takerId: 101, target: "point" }, 0));
    const c = s.log.find((e) => e.kind === "clear");
    return c !== undefined && c.detail?.remainingS === CLEAR_REENTRY_MIN_S ? s : null;
  });
  assert.equal(out.phase.kind, "breakout");
  const bo = val(legalCalls(out, input));
  assert.equal(bo.length, 3);
});
test("edge 4c: without askEveryTouch the breakout is auto-played to the zone entry", () => {
  const { input, s0 } = clearScenario(CLEAR_REENTRY_MIN_S + 30, {});
  const out = scan(500, (rng) => {
    const s = val(applyCall({ ...s0, rng }, input, { type: "faceoff", takerId: 101, target: "point" }, 0));
    return s.log.some((e) => e.kind === "clear") && s.phase.kind === "zone_entry" ? s : null;
  });
  assert.ok(out.log.some((e) => e.kind === "draw:breakout" && e.callIndex === null));
  assert.equal(out.carrier.kind, "pp");
});
test("edge 5: 6v4 empty-net goal against ends the run", () => {
  const input = loseFaceoffs(sixOnFourGoaliePulled());
  const out = scan(3000, (rng) => {
    const s0 = { ...val(initRun(input)), rng };
    const s = val(autoPlay(s0, input, firstPolicy, 60));
    return s.phase.kind === "ended" && s.phase.reason === "sh_goal" ? s : null;
  });
  assert.deepEqual(out.phase, { kind: "ended", reason: "sh_goal", detail: "empty_net" });
  assert.equal(out.score.pk, input.score.pk + 1);
  assert.equal(out.score.pp, input.score.pp);
});
test("edge 7: the run state carries no wall-clock or date fields", () => {
  const input = fiveOnFour();
  const s = val(autoPlay(val(initRun(input)), input, randomPolicy(3), 30));
  const keys = new Set<string>();
  const walk = (x: unknown): void => {
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (x !== null && typeof x === "object") {
      for (const [k, v] of Object.entries(x)) { keys.add(k); walk(v); }
    }
  };
  walk(s);
  for (const k of keys) assert.doesNotMatch(k, /date|timestamp|wall|epoch|^now$|^ms$/i, k);
  assert.doesNotMatch(JSON.stringify(s), /\d{4}-\d{2}-\d{2}T/);
});

// ================================================================== replay / determinism
function recordRun(input: RunInput, policy: Policy, max: number): { calls: Call[]; states: RunState[] } {
  let s = val(initRun(input));
  const calls: Call[] = [];
  const states = [s];
  while (s.phase.kind !== "ended" && calls.length < max) {
    const c = policy(val(legalCalls(s, input)), s);
    s = val(applyCall(s, input, c, s.callCount));
    calls.push(c);
    states.push(s);
  }
  return { calls, states };
}
test("replay: equals step-by-step application", () => {
  const input = staggeredFiveOnThree({ seed: 77 });
  const { calls, states } = recordRun(input, randomPolicy(77), 40);
  assert.ok(calls.length > 0);
  assert.deepEqual(val(replay(input, calls)), states[states.length - 1]);
});
test("determinism: same input + calls => identical run", () => {
  for (const mk of Object.values(ALL_FIXTURES)) {
    const input = mk({ seed: 4242 });
    const a = recordRun(input, randomPolicy(9), 60);
    const b = val(replay(input, a.calls));
    const c = val(replay(clone(input), clone(a.calls)));
    assert.deepEqual(b, c);
    assert.deepEqual(b, a.states[a.states.length - 1]);
  }
});
test("determinism: JSON round-trip mid-run then continuing equals the uninterrupted run", () => {
  const input = fiveOnFour({ seed: 5 });
  const { calls, states } = recordRun(input, randomPolicy(5), 40);
  const mid = Math.floor(calls.length / 2);
  let s = clone(states[mid]) as RunState;
  for (let k = mid; k < calls.length; k++) {
    const c = calls[k];
    if (c === undefined) assert.fail("missing call");
    s = val(applyCall(clone(s), clone(input), c, k));
  }
  assert.deepEqual(s, states[states.length - 1]);
});
test("determinism: different seeds diverge", () => {
  const a = val(autoPlay(val(initRun(fiveOnFour({ seed: 1 }))), fiveOnFour({ seed: 1 }), firstPolicy, 20));
  const b = val(autoPlay(val(initRun(fiveOnFour({ seed: 2 }))), fiveOnFour({ seed: 2 }), firstPolicy, 20));
  assert.notDeepEqual(a.log, b.log);
});
test("replay edge: empty call list equals initRun", () => {
  const input = fiveOnFour();
  assert.deepEqual(val(replay(input, [])), val(initRun(input)));
});
test("replay edge: invalid input is an error", () => {
  isErr(replay({ ...fiveOnFour(), seed: -3 }, []), /seed/);
});
test("replay edge: an illegal call fails with its index", () => {
  const input = fiveOnFour();
  isErr(replay(input, [{ type: "pass", to: 102 }]), /call 0/);
  const { calls } = recordRun(input, randomPolicy(1), 3);
  isErr(replay(input, [...calls.slice(0, 1), { type: "breakout", method: "rim" }]), /call 1/);
});
test("replay edge: calls after the run ended are rejected", () => {
  const input = fiveOnFour({ seed: 8 });
  const { calls, states } = recordRun(input, randomPolicy(8), MAX_CALLS_PER_RUN);
  assert.equal(states[states.length - 1]?.phase.kind, "ended");
  isErr(replay(input, [...calls, { type: "faceoff", takerId: 101, target: "point" }]), /ended/);
});
test("replay edge: does not mutate input or calls", () => {
  const input = fiveOnFour();
  const { calls } = recordRun(input, randomPolicy(2), 5);
  const bi = clone(input), bc = clone(calls);
  val(replay(input, calls));
  assert.deepEqual(input, bi);
  assert.deepEqual(calls, bc);
});

// ================================================================== autoPlay
test("autoPlay: plays a run to the end", () => {
  const input = doubleMinorInput();
  const s = val(autoPlay(val(initRun(input)), input, firstPolicy, MAX_CALLS_PER_RUN));
  assert.equal(s.phase.kind, "ended");
  assert.ok(s.callCount > 0);
});
function doubleMinorInput(): RunInput {
  const mk = ALL_FIXTURES.doubleMinor;
  if (mk === undefined) assert.fail("missing fixture");
  return mk({ seed: 31 });
}
test("autoPlay edge: maxCalls 0 returns the state unchanged", () => {
  const input = fiveOnFour();
  const s = val(initRun(input));
  assert.deepEqual(val(autoPlay(s, input, firstPolicy, 0)), s);
});
test("autoPlay edge: stops after maxCalls", () => {
  const input = fiveOnFour();
  const s = val(autoPlay(val(initRun(input)), input, firstPolicy, 1));
  assert.equal(s.callCount, 1);
});
test("autoPlay edge: invalid maxCalls is an error", () => {
  const input = fiveOnFour();
  const s = val(initRun(input));
  for (const m of [-1, 1.5, NaN]) isErr(autoPlay(s, input, firstPolicy, m), /maxCalls/);
});
test("autoPlay edge: a policy returning an illegal call is an error", () => {
  const input = fiveOnFour();
  isErr(autoPlay(val(initRun(input)), input, () => ({ type: "pass", to: 102 }), 5), /phase/);
});
test("autoPlay edge: an ended state is returned as-is", () => {
  const input = fiveOnFour();
  const s = val(autoPlay(val(initRun(input)), input, firstPolicy, MAX_CALLS_PER_RUN));
  assert.deepEqual(val(autoPlay(s, input, firstPolicy, 10)), s);
});
test("autoPlay edge: the policy sees the current state", () => {
  const input = fiveOnFour();
  const seen: number[] = [];
  val(autoPlay(val(initRun(input)), input, (opts, st) => { seen.push(st.callCount); return firstPolicy(opts, st); }, 4));
  assert.deepEqual(seen, [0, 1, 2, 3].slice(0, seen.length));
});

// ================================================================== smoke
test("smoke: 200 seeded random-policy runs finish without errors and with sane options", () => {
  const makers = Object.values(ALL_FIXTURES);
  const ends = new Set<string>();
  for (let seed = 0; seed < 200; seed++) {
    const mk = makers[seed % makers.length];
    if (mk === undefined) assert.fail("no fixture");
    const input = mk({ seed, askEveryTouch: seed % 3 === 0, formation: seed % 2 === 0 ? "umbrella" : "one_three_one" });
    const rand = mulberry32(seed ^ 0x5eed);
    const policy: Policy = (opts) => {
      for (const o of opts) assert.ok(Number.isFinite(o.p) && o.p >= 0 && o.p <= 1);
      const o = opts[Math.floor(rand() * opts.length)];
      if (o === undefined) throw new Error("no options");
      return o.call;
    };
    const s = val(autoPlay(val(initRun(input)), input, policy, MAX_CALLS_PER_RUN));
    assert.equal(s.phase.kind, "ended", `seed ${seed}`);
    if (s.phase.kind === "ended") ends.add(s.phase.reason);
    assert.ok(s.score.pp >= input.score.pp && s.score.pk >= input.score.pk);
  }
  assert.ok(ends.has("pp_expired"));
});
test("SET_PLAYS sanity for the tests above", () => {
  assert.equal(SET_PLAYS.cross_seam_one_timer.toSpot, "circle_top_right");
});

// ================================================================== bench skaters (PP strength rises)
/** Plays random runs; checks the on-ice roster matches strength after every call; returns strengths seen. */
function playChecked(mk: (o?: FixtureOpts) => RunInput, seeds: number): { strengths: Set<string>; ends: Set<string> } {
  const strengths = new Set<string>(), ends = new Set<string>();
  for (let seed = 0; seed < seeds; seed++) {
    const input = mk({ seed });
    const rand = mulberry32(seed + 1);
    let s = val(initRun(input));
    while (s.phase.kind !== "ended") {
      const st = val(strengthOf(s.penalties, s.goaliePulled, s.clock.period, input.gameType));
      assert.equal(s.ppSpots.length, st.pp, `seed ${seed}`);
      assert.equal(new Set(s.ppSpots.map((x) => x.id)).size, st.pp);
      assert.equal(new Set(s.ppSpots.map((x) => x.spot)).size, st.pp, "no two skaters share a spot");
      strengths.add(`${st.pp}v${st.pk}`);
      const opts = val(legalCalls(s, input));
      const o = opts[Math.floor(rand() * opts.length)];
      if (o === undefined) assert.fail("no options");
      s = val(applyCall(s, input, o.call, s.callCount));
    }
    if (s.phase.kind === "ended") ends.add(s.phase.reason);
  }
  return { strengths, ends };
}
test("bench: 4v3 with a PP minor starts with the first 4 input skaters on the ice", () => {
  const input = fourOnThreePpPenalty();
  const s = val(initRun(input));
  assert.deepEqual(s.ppSpots.map((x) => x.id).sort(), input.pp.skaters.slice(0, 4).map((x) => x.id).sort());
  assert.equal(val(legalCalls(s, input)).length, 4 * 3);
});
test("bench: 4v3 -> 5v3 -> 5v4 plays to the end with the bench skater joining", () => {
  const { strengths, ends } = playChecked(fourOnThreePpPenalty, 300);
  for (const k of ["4v3", "5v3", "5v4"]) assert.ok(strengths.has(k), `never saw ${k}: ${[...strengths].join(",")}`);
  assert.ok(ends.has("pp_expired"));
});
test("bench: regular-season OT with an expiring PP minor goes 4v3 -> 5v3", () => {
  const { strengths } = playChecked(regOtPpPenalty, 300);
  assert.ok(strengths.has("4v3") && strengths.has("5v3"), [...strengths].join(","));
});
test("bench: the joining skater arrives without moving the receiver", () => {
  const input = fourOnThreePpPenalty();
  const t = val(absS(input.clock, input.gameType));
  const carrier = idOn(input, "point_middle");
  // The PP minor expires at the end of a 1 s pass: the bench skater joins at that second.
  const penalties = input.penalties.map((p) => (p.side === "pp" ? { ...p, expiresAtS: t + 1 } : p));
  const s = decisionState(input, carrier, { penalties });
  const to = idOn(input, "half_wall_left");
  const out = scan(500, (rng) => {
    const r = val(applyCall({ ...s, rng }, input, { type: "pass", to }, 0));
    return r.phase.kind === "decision" && r.carrier.kind === "pp" && r.carrier.id === to ? r : null;
  });
  assert.equal(out.ppSpots.length, 5);
  assert.ok(out.ppSpots.some((x) => x.id === 105), "bench skater Synth E joined");
  assert.equal(out.ppSpots.find((x) => x.id === to)?.spot, "half_wall_left");
});
test("bench edge: roster size must be between the starting and the max reachable strength", () => {
  const i = fiveOnFour();
  const first = i.pp.skaters[0];
  if (first === undefined) assert.fail("no skater");
  const extra = { ...first, id: 999, name: "Synth Z" };
  isErr(initRun({ ...i, pp: { skaters: [...i.pp.skaters, extra] } }), /PP skaters/);
  const en = sixOnFourGoaliePulled();
  isErr(initRun({ ...en, pp: { skaters: [...en.pp.skaters, extra] } }), /PP skaters/);
  isErr(initRun({ ...en, pp: { skaters: en.pp.skaters.slice(0, 5) } }), /PP skaters/);
});
test("roster vs timeline: a 4v3 whose PP minor ends first needs 5 PP skaters", () => {
  const f = fourOnThreePpPenalty();
  isErr(initRun({ ...f, pp: { skaters: f.pp.skaters.slice(0, 4) } }), /reaches 5 PP skaters.*only 4/);
  val(initRun(f));
});
test("roster vs timeline: plain 5v4 with 5 skaters is accepted, with 4 rejected", () => {
  const i = fiveOnFour();
  val(initRun(i));
  isErr(initRun({ ...i, pp: { skaters: i.pp.skaters.slice(0, 4) } }), /reaches 5 PP skaters/);
});
test("roster vs timeline: goalie-pulled 6v4 needs 6", () => {
  const en = sixOnFourGoaliePulled();
  val(initRun(en));
  isErr(initRun({ ...en, pp: { skaters: en.pp.skaters.slice(0, 5) } }), /reaches 6 PP skaters/);
});
test("roster vs timeline: OT 4v3 with an expiring PP minor needs 5", () => {
  const o = regOtPpPenalty();
  isErr(initRun({ ...o, pp: { skaters: o.pp.skaters.slice(0, 4) } }), /reaches 5 PP skaters/);
  val(initRun(o));
});
test("roster vs timeline: 300 random runs of the 4v3 fixture never hit a roster error", () => {
  for (let seed = 0; seed < 300; seed++) {
    const input = fourOnThreePpPenalty({ seed });
    val(autoPlay(val(initRun(input)), input, randomPolicy(seed), MAX_CALLS_PER_RUN));
  }
});

// ================================================================== malformed input / state never throws
test("malformed input returns err (never throws)", () => {
  const i = fiveOnFour();
  const cases: unknown[] = [
    null, 42,
    { ...i, penalties: undefined },
    { ...i, penalties: null },
    { ...i, penalties: [null] },
    { ...i, penalties: [{ id: 1 }] },
    { ...i, clock: null },
    { ...i, clock: { period: "2", elapsedS: 0 } },
    { ...i, score: null },
    { ...i, pp: null },
    { ...i, pp: { skaters: [null, ...i.pp.skaters.slice(1)] } },
    { ...i, pp: { skaters: i.pp.skaters.map((s, k) => (k === 0 ? { ...s, pos: undefined } : s)) } },
    { ...i, pk: { ...i.pk, skaters: [null, ...i.pk.skaters.slice(1)] } },
    { ...i, pk: { ...i.pk, goalie: null } },
    { ...i, pk: null },
    { ...i, rates: [null, ...i.rates] },
    { ...i, rates: null },
    { ...i, settings: null },
  ];
  cases.forEach((c, k) => {
    assert.doesNotThrow(() => isErr(initRun(c as RunInput)), `initRun case ${k}`);
    assert.doesNotThrow(() => isErr(replay(c as RunInput, [])), `replay case ${k}`);
  });
  const s = val(initRun(i));
  // malformed input on a later call
  assert.doesNotThrow(() => isErr(legalCalls(s, { ...i, rates: [null] } as unknown as RunInput)));
  assert.doesNotThrow(() => isErr(applyCall(s, { ...i, pp: { skaters: [null] } } as unknown as RunInput,
    { type: "faceoff", takerId: 101, target: "point" }, 0)));
});
test("malformed RunState passed to legalCalls / applyCall returns err (never throws)", () => {
  const input = fiveOnFour();
  const s = val(initRun(input));
  const call: Call = { type: "faceoff", takerId: 101, target: "point" };
  const bad: unknown[] = [
    null, "state",
    { ...s, v: 2 },
    { ...s, clock: null },
    { ...s, clock: { period: 2 } },
    { ...s, penalties: undefined },
    { ...s, penalties: [null] },
    { ...s, ppSpots: null },
    { ...s, ppSpots: [null] },
    { ...s, ppSpots: [{ id: 101, spot: "nowhere" }] },
    { ...s, pkPos: [null] },
    { ...s, puck: null },
    { ...s, puck: { x: NaN, y: 0 } },
    { ...s, phase: null },
    { ...s, phase: { kind: "faceoff", dot: "moon" } },
    { ...s, phase: { kind: "ended", reason: "bored", detail: null } },
    { ...s, carrier: null },
    { ...s, carrier: { kind: "pp", id: "x" } },
    { ...s, score: null },
    { ...s, rng: -1 },
    { ...s, rng: 1.5 },
    { ...s, callCount: undefined },
    { ...s, step: -1 },
    { ...s, log: null },
    { ...s, goaliePulled: "no" },
    { ...s, justScored: 0 },
  ];
  bad.forEach((b, k) => {
    assert.doesNotThrow(() => isErr(legalCalls(b as RunState, input)), `legalCalls case ${k}`);
    assert.doesNotThrow(() => isErr(applyCall(b as RunState, input, call, 0)), `applyCall case ${k}`);
    assert.doesNotThrow(() => isErr(autoPlay(b as RunState, input, firstPolicy, 3)), `autoPlay case ${k}`);
  });
  assert.doesNotThrow(() => isErr(applyCall(s, input, null as unknown as Call, 0)));
  assert.doesNotThrow(() => isErr(applyCall(s, input, "pass" as unknown as Call, 0)));
});

// ================================================================== call log hygiene
test("the call event logs only the known fields of the call", () => {
  const input = fiveOnFour();
  const s = val(initRun(input));
  const junk = { type: "faceoff", takerId: 101, target: "point", evil: "<script>", nested: { a: 1 } } as unknown as Call;
  const out = val(applyCall(s, input, junk, 0));
  const ev = out.log.find((e) => e.kind === "call");
  assert.deepEqual(ev?.detail, { type: "faceoff", takerId: 101, target: "point" });
});

// ================================================================== base-rate coverage
test("initRun edge: base rates must cover every option at every reachable distance bucket", () => {
  const i = fiveOnFour();
  isErr(initRun({ ...i, rates: [] }), /base-rate/);
  // net_front (5 ft) is in bucket 0
  isErr(initRun({ ...i, rates: synthRates().filter((r) => r.dist_bucket !== 0) }), /base-rate/);
  // no OZ spot is 64+ ft from the net, so bucket 5 is never needed
  val(initRun({ ...i, rates: synthRates().filter((r) => r.dist_bucket !== 5) }));
});

// ================================================================== shot split breakdown
test("shot options expose the sampled goal / save / miss split given unblocked", () => {
  const input = fiveOnFour();
  const s = decisionState(input, idOn(input, "point_middle"));
  let n = 0;
  for (const o of val(legalCalls(s, input))) {
    if (o.call.type !== "shoot" && o.call.type !== "set_play") continue;
    n++;
    const g = o.breakdown.pGoalIfUnblocked ?? NaN;
    const sv = o.breakdown.pSaveIfUnblocked ?? NaN;
    const mi = o.breakdown.pMissIfUnblocked ?? NaN;
    for (const x of [g, sv, mi]) assert.ok(x >= 0 && x <= 1, JSON.stringify(o.breakdown));
    assert.ok(Math.abs(g + sv + mi - 1) < 1e-12);
    assert.ok(Math.abs((1 - (o.breakdown.pBlocked ?? NaN)) * g - (o.breakdown.pGoal ?? NaN)) < 1e-12);
  }
  assert.ok(n > 0);
});
