/**
 * Step 2 gate: 10,000-run fuzz, determinism and probability calibration for sim.ts.
 * Run from repo root: node --test packages/engine/src/fuzz.test.ts. SYNTHETIC data only (sim-fixtures.ts).
 *
 * Single-threaded test module; all state is local to each test. Every random choice (fixture
 * seed, policy) comes from modes.ts PRNGs seeded from the run index, so a failure reproduces from
 * the reported index alone.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { absS, periodLengthS, ppActive, strengthOf } from "./clock.ts";
import { MAX_ACTIVE_PENALTIES_PER_SIDE, MAX_CALLS_PER_RUN } from "./constants.ts";
import { pkPositions, spotPos } from "./formation.ts";
import { fnv1a, mulberry32, prngNext } from "./modes.ts";
import type { Result } from "./result.ts";
import { ALL_FIXTURES, fiveOnFour, type FixtureOpts } from "./sim-fixtures.ts";
import type { Call, CallOption, EndReason, PpFormationName, RunInput, RunState } from "./sim-types.ts";
import { applyCall, initRun, legalCalls, replay } from "./sim.ts";

const FUZZ_RUNS = 10_000;
/** Every DETERMINISM_EVERY-th fuzz run is also checked for replay / rerun / JSON round trip (200 runs). */
const DETERMINISM_EVERY = 50;
const MAX_REPORTED_FAILURES = 5;
/** Policy stream is decorrelated from the sim stream by xor with this constant (golden-ratio bits). */
const POLICY_SEED_XOR = 0x9e3779b9;
const CALIBRATION_DRAWS = 20_000;
const CALIBRATION_SIGMAS = 4;
const CALIBRATION_SEED = 0xc0ffee;
const END_REASONS: readonly EndReason[] = ["pp_expired", "sh_goal", "cleared_out", "game_end"];

const FORMATIONS: readonly PpFormationName[] = ["umbrella", "one_three_one", "overload", "spread"];
/** Chance the policy swaps the formation on an entry or faceoff call (any valid formation is legal). */
const FORMATION_SWAP_P = 0.4;

const FIXTURE_NAMES = Object.keys(ALL_FIXTURES).sort();

function val<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(`expected ok, got error: ${r.error}`);
  return r.value;
}

/** Thrown (and caught per run) when an invariant or a Result fails; carries a readable message. */
class FuzzFailure extends Error {}
function check(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new FuzzFailure(msg);
}
function must<T>(r: Result<T>, what: string): T {
  if (!r.ok) throw new FuzzFailure(`${what} returned err: ${r.error}`);
  return r.value;
}

interface RunSpec { index: number; fixture: string; input: RunInput }

/** Deterministic run spec for fuzz index i. O(1) plus fixture build. */
function specFor(i: number): RunSpec {
  const fixture = FIXTURE_NAMES[i % FIXTURE_NAMES.length];
  if (fixture === undefined) throw new Error("no fixtures");
  const build = ALL_FIXTURES[fixture];
  if (build === undefined) throw new Error(`missing fixture ${fixture}`);
  const opts: FixtureOpts = {
    seed: fnv1a(`fuzz-${i}`),
    askEveryTouch: (i >> 3) % 2 === 1,
    formation: FORMATIONS[i % FORMATIONS.length],
  };
  return { index: i, fixture, input: build(opts) };
}

/** Invariants on the options offered at a pause. O(C). */
function checkOptions(opts: CallOption[]): void {
  check(opts.length > 0, "no legal calls at a non-ended pause");
  for (const o of opts) {
    check(Number.isFinite(o.p) && o.p >= 0 && o.p <= 1, `option ${JSON.stringify(o.call)} has p ${o.p}`);
    check(Number.isInteger(o.durationS) && o.durationS >= 1, `option ${JSON.stringify(o.call)} has duration ${o.durationS}`);
    for (const [k, v] of Object.entries(o.breakdown)) check(Number.isFinite(v), `breakdown ${k} = ${v} not finite`);
  }
}

