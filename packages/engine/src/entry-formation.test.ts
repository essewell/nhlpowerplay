/**
 * Formations (overload, spread), zone-entry lanes and landings, formation changes on entries and
 * offensive-zone faceoffs. SYNTHETIC fixtures only. Single-threaded; all state is local to each test.
 * Randomness: only scans over explicit PRNG states (no ambient randomness), so failures reproduce.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTRY, PP_FORMATIONS } from "./constants.ts";
import type { SpotName } from "./constants.ts";
import { formationSpots, mirrorSpot, placePp, placePpPinned } from "./formation.ts";
import type { Result } from "./result.ts";
import { FORMATION_FIXTURES, fiveOnFour, fiveOnFourOverload, fiveOnFourSpread } from "./sim-fixtures.ts";
import type { Call, EntryLane, EntryMethod, PpFormationName, RunInput, RunState } from "./sim-types.ts";
import { applyCall, initRun, legalCalls, replay } from "./sim.ts";

const FORMATIONS: readonly PpFormationName[] = ["umbrella", "one_three_one", "overload", "spread"];
const METHODS: readonly EntryMethod[] = ["carry", "drop", "dump"];
const LANES: readonly EntryLane[] = ["left", "middle", "right"];
const SCAN_LIMIT = 400;

function val<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(`expected ok, got error: ${r.error}`);
  return r.value;
}
function isErr<T>(r: Result<T>, re: RegExp): void {
  assert.equal(r.ok, false, "expected an error");
  if (!r.ok) assert.match(r.error, re);
}

/** A zone-entry pause with skater 101 carrying from centre ice. */
function entryState(input: RunInput, patch: Partial<RunState> = {}): RunState {
  const s = val(initRun(input));
  return { ...s, phase: { kind: "zone_entry" }, carrier: { kind: "pp", id: 101 }, ...patch };
}
const spotsOf = (s: RunState): Map<number, SpotName> => new Map(s.ppSpots.map((x) => [x.id, x.spot]));

/** First PRNG state (scanning 1..SCAN_LIMIT) under which `call` resolves with the entry draw `hit`. */
function entryOutcome(input: RunInput, base: RunState, call: Call, hit: boolean): RunState {
  for (let rng = 1; rng <= SCAN_LIMIT; rng++) {
    const s = val(applyCall({ ...base, rng }, input, call, base.callCount));
    const ev = s.log.find((e, i) => i >= base.log.length && e.kind === "draw:entry");
    if (ev !== undefined && ev.detail?.hit === hit) return s;
  }
  return assert.fail(`no PRNG state produced entry hit=${hit}`);
}

// ---------------------------------------------------------------- formation tables

test("PP_FORMATIONS: overload and spread are defined for 4, 5 and 6 skaters with distinct spots", () => {
  for (const name of ["overload", "spread"] as const) {
    for (const n of [4, 5, 6] as const) {
      const spots = PP_FORMATIONS[name][n];
      assert.equal(spots.length, n);
      assert.equal(new Set(spots).size, n);
    }
  }
});

test("mirrorSpot: left/right pairs swap, centre spots are fixed, double mirror is identity", () => {
  assert.equal(mirrorSpot("half_wall_left"), "half_wall_right");
  assert.equal(mirrorSpot("goal_line_right"), "goal_line_left");
  assert.equal(mirrorSpot("net_front"), "net_front");
  assert.equal(mirrorSpot("point_middle"), "point_middle");
  assert.equal(mirrorSpot(mirrorSpot("circle_top_left")), "circle_top_left");
});

test("formationSpots: overload mirrors for the right side; the other formations ignore the side", () => {
  const left = val(formationSpots("overload", 5, "left"));
  const right = val(formationSpots("overload", 5, "right"));
  assert.deepEqual(right, left.map(mirrorSpot));
  assert.equal(right[0], "half_wall_right");
  for (const f of ["umbrella", "one_three_one", "spread"] as const) {
    assert.deepEqual(val(formationSpots(f, 5, "right")), val(formationSpots(f, 5, "left")));
  }
});