/**
 * Invariants on a state after a call (or after initRun). `prev` is the state before the call.
 * Penalty semantics (from sim.ts timed()/atBoundary()): at a pause, penalties have been expired
 * INCLUSIVELY at the current second, so every active one expires strictly after now. A run that
 * ends inside an event's resolution (PP goal in OT, SH goal) has only had the EXCLUSIVE expiry
 * applied, so a penalty may expire exactly at now; hence >= now when ended. O(K + L) for L new log events.
 */
function checkState(s: RunState, prev: RunState | null, input: RunInput, callsApplied: number): number {
  const now = must(absS(s.clock, input.gameType), "absS");
  const len = must(periodLengthS(s.clock.period, input.gameType), "periodLengthS");
  check(s.clock.elapsedS >= 0 && s.clock.elapsedS <= len, `elapsedS ${s.clock.elapsedS} outside [0, ${len}]`);
  const ended = s.phase.kind === "ended";
  if (prev !== null) {
    const before = must(absS(prev.clock, input.gameType), "absS(prev)");
    check(now >= before, `absolute time went back ${before} -> ${now}`);
    check(s.score.pp >= prev.score.pp && s.score.pk >= prev.score.pk,
      `score decreased ${JSON.stringify(prev.score)} -> ${JSON.stringify(s.score)}`);
  }
  check(Number.isInteger(s.rng) && s.rng >= 0 && s.rng <= 0xffffffff, `rng ${s.rng} not uint32`);
  check(s.callCount === callsApplied, `callCount ${s.callCount} != calls applied ${callsApplied}`);
  const active = { pp: 0, pk: 0 };
  for (const p of s.penalties) {
    if (p.expiresAtS === null) continue;
    active[p.side]++;
    check(ended ? p.expiresAtS >= now : p.expiresAtS > now,
      `penalty ${p.id} expires at ${p.expiresAtS}, now ${now}, phase ${s.phase.kind}`);
  }
  check(active.pp <= MAX_ACTIVE_PENALTIES_PER_SIDE && active.pk <= MAX_ACTIVE_PENALTIES_PER_SIDE,
    `too many active penalties ${JSON.stringify(active)}`);
  check(ended || ppActive(s.penalties), `power play not active in phase ${s.phase.kind}`);
  if (!ended) {
    const st = must(strengthOf(s.penalties, s.goaliePulled, s.clock.period, input.gameType), "strengthOf");
    check(s.ppSpots.length === st.pp, `${s.ppSpots.length} PP skaters on ice, strength says ${st.pp}`);
    check(s.pkPos.length === st.pk, `${s.pkPos.length} PK positions, strength says ${st.pk}`);
    check(new Set(s.ppSpots.map((x) => x.spot)).size === s.ppSpots.length, "two PP skaters share a spot");
    check(FORMATIONS.includes(s.formation) && (s.formationSide === "left" || s.formationSide === "right"),
      `bad formation state ${s.formation}/${s.formationSide}`);
  }
  let lastAt = prev === null ? -1 : (prev.log.at(-1)?.atS ?? -1);
  const from = prev === null ? 0 : prev.log.length;
  check(s.log.length >= from, "log shrank");
  for (let k = 0; k < s.log.length; k++) {
    const e = s.log[k];
    check(e !== undefined && e.i === k, `log index ${e?.i} at position ${k}`);
    if (k >= from) {
      check(e.atS >= lastAt, `log time went back at event ${k}`);
      lastAt = e.atS;
    }
  }
  return now;
}

interface RunResult { state: RunState; calls: Call[] }