test("formationSpots edge: bad formation, side or count are errors", () => {
  isErr(formationSpots("diamond" as PpFormationName, 5), /formation/);
  isErr(formationSpots("overload", 5, "up" as "left"), /side/);
  isErr(formationSpots("overload", 3), /4, 5 or 6/);
  isErr(formationSpots("overload", 7), /4, 5 or 6/);
});

test("placePp: overload on the right puts the carrier on the right half wall; default side is left", () => {
  const r = val(placePp([1, 2, 3, 4, 5], "overload", 3, "right"));
  assert.deepEqual(r.find((x) => x.id === 3)?.spot, "half_wall_right");
  assert.deepEqual(val(placePp([1, 2, 3, 4, 5], "overload", 3)).find((x) => x.id === 3)?.spot, "half_wall_left");
});

// ---------------------------------------------------------------- pinned placement

test("placePpPinned: a pin on a formation spot takes it; the others fill the rest in input order", () => {
  const r = val(placePpPinned([1, 2, 3, 4, 5], "umbrella", "left", [{ id: 3, spot: "half_wall_right" }]));
  assert.equal(r.find((x) => x.id === 3)?.spot, "half_wall_right");
  assert.deepEqual(r.map((x) => x.id), [1, 2, 3, 4, 5]);
  assert.equal(new Set(r.map((x) => x.spot)).size, 5);
  assert.deepEqual(r.filter((x) => x.id !== 3).map((x) => x.spot), ["point_middle", "half_wall_left", "bumper_slot", "net_front"]);
});

test("placePpPinned: a pin outside the formation vacates the nearest formation spot", () => {
  const r = val(placePpPinned([1, 2, 3, 4, 5], "umbrella", "left", [{ id: 1, spot: "goal_line_left" }]));
  assert.equal(r.find((x) => x.id === 1)?.spot, "goal_line_left");
  assert.equal(new Set(r.map((x) => x.spot)).size, 5);
  // net_front is the umbrella spot nearest goal_line_left (dist ~15.8); half_wall_left is further.
  assert.ok(!r.filter((x) => x.id !== 1).some((x) => x.spot === "net_front"));
});

test("placePpPinned: two pins (a drop entry) are both honoured", () => {
  const r = val(placePpPinned([1, 2, 3, 4], "spread", "left", [{ id: 2, spot: "point_left" }, { id: 1, spot: "half_wall_left" }]));
  assert.equal(r.find((x) => x.id === 2)?.spot, "point_left");
  assert.equal(r.find((x) => x.id === 1)?.spot, "half_wall_left");
  assert.equal(new Set(r.map((x) => x.spot)).size, 4);
});

test("placePpPinned edge: unknown skater, duplicate skater, duplicate spot, bad spot, no pins", () => {
  isErr(placePpPinned([1, 2, 3, 4], "umbrella", "left", [{ id: 9, spot: "net_front" }]), /not among/);
  isErr(placePpPinned([1, 2, 3, 4], "umbrella", "left", [{ id: 1, spot: "net_front" }, { id: 1, spot: "slot" }]), /twice/);
  isErr(placePpPinned([1, 2, 3, 4], "umbrella", "left", [{ id: 1, spot: "slot" }, { id: 2, spot: "slot" }]), /twice/);
  isErr(placePpPinned([1, 2, 3, 4], "umbrella", "left", [{ id: 1, spot: "nowhere" as SpotName }]), /spot/);
  const none = val(placePpPinned([1, 2, 3, 4], "umbrella", "left", []));
  assert.deepEqual(none.map((x) => x.spot), PP_FORMATIONS.umbrella[4]);
  isErr(placePpPinned([1, 1, 3, 4], "umbrella", "left", []), /duplicate/);
});

// ---------------------------------------------------------------- initial state

test("initRun: formation starts at settings.formation; the side follows the opening draw dot", () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= 40; seed++) {
    const input = fiveOnFourOverload({ seed });
    const s = val(initRun(input));
    assert.equal(s.formation, "overload");
    const dot = s.phase.kind === "faceoff" ? s.phase.dot : "?";
    assert.equal(s.formationSide, dot === "oz_left" ? "left" : "right");
    const first = s.ppSpots[0]?.spot;
    assert.equal(first, dot === "oz_left" ? "half_wall_left" : "half_wall_right");
    seen.add(dot);
  }
  assert.deepEqual([...seen].sort(), ["oz_left", "oz_right"]);
});