/** One fuzz run driven call by call with a uniformly random legal option. O(N x applyCall), N <= MAX_CALLS_PER_RUN. */
function fuzzRun(spec: RunSpec): RunResult {
  const { input } = spec;
  const pick = mulberry32((input.seed ^ POLICY_SEED_XOR) >>> 0);
  let s = must(initRun(input), "initRun");
  checkState(s, null, input, 0);
  const calls: Call[] = [];
  while (s.phase.kind !== "ended") {
    check(calls.length < MAX_CALLS_PER_RUN, `run did not end within MAX_CALLS_PER_RUN (${MAX_CALLS_PER_RUN})`);
    const opts = must(legalCalls(s, input), "legalCalls");
    checkOptions(opts);
    const chosen = opts[Math.floor(pick() * opts.length)];
    check(chosen !== undefined, "policy picked out of range");
    // Entry options already span all 9 method x lane pairs; sometimes swap the formation too.
    let call = chosen.call;
    if ((call.type === "zone_entry" || call.type === "faceoff") && pick() < FORMATION_SWAP_P) {
      const f = FORMATIONS[Math.floor(pick() * FORMATIONS.length)];
      check(f !== undefined, "formation pick out of range");
      call = { ...call, formation: f };
    }
    const next = must(applyCall(s, input, call, s.callCount), `applyCall ${JSON.stringify(call)}`);
    calls.push(call);
    const callEvent = next.log[s.log.length];
    check(callEvent !== undefined && callEvent.kind === "call" && callEvent.p === chosen.p,
      "logged call probability differs from the option shown");
    checkState(next, s, input, calls.length);
    s = next;
  }
  return { state: s, calls };
}

/** Same-seed rerun, replay(input, calls) and a JSON round trip mid-run all reproduce the run. O(N x applyCall). */
function checkDeterminism(spec: RunSpec, run: RunResult): void {
  const again = fuzzRun(specFor(spec.index));
  assert.deepStrictEqual(again.calls, run.calls, `run ${spec.index}: rerun chose different calls`);
  assert.deepStrictEqual(again.state, run.state, `run ${spec.index}: rerun reached a different state`);
  const rep = val(replay(spec.input, run.calls));
  assert.deepStrictEqual(rep, run.state, `run ${spec.index}: replay differs from step-by-step state`);
  const mid = Math.floor(run.calls.length / 2);
  let s = val(replay(spec.input, run.calls.slice(0, mid)));
  s = JSON.parse(JSON.stringify(s)) as RunState;
  for (let k = mid; k < run.calls.length; k++) {
    const c = run.calls[k];
    if (c === undefined) assert.fail("missing call");
    s = val(applyCall(s, spec.input, c, k));
  }
  assert.deepStrictEqual(s, run.state, `run ${spec.index}: JSON round trip at call ${mid} diverged`);
}

test(`fuzz: ${FUZZ_RUNS} random runs, zero errors, invariants after every call; determinism on every ${DETERMINISM_EVERY}th`, () => {
  const failures: string[] = [];
  let failureCount = 0;
  const reasons = new Map<string, number>(END_REASONS.map((r) => [r, 0]));
  const details = new Map<string, number>();
  const byFixture = new Map<string, number>();
  let ppGoals = 0, totalCalls = 0, maxCalls = 0, determinismChecked = 0;
  for (let i = 0; i < FUZZ_RUNS; i++) {
    const spec = specFor(i);
    try {
      const run = fuzzRun(spec);
      const ph = run.state.phase;
      if (ph.kind !== "ended") throw new FuzzFailure("run loop exited without an ended phase");
      reasons.set(ph.reason, (reasons.get(ph.reason) ?? 0) + 1);
      const key = `${ph.reason}/${ph.detail ?? "none"}`;
      details.set(key, (details.get(key) ?? 0) + 1);
      const fk = `${spec.fixture}:${ph.reason}`;
      byFixture.set(fk, (byFixture.get(fk) ?? 0) + 1);
      ppGoals += run.state.score.pp - spec.input.score.pp;
      totalCalls += run.calls.length;
      maxCalls = Math.max(maxCalls, run.calls.length);
      if (i % DETERMINISM_EVERY === 0) {
        checkDeterminism(spec, run);
        determinismChecked++;
      }
    } catch (e) {
      failureCount++;
      if (failures.length < MAX_REPORTED_FAILURES) {
        const msg = e instanceof Error ? e.message : String(e);
        failures.push(`run ${i} (${spec.fixture}, seed ${spec.input.seed}, ask ${spec.input.settings.askEveryTouch}, `
          + `${spec.input.settings.formation}): ${msg}`);
      }
    }
  }
  console.log("fuzz end reasons:", Object.fromEntries(reasons));
  console.log("fuzz end details:", Object.fromEntries([...details].sort()));
  console.log("fuzz end reasons by fixture:", Object.fromEntries([...byFixture].sort()));
  console.log(`fuzz PP goals per run: ${(ppGoals / FUZZ_RUNS).toFixed(4)}; calls per run: mean `
    + `${(totalCalls / FUZZ_RUNS).toFixed(2)}, max ${maxCalls}; determinism checked on ${determinismChecked} runs`);
  assert.equal(failureCount, 0, `${failureCount} failing runs; first ${failures.length}:\n${failures.join("\n")}`);
  assert.equal(determinismChecked, FUZZ_RUNS / DETERMINISM_EVERY);
  for (const r of END_REASONS) assert.ok((reasons.get(r) ?? 0) > 0, `end reason ${r} never reached in ${FUZZ_RUNS} runs`);
});