test("initRun: every formation x fixture starts with distinct spots and the right skater count", () => {
  for (const build of Object.values(FORMATION_FIXTURES)) {
    for (const f of FORMATIONS) {
      const input = build({ formation: f });
      const s = val(initRun(input));
      assert.equal(s.formation, f);
      assert.equal(new Set(s.ppSpots.map((x) => x.spot)).size, s.ppSpots.length);
    }
  }
});

// ---------------------------------------------------------------- legal entry calls and odds

test("legalCalls: a zone entry offers 3 methods x 3 lanes, each carrying formation = state.formation", () => {
  for (const f of FORMATIONS) {
    const input = fiveOnFour({ formation: f });
    const opts = val(legalCalls(entryState(input), input));
    assert.equal(opts.length, 9);
    const keys = new Set<string>();
    for (const o of opts) {
      assert.equal(o.call.type, "zone_entry");
      if (o.call.type === "zone_entry") {
        assert.equal(o.call.formation, f);
        keys.add(`${o.call.method}/${o.call.lane}`);
      }
    }
    assert.equal(keys.size, 9);
  }
});

test("legalCalls: lane odds — the lane away from the PK shade is likelier, breakdown exposes the factor", () => {
  const input = fiveOnFour();
  const s = entryState(input, { formationSide: "left" });
  const opts = val(legalCalls(s, input));
  const p = (m: EntryMethod, l: EntryLane): number => {
    const o = opts.find((x) => x.call.type === "zone_entry" && x.call.method === m && x.call.lane === l);
    if (o === undefined) assert.fail("missing option");
    return o.p;
  };
  for (const m of METHODS) {
    assert.ok(p(m, "right") > p(m, "middle"), `${m}: weak side beats middle`);
    assert.ok(p(m, "middle") > p(m, "left"), `${m}: middle beats strong side`);
  }
  const strong = opts.find((x) => x.call.type === "zone_entry" && x.call.lane === "left");
  assert.equal(strong?.breakdown.laneLogit, ENTRY.LANE_LOGIT.strong);
  assert.ok(Math.abs((strong?.breakdown.laneOddsMult ?? 0) - Math.exp(ENTRY.LANE_LOGIT.strong)) < 1e-12);
  // The mirror image when the shade is on the right.
  const mirror = val(legalCalls(entryState(input, { formationSide: "right" }), input));
  const left = mirror.find((x) => x.call.type === "zone_entry" && x.call.method === "carry" && x.call.lane === "left");
  assert.ok((left?.p ?? 0) > p("carry", "middle"));
});

test("legalCalls: a call without a lane prices exactly like the middle lane", () => {
  const input = fiveOnFour();
  const s = entryState(input);
  const opts = val(legalCalls(s, input));
  const mid = opts.find((o) => o.call.type === "zone_entry" && o.call.method === "drop" && o.call.lane === "middle");
  const single = val(applyCall(s, input, { type: "zone_entry", method: "drop" }, 0));
  const ev = single.log.find((e) => e.kind === "call");
  assert.equal(ev?.p, mid?.p);
});

test("lane odds stay within [P_FLOOR, P_CAP] for extreme ratings", () => {
  for (const [mult, bound] of [[1000, ENTRY.P_CAP], [0.0001, ENTRY.P_FLOOR]] as const) {
    const input = fiveOnFour();
    const sk = input.pp.skaters[0];
    if (sk === undefined) assert.fail("no skater");
    sk.puckControlMult = mult;
    sk.playmakingMult = mult;
    const opts = val(legalCalls(entryState(input), input));
    for (const o of opts) {
      if (o.call.type === "zone_entry" && o.call.method !== "dump") {
        assert.ok(o.p >= ENTRY.P_FLOOR && o.p <= ENTRY.P_CAP);
        assert.equal(o.p, bound);
      }
    }
  }
});

// ---------------------------------------------------------------- landings

const CARRIER = 101;
const TRAILER = 102; // first non-carrier in input order

/** Expected [holder, spot of carrier, spot of trailer or null] for a successful entry. */
function expectedLanding(method: EntryMethod, lane: EntryLane, side: "left" | "right"):
{ holder: number; carrierSpot: SpotName; trailerSpot: SpotName | null } {
  if (method === "carry") {
    return { holder: CARRIER, carrierSpot: lane === "middle" ? "point_middle" : lane === "left" ? "half_wall_left" : "half_wall_right",
      trailerSpot: null };
  }
  if (method === "dump") {
    return { holder: CARRIER, carrierSpot: lane === "middle" ? "net_front" : lane === "left" ? "goal_line_left" : "goal_line_right",
      trailerSpot: null };
  }
  return {
    holder: TRAILER,
    carrierSpot: lane === "middle" ? (side === "left" ? "circle_top_left" : "circle_top_right")
      : lane === "left" ? "half_wall_left" : "half_wall_right",
    trailerSpot: lane === "middle" ? "point_middle" : lane === "left" ? "point_left" : "point_right",
  };
}

test("zone entry landing table: every method x lane x formation x side lands as documented", () => {
  for (const f of FORMATIONS) {
    for (const side of ["left", "right"] as const) {
      const input = fiveOnFour({ formation: f });
      const base = entryState(input, { formationSide: side });
      for (const method of METHODS) {
        for (const lane of LANES) {
          const s = entryOutcome(input, base, { type: "zone_entry", method, lane, formation: f }, true);
          const want = expectedLanding(method, lane, lane === "middle" ? side : lane);
          const label = `${f}/${side}/${method}/${lane}`;
          assert.equal(s.phase.kind, "decision", label);
          assert.deepEqual(s.carrier, { kind: "pp", id: want.holder }, label);
          const spots = spotsOf(s);
          assert.equal(spots.get(CARRIER), want.carrierSpot, `${label} carrier spot`);
          if (want.trailerSpot !== null) assert.equal(spots.get(TRAILER), want.trailerSpot, `${label} trailer spot`);
          assert.equal(new Set(spots.values()).size, 5, `${label} distinct spots`);
          assert.equal(s.formation, f, label);
          assert.equal(s.formationSide, lane === "middle" ? side : lane, `${label} side`);
        }
      }
    }
  }
});

test("zone entry landing: unpinned skaters take the chosen formation's remaining spots", () => {
  const input = fiveOnFour({ formation: "umbrella" });
  const base = entryState(input);
  const s = entryOutcome(input, base, { type: "zone_entry", method: "carry", lane: "right", formation: "overload" }, true);
  assert.equal(s.formation, "overload");
  assert.equal(s.formationSide, "right");
  const want = new Set(val(formationSpots("overload", 5, "right")));
  const got = new Set(s.ppSpots.map((x) => x.spot));
  assert.deepEqual([...got].sort(), [...want].sort()); // half_wall_right pin sits inside the overload list
});

test("zone entry landing works for 4- and 6-skater power plays", () => {
  for (const [name, build] of Object.entries(FORMATION_FIXTURES)) {
    for (const f of FORMATIONS) {
      const input = build({ formation: f });
      const s0 = val(initRun(input));
      const base = { ...s0, phase: { kind: "zone_entry" } as const, carrier: { kind: "pp", id: s0.ppSpots[0]?.id ?? -1 } as const };
      for (const method of METHODS) {
        const s = entryOutcome(input, base, { type: "zone_entry", method, lane: "left", formation: f }, true);
        assert.equal(s.ppSpots.length, s0.ppSpots.length, `${name}/${f}/${method}`);
        assert.equal(new Set(s.ppSpots.map((x) => x.spot)).size, s.ppSpots.length, `${name}/${f}/${method}`);
      }
    }
  }
});