/** A fiveOnFour state paused at a decision, puck with the first skater on its formation spot. */
function calibrationState(input: RunInput): RunState {
  const s = val(initRun(input));
  const holder = s.ppSpots[0];
  if (holder === undefined) assert.fail("no PP skaters");
  const puck = spotPos(holder.spot);
  const st = val(strengthOf(s.penalties, s.goaliePulled, s.clock.period, input.gameType));
  return { ...s, phase: { kind: "decision" }, carrier: { kind: "pp", id: holder.id }, puck,
    pkPos: val(pkPositions(puck, st.pk)) };
}

/**
 * Applies `call` from CALIBRATION_DRAWS rng states and returns the hit rate of the first draw
 * named `drawKind`. O(CALIBRATION_DRAWS x applyCall).
 */
function firstDrawRate(input: RunInput, base: RunState, call: Call, drawKind: string): number {
  let r = CALIBRATION_SEED;
  let hits = 0;
  for (let k = 0; k < CALIBRATION_DRAWS; k++) {
    const [u, next] = prngNext(r);
    r = next;
    const s = val(applyCall({ ...base, rng: u }, input, call, base.callCount));
    const ev = s.log.slice(base.log.length).find((e) => e.kind.startsWith("draw:"));
    if (ev === undefined) assert.fail(`no draw after ${JSON.stringify(call)}`);
    assert.equal(ev.kind, drawKind, `first draw after ${call.type} is ${ev.kind}`);
    if (ev.detail?.hit === true) hits++;
  }
  return hits / CALIBRATION_DRAWS;
}

function assertWithinSigma(observed: number, p: number, label: string): void {
  const sigma = Math.sqrt((p * (1 - p)) / CALIBRATION_DRAWS);
  const z = sigma === 0 ? (observed === p ? 0 : Infinity) : Math.abs(observed - p) / sigma;
  console.log(`calibration ${label}: shown ${p.toFixed(4)}, observed ${observed.toFixed(4)}, |z| = ${z.toFixed(2)}`);
  assert.ok(z <= CALIBRATION_SIGMAS, `${label}: observed ${observed} vs shown ${p} is ${z.toFixed(2)} sigma off`);
}

test(`calibration: first-draw frequency matches the displayed odds within ${CALIBRATION_SIGMAS} sigma (${CALIBRATION_DRAWS} draws)`, () => {
  const input = fiveOnFour();
  const base = calibrationState(input);
  const opts = val(legalCalls(base, input));
  const pass = opts.find((o) => o.call.type === "pass" && o.p > 0.05 && o.p < 0.95 && !o.cutByClock)
    ?? opts.find((o) => o.call.type === "pass" && !o.cutByClock);
  const shot = opts.find((o) => o.call.type === "shoot" && (o.breakdown.pBlocked ?? 0) > 0.05 && !o.cutByClock)
    ?? opts.find((o) => o.call.type === "shoot" && !o.cutByClock);
  if (pass === undefined || shot === undefined) assert.fail("fixture offers no pass or shot option");
  assertWithinSigma(firstDrawRate(input, base, pass.call, "draw:pass"), pass.p, `pass ${JSON.stringify(pass.call)}`);
  const pBlocked = shot.breakdown.pBlocked;
  if (pBlocked === undefined) assert.fail("shot breakdown has no pBlocked");
  assertWithinSigma(firstDrawRate(input, base, shot.call, "draw:block"), pBlocked, `shot block ${JSON.stringify(shot.call)}`);
});