test("zone entry log: draw:entry and the setup event carry lane, method and formation", () => {
  const input = fiveOnFour();
  const base = entryState(input);
  const s = entryOutcome(input, base, { type: "zone_entry", method: "drop", lane: "right", formation: "spread" }, true);
  const draw = s.log.find((e, i) => i >= base.log.length && e.kind === "draw:entry");
  assert.equal(draw?.detail?.lane, "right");
  assert.equal(draw?.detail?.method, "drop");
  assert.equal(draw?.detail?.formation, "spread");
  const setup = s.log.find((e, i) => i >= base.log.length && e.kind === "setup");
  assert.equal(setup?.detail?.trigger, "entry");
  assert.equal(setup?.detail?.lane, "right");
  assert.equal(setup?.detail?.formation, "spread");
  assert.equal(setup?.detail?.spot, "point_right");
  const call = s.log.find((e, i) => i >= base.log.length && e.kind === "call");
  assert.equal(call?.detail?.lane, "right");
  assert.equal(call?.detail?.formation, "spread");
});

test("zone entry failure: the PK gets the puck but the chosen formation and side are kept", () => {
  const input = fiveOnFour({ formation: "umbrella" });
  const base = entryState(input);
  const s = entryOutcome(input, base, { type: "zone_entry", method: "dump", lane: "left", formation: "overload" }, false);
  assert.equal(s.formation, "overload");
  assert.equal(s.formationSide, "left");
  assert.ok(!s.log.some((e, i) => i >= base.log.length && e.kind === "setup"));
});

test("zone entry: the middle lane keeps the current overload side", () => {
  const input = fiveOnFour({ formation: "overload" });
  const base = entryState(input, { formationSide: "right" });
  const s = entryOutcome(input, base, { type: "zone_entry", method: "carry", lane: "middle" }, true);
  assert.equal(s.formationSide, "right");
  assert.equal(s.formation, "overload");
});

// ---------------------------------------------------------------- faceoffs

/** First PRNG state where the faceoff draw (the first draw of the call) is a win / loss. */
function faceoffOutcome(input: RunInput, base: RunState, call: Call, win: boolean): RunState {
  for (let rng = 1; rng <= SCAN_LIMIT; rng++) {
    const s = val(applyCall({ ...base, rng }, input, call, base.callCount));
    const ev = s.log.find((e, i) => i >= base.log.length && e.kind === "draw:faceoff");
    if (ev !== undefined && ev.detail?.hit === win) return s;
  }
  return assert.fail(`no PRNG state produced faceoff win=${win}`);
}

function ozFaceoff(input: RunInput, dot: "oz_left" | "oz_right"): RunState {
  const s = val(initRun(input));
  // Re-line up on the requested dot through a legal route: the opening dot is random, so patch the phase and side only.
  return { ...s, phase: { kind: "faceoff", dot }, formationSide: dot === "oz_left" ? "left" : "right" };
}

test("faceoff: a win with a formation applies it, keeps the winner's spot and takes the side from the dot", () => {
  const input = fiveOnFour({ formation: "umbrella" });
  for (const dot of ["oz_left", "oz_right"] as const) {
    const base = ozFaceoff(input, dot);
    const call: Call = { type: "faceoff", takerId: 101, target: "half_wall", formation: "overload" };
    const winnerBefore = (() => {
      const w = faceoffOutcome(input, base, { type: "faceoff", takerId: 101, target: "half_wall" }, true);
      return w.carrier.kind === "pp" ? w.carrier.id : -1;
    })();
    const s = faceoffOutcome(input, base, call, true);
    assert.equal(s.formation, "overload");
    assert.equal(s.formationSide, dot === "oz_left" ? "left" : "right");
    assert.deepEqual(s.carrier, { kind: "pp", id: winnerBefore });
    assert.equal(s.phase.kind, "decision");
    assert.equal(new Set(s.ppSpots.map((x) => x.spot)).size, 5);
    const setup = s.log.find((e, i) => i >= base.log.length && e.kind === "setup");
    assert.equal(setup?.detail?.trigger, "faceoff");
    assert.equal(setup?.detail?.formation, "overload");
  }
});

test("faceoff: omitting the formation keeps the current one; a loss never applies it", () => {
  const input = fiveOnFour({ formation: "one_three_one" });
  const base = ozFaceoff(input, "oz_left");
  const keep = faceoffOutcome(input, base, { type: "faceoff", takerId: 101, target: "point" }, true);
  assert.equal(keep.formation, "one_three_one");
  const lost = faceoffOutcome(input, base, { type: "faceoff", takerId: 101, target: "point", formation: "spread" }, false);
  assert.equal(lost.formation, "one_three_one");
});

test("faceoff: the same formation on a win does not re-place or log a setup", () => {
  const input = fiveOnFour({ formation: "spread" });
  const base = ozFaceoff(input, "oz_left");
  const s = faceoffOutcome(input, base, { type: "faceoff", takerId: 101, target: "point", formation: "spread" }, true);
  assert.ok(!s.log.some((e, i) => i >= base.log.length && e.kind === "setup"));
});

// ---------------------------------------------------------------- validation and compatibility

test("validation: unknown lane or formation is an error on entries and faceoffs", () => {
  const input = fiveOnFour();
  const e = entryState(input);
  isErr(applyCall(e, input, { type: "zone_entry", method: "carry", lane: "centre" as EntryLane }, 0), /lane/);
  isErr(applyCall(e, input, { type: "zone_entry", method: "carry", formation: "box" as PpFormationName }, 0), /formation/);
  const f = val(initRun(input));
  isErr(applyCall(f, input, { type: "faceoff", takerId: 101, target: "point", formation: "box" as PpFormationName }, 0), /formation/);
});

test("validation: a run state with a bad formation or side is rejected", () => {
  const input = fiveOnFour();
  const s = entryState(input);
  isErr(legalCalls({ ...s, formation: "box" as PpFormationName }, input), /formation/);
  isErr(legalCalls({ ...s, formationSide: "up" as "left" }, input), /formationSide/);
});

test("compatibility: a saved state without formation fields still plays and gets the defaults", () => {
  const input = fiveOnFourSpread();
  const s = entryState(input);
  const old = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  delete old.formation;
  delete old.formationSide;
  const legacy = old as unknown as RunState;
  const opts = val(legalCalls(legacy, input));
  const first = opts[0]?.call;
  assert.ok(first !== undefined && first.type === "zone_entry" && first.formation === "spread");
  const next = val(applyCall(legacy, input, { type: "zone_entry", method: "carry" }, 0));
  assert.equal(next.formation, "spread");
  assert.ok(next.formationSide === "left" || next.formationSide === "right");
});

test("compatibility: calls without lane / formation replay as middle lane / current formation", () => {
  const input = fiveOnFour({ seed: 77 });
  const calls: Call[] = [];
  let s = val(initRun(input));
  for (let k = 0; k < 6 && s.phase.kind !== "ended"; k++) {
    const opts = val(legalCalls(s, input));
    const o = opts.find((x) => x.call.type === "zone_entry" && x.call.lane === "middle") ?? opts[0];
    if (o === undefined) assert.fail("no options");
    // Strip the new optional fields to mimic an older client.
    const c: Call = o.call.type === "zone_entry" ? { type: "zone_entry", method: o.call.method } : o.call;
    calls.push(c);
    s = val(applyCall(s, input, c, s.callCount));
  }
  assert.deepEqual(val(replay(input, calls)), s);
});

// ---------------------------------------------------------------- determinism

test("determinism: a mixed-formation, all-lane call sequence replays identically and survives JSON", () => {
  const input = fiveOnFourOverload({ seed: 4242 });
  const calls: Call[] = [];
  let s = val(initRun(input));
  let k = 0;
  while (s.phase.kind !== "ended" && k < 60) {
    const opts = val(legalCalls(s, input));
    const o = opts[(k * 7 + 3) % opts.length];
    if (o === undefined) assert.fail("no options");
    let c = o.call;
    if (c.type === "zone_entry" || c.type === "faceoff") c = { ...c, formation: FORMATIONS[k % FORMATIONS.length] ?? "umbrella" };
    calls.push(c);
    s = val(applyCall(s, input, c, s.callCount));
    s = JSON.parse(JSON.stringify(s)) as RunState;
    k++;
  }
  assert.deepEqual(val(replay(input, calls)), s);
  assert.ok(calls.some((c) => c.type === "zone_entry"));
});
