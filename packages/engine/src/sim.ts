/**
 * Discrete-event power-play run simulation (API contract in sim-types.ts).
 *
 * Stateless module: no module-level mutable state; every exported function takes plain JSON data
 * (RunInput, RunState) and returns a NEW RunState inside a Result; arguments are never mutated.
 * Safe in Web Workers and on the server. All randomness comes from RunState.rng via
 * modes.prngNext and is compared as integers (see draw()). The PRNG is integer-exact; the
 * probabilities use Math.exp/Math.log, which engines approximate, so quantisation makes a
 * cross-engine draw flip very unlikely but not impossible: the server replay of (input, calls) is
 * authoritative for official scores. No dates, no Math.random, no ambient clock.
 *
 * Shape of a run: the player's call is resolved as one timed step; the sim then auto-plays timed
 * steps (loose pucks, PK possessions, regroups, auto breakouts, set-ups) until it reaches a pause
 * phase (faceoff / decision / zone_entry / breakout when settings.askEveryTouch) or the run ends.
 *
 * Clock protocol for a step starting at absolute t0 with duration d (integer >= 1):
 *   E = clock.nextBoundaryS. If t0 + d > E the step is cut: clock -> E, nothing is drawn, then the
 *   boundary (PP end or period end) is handled. Otherwise the event resolves at t1 = t0 + d with
 *   penalties expired exclusively first (a penalty expiring exactly at t1 is still on) and
 *   inclusively after.
 *
 * Roster rule: input.pp.skaters may include bench skaters (see RunInput.pp). The first
 * starting-strength skaters in input order start on the ice. When PP strength drops (goalie back in, regular-season OT) the non-carrier skaters latest in input
 * order leave; when it rises, the earliest absent skaters join on free formation spots. PK skater
 * identities only matter for faceoffs, which use the best PK taker in input.pk.skaters.
 */
import {
  absS, clockAt, endPeriod, expireUpTo, maxPpStrength, nextBoundaryS, periodLengthS, ppActive, ppEndS, releaseOnGoal,
  strengthOf,
} from "./clock.ts";
import {
  BASE_SKATERS, BREAKOUT, CLEAR_REENTRY_MIN_S, ENTRY, FACEOFF, FACEOFF_DOTS, MAX_AUTO_STEPS_PER_CALL, MAX_CALLS_PER_RUN,
  NET, OPENING_FACEOFF_LEFT_P, OZ_BOUNDS, OZ_SPOTS, PK, PP_FORMATIONS, PROB_QUANTUM, RECOVERY,
  REGULATION_PERIODS, SET_PLAYS, SET_PLAY_MAX_SPOT_DIST_FT, SHOT_OPTIONS, SKATE_SPEED_FPS, TIME,
  type SetPlayId, type ShotOption, type SpotName,
} from "./constants.ts";
import { isSkaterCount, moveCarrierTo, nearestPp, pkPositions, placePp, spotPos, type PpSpot } from "./formation.ts";
import {
  baseRate, dist, distanceBucket, passLikelihood, shotLikelihood, skateLikelihood, validPos, zoneFor,
  type Corner, type Defender, type ShotLikelihood, type Skater, type Vec2,
} from "./likelihood.ts";
import { prngNext } from "./modes.ts";
import { err, ok, type Result } from "./result.ts";
import type {
  BreakoutMethod, Call, CallOption, EndDetail, EndReason, EntryMethod, FaceoffDot, FaceoffTarget, GameType,
  RunEvent, RunInput, RunState,
} from "./sim-types.ts";

/** Chooses a call from the options offered; used by autoPlay (bots, fuzzers, grader rollouts). */
export type Policy = (options: CallOption[], state: RunState) => Call;

const UINT32_RANGE = 2 ** 32;        // maps a uint32 draw to [0, 1)
const MAX_UINT32 = UINT32_RANGE - 1;
const MIN_STEP_S = 1;                // every simulated event takes at least one whole second
const STATE_VERSION = 1;
const CORNERS: readonly Corner[] = ["top_left", "top_right", "bottom_left", "bottom_right", "five_hole"];
const FACEOFF_TARGETS: readonly FaceoffTarget[] = ["point", "half_wall", "back"];
const ENTRY_METHODS: readonly EntryMethod[] = ["carry", "drop", "dump"];
const BREAKOUT_METHODS: readonly BreakoutMethod[] = ["carry", "pass", "rim"];
const FORMATION_NAMES: readonly string[] = Object.keys(PP_FORMATIONS);

const isSpot = (s: unknown): s is SpotName => typeof s === "string" && Object.hasOwn(OZ_SPOTS, s);
const isShotOption = (s: unknown): s is ShotOption => typeof s === "string" && Object.hasOwn(SHOT_OPTIONS, s);
const isSetPlay = (s: unknown): s is SetPlayId => typeof s === "string" && Object.hasOwn(SET_PLAYS, s);
const isCorner = (s: unknown): s is Corner => CORNERS.some((c) => c === s);
const isTarget = (s: unknown): s is FaceoffTarget => FACEOFF_TARGETS.some((c) => c === s);
const isEntry = (s: unknown): s is EntryMethod => ENTRY_METHODS.some((c) => c === s);
const isBreakout = (s: unknown): s is BreakoutMethod => BREAKOUT_METHODS.some((c) => c === s);
const isProb = (p: number): boolean => Number.isFinite(p) && p >= 0 && p <= 1;
const posMult = (m: number): boolean => Number.isFinite(m) && m > 0;
const sigmoid = (z: number): number => 1 / (1 + Math.exp(-z));
const logit = (p: number): number => Math.log(p / (1 - p));
const midpoint = (a: Vec2, b: Vec2): Vec2 => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
const copyVec = (v: Vec2): Vec2 => ({ x: v.x, y: v.y });

// ============================================================================ validation
// Inputs and states may come from the network (server replay, a resumed run), so every check is
// structural first: malformed data returns err and never throws.

const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x);
const isVec = (x: unknown): x is Vec2 => isObj(x) && validPos({ x: Number(x.x), y: Number(x.y) })
  && typeof x.x === "number" && typeof x.y === "number";
const isNonNegInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
const isUint32 = (x: unknown): x is number => isNonNegInt(x) && x <= MAX_UINT32;
const PHASE_KINDS: readonly string[] = ["faceoff", "decision", "zone_entry", "breakout", "ended"];
const END_REASONS: readonly string[] = ["pp_expired", "sh_goal", "cleared_out", "game_end"];
const END_DETAILS: readonly (string | null)[] = ["ot_goal", "shootout", "regulation_end", "empty_net", null];

/** Problem with one penalty record, or null. `now` (when given) rejects already-expired penalties. O(1). */
function penaltyProblem(p: unknown, now: number | null): string | null {
  if (!isObj(p)) return "penalty must be an object";
  if (!Number.isInteger(p.id)) return `invalid penalty id ${String(p.id)}`;
  if (p.side !== "pp" && p.side !== "pk") return `invalid penalty side ${String(p.side)}`;
  if (p.kind !== "minor" && p.kind !== "double_minor" && p.kind !== "major") return `invalid penalty kind ${String(p.kind)}`;
  if (!Number.isInteger(p.durationS) || (p.durationS as number) <= 0) return `invalid penalty duration ${String(p.durationS)}`;
  if (p.expiresAtS !== null && !isNonNegInt(p.expiresAtS)) return `invalid penalty expiry ${String(p.expiresAtS)}`;
  if (now !== null && p.expiresAtS !== null && (p.expiresAtS as number) < now) {
    return `penalty ${String(p.id)} expiry ${String(p.expiresAtS)} is before the start (${now})`;
  }
  return null;
}

/** Penalty list: an array of well-formed penalties with unique ids. O(K). */
function penaltiesProblem(ps: unknown, now: number | null): string | null {
  if (!Array.isArray(ps)) return "penalties must be an array";
  const ids = new Set<unknown>();
  for (const p of ps) {
    const e = penaltyProblem(p, now);
    if (e !== null) return e;
    if (ids.has((p as { id: unknown }).id)) return `duplicate penalty id ${String((p as { id: unknown }).id)}`;
    ids.add((p as { id: unknown }).id);
  }
  return null;
}

const isClock = (c: unknown): boolean => isObj(c) && Number.isInteger(c.period) && Number.isInteger(c.elapsedS);
const isScore = (c: unknown): boolean => isObj(c) && isNonNegInt(c.pp) && isNonNegInt(c.pk);

/**
 * Checks everything about the input that must hold for the whole run (rosters, ratings, rates,
 * settings, seed, game type). O(S + R) for S skaters and R rate rows.
 */
function validateStatic(input: RunInput): Result<GameType> {
  if (!isObj(input)) return err("input must be an object");
  const gt = input.gameType;
  if (gt !== 2 && gt !== 3) return err(`gameType must be 2 or 3, got ${String(gt)}`);
  if (!isUint32(input.seed)) return err(`seed must be a uint32 integer, got ${String(input.seed)}`);
  if (typeof input.scenarioId !== "string") return err("scenarioId must be a string");
  const st: unknown = input.settings;
  if (!isObj(st) || typeof st.askEveryTouch !== "boolean") return err("invalid settings");
  if (typeof st.formation !== "string" || !FORMATION_NAMES.includes(st.formation)) {
    return err(`unknown formation ${String(st.formation)}`);
  }
  const pp: unknown = input.pp, pk: unknown = input.pk;
  if (!isObj(pp) || !Array.isArray(pp.skaters) || !isObj(pk) || !Array.isArray(pk.skaters)) return err("missing rosters");
  const ids = new Set<number>();
  const claim = (id: unknown): string | null => {
    if (!Number.isInteger(id)) return `invalid id ${String(id)}`;
    if (ids.has(id as number)) return `duplicate id ${String(id)}`;
    ids.add(id as number);
    return null;
  };
  for (const s of pp.skaters as unknown[]) {
    if (!isObj(s)) return err("PP skater must be an object");
    const e = claim(s.id);
    if (e !== null) return err(e);
    const name = String(s.name);
    if (!isVec(s.pos)) return err(`non-finite position for ${name}`);
    if (!posMult(Number(s.playmakingMult)) || !posMult(Number(s.finishingMult)) || !posMult(Number(s.puckControlMult))
      || typeof s.playmakingMult !== "number" || typeof s.finishingMult !== "number" || typeof s.puckControlMult !== "number") {
      return err(`invalid multiplier for ${name}`);
    }
    if (typeof s.accuracy !== "number" || !(s.accuracy > 0 && s.accuracy <= 1)) return err(`invalid accuracy for ${name}`);
    if (typeof s.shootsLeft !== "boolean") return err(`invalid shootsLeft for ${name}`);
    if (typeof s.faceoffWinRate !== "number" || !(s.faceoffWinRate > 0 && s.faceoffWinRate < 1)) {
      return err(`faceoffWinRate must be in (0,1) for ${name}`);
    }
  }
  for (const s of pk.skaters as unknown[]) {
    if (!isObj(s)) return err("PK skater must be an object");
    const e = claim(s.id);
    if (e !== null) return err(e);
    if (typeof s.faceoffWinRate !== "number" || !(s.faceoffWinRate > 0 && s.faceoffWinRate < 1)) {
      return err(`faceoffWinRate must be in (0,1) for ${String(s.name)}`);
    }
  }
  if (pk.skaters.length === 0) return err("no PK skaters");
  const g: unknown = pk.goalie;
  if (!isObj(g)) return err("missing goalie");
  const ge = claim(g.id);
  if (ge !== null) return err(ge);
  if (typeof g.gaMult !== "number" || !posMult(g.gaMult)) return err(`invalid gaMult for ${String(g.name)}`);
  if (typeof g.catchesLeft !== "boolean") return err(`invalid catchesLeft for ${String(g.name)}`);
  if (!Array.isArray(input.rates)) return err("rates must be an array");
  for (const r of input.rates as unknown[]) {
    if (!isObj(r) || typeof r.shot_type !== "string" || typeof r.attempts !== "number" || !Number.isFinite(r.attempts)
      || r.attempts < 0 || typeof r.p_unblocked !== "number" || !isProb(r.p_unblocked) || !Number.isInteger(r.dist_bucket)) {
      return err(`invalid base-rate row ${JSON.stringify(r)}`);
    }
  }
  return ok(gt);
}

/**
 * Every shot option needs base-rate data at every distance bucket a shot can come from (shots are
 * only taken from OZ_SPOTS). O(O x B x R) for O options, B buckets, R rows.
 */
function validateRateCoverage(input: RunInput): Result<void> {
  const buckets = new Set<number>();
  for (const sp of Object.keys(OZ_SPOTS).filter(isSpot)) {
    const b = distanceBucket(dist(spotPos(sp), NET));
    if (!b.ok) return b;
    buckets.add(b.value);
  }
  for (const opt of Object.keys(SHOT_OPTIONS).filter(isShotOption)) {
    for (const b of [...buckets].sort((x, y) => x - y)) {
      const r = baseRate(input.rates, opt, b);
      if (!r.ok) return err(`base-rate coverage: ${opt} has no data for distance bucket ${b} (${r.error})`);
    }
  }
  return ok(undefined);
}

/**
 * The starting situation: clock, score, penalties, power play and rosters. PP roster rule: at
 * least the highest PP strength the penalty timeline can reach (clock.maxPpStrength) and at most
 * BASE_SKATERS (+1 while the goalie is pulled; a pulled goalie never comes back out mid-run).
 * Returns the start second and the starting PP strength. O(K^2 + S + O x B x R).
 */
function validateStart(input: RunInput, gt: GameType): Result<{ now: number; ppOnIce: number }> {
  if (!isClock(input.clock)) return err("invalid clock");
  const now = absS(input.clock, gt);
  if (!now.ok) return now;
  if (!isScore(input.score)) return err("invalid score");
  if (typeof input.goaliePulled !== "boolean") return err("goaliePulled must be a boolean");
  const pe = penaltiesProblem(input.penalties, now.value);
  if (pe !== null) return err(pe);
  if (!ppActive(input.penalties)) return err("no power play: the PK side must have more active penalties");
  const st = strengthOf(input.penalties, input.goaliePulled, input.clock.period, gt);
  if (!st.ok) return st;
  const maxPp = BASE_SKATERS + (input.goaliePulled ? 1 : 0);
  const need = maxPpStrength(input.penalties, input.goaliePulled, input.clock, gt);
  if (!need.ok) return need;
  const nPp = input.pp.skaters.length;
  if (nPp < need.value) {
    return err(`the penalty timeline reaches ${need.value} PP skaters on the ice; the roster lists only ${nPp} PP skaters`);
  }
  if (nPp > maxPp) return err(`at most ${maxPp} PP skaters (on ice plus bench) can be used, got ${nPp}`);
  if (input.pk.skaters.length !== st.value.pk) {
    return err(`expected ${st.value.pk} PK skaters for this strength, got ${input.pk.skaters.length}`);
  }
  const cov = validateRateCoverage(input);
  if (!cov.ok) return cov;
  return ok({ now: now.value, ppOnIce: st.value.pp });
}

/** Structural check of a RunState that may have come back from JSON. O(K + S + D). */
function validateState(s: unknown): Result<RunState> {
  if (!isObj(s) || s.v !== STATE_VERSION) return err("invalid run state");
  if (!isUint32(s.rng)) return err("invalid run state: rng");
  if (!isNonNegInt(s.callCount) || !isNonNegInt(s.step)) return err("invalid run state: counters");
  if (!isClock(s.clock)) return err("invalid run state: clock");
  const pe = penaltiesProblem(s.penalties, null);
  if (pe !== null) return err(`invalid run state: ${pe}`);
  if (!isScore(s.score)) return err("invalid run state: score");
  if (typeof s.goaliePulled !== "boolean" || typeof s.justScored !== "boolean") return err("invalid run state: flags");
  const ph = s.phase;
  if (!isObj(ph) || typeof ph.kind !== "string" || !PHASE_KINDS.includes(ph.kind)) return err("invalid run state: phase");
  if (ph.kind === "faceoff" && !(typeof ph.dot === "string" && Object.hasOwn(FACEOFF_DOTS, ph.dot))) {
    return err("invalid run state: faceoff dot");
  }
  if (ph.kind === "ended" && (typeof ph.reason !== "string" || !END_REASONS.includes(ph.reason)
    || !END_DETAILS.some((d) => d === ph.detail))) return err("invalid run state: end");
  if (!isVec(s.puck)) return err("invalid run state: puck");
  const c = s.carrier;
  if (!isObj(c) || !((c.kind === "pp" && Number.isInteger(c.id)) || c.kind === "pk" || c.kind === "loose")) {
    return err("invalid run state: carrier");
  }
  if (!Array.isArray(s.ppSpots) || !s.ppSpots.every((x: unknown) => isObj(x) && Number.isInteger(x.id) && isSpot(x.spot))) {
    return err("invalid run state: ppSpots");
  }
  if (!Array.isArray(s.pkPos) || !s.pkPos.every(isVec)) return err("invalid run state: pkPos");
  if (!Array.isArray(s.log)) return err("invalid run state: log");
  return ok(s as unknown as RunState);
}

// ============================================================================ working state

/** Mutable working copy for one exported call. Never escapes except as the returned RunState. */
interface Sim {
  input: RunInput;
  gt: GameType;
  s: RunState;
  abs: number;           // absolute second of s.clock
  ci: number | null;     // callIndex attributed to logged events (null = auto-played)
}

/** Copy of a RunState deep enough that mutating the copy never touches the original. O(size). */
function cloneState(s: RunState): RunState {
  return {
    ...s,
    clock: { ...s.clock },
    penalties: s.penalties.map((p) => ({ ...p })),
    score: { ...s.score },
    phase: { ...s.phase },
    puck: copyVec(s.puck),
    carrier: { ...s.carrier },
    ppSpots: s.ppSpots.map((p) => ({ ...p })),
    pkPos: s.pkPos.map(copyVec),
    log: [...s.log], // events are never mutated after they are pushed
  };
}

/** O(1). */
function log(m: Sim, kind: string, extra: Pick<RunEvent, "p" | "u" | "detail"> = {}): void {
  m.s.log.push({ i: m.s.log.length, callIndex: m.ci, atS: m.abs, clock: { ...m.s.clock }, kind, ...extra });
}

/** O(1). One uint32 draw scaled to [0, PROB_QUANTUM). */
function nextQuantum(m: Sim): { q: number; u: number } {
  const [u32, next] = prngNext(m.s.rng);
  m.s.rng = next;
  return { q: Math.floor((u32 * PROB_QUANTUM) / UINT32_RANGE), u: u32 / UINT32_RANGE };
}

/** O(1). Bernoulli(p) compared as integers; logged with p and u. */
function draw(m: Sim, name: string, p: number, detail: Record<string, string | number | boolean> = {}): boolean {
  const { q, u } = nextQuantum(m);
  const hit = q < Math.round(p * PROB_QUANTUM);
  log(m, `draw:${name}`, { p, u, detail: { ...detail, hit } });
  return hit;
}

/** O(C). One draw partitioned by cumulative cut points; returns the outcome index 0..C. Logs p = first cut. */
function drawSplit(m: Sim, name: string, cuts: readonly number[], detail: Record<string, string | number> = {}): number {
  const { q, u } = nextQuantum(m);
  let outcome = cuts.length;
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i];
    if (c !== undefined && q < Math.round(c * PROB_QUANTUM)) { outcome = i; break; }
  }
  const named: Record<string, number> = {};
  cuts.forEach((c, i) => { named[`cut${i}`] = c; });
  log(m, `draw:${name}`, { p: cuts[0] ?? 0, u, detail: { ...detail, ...named, outcome } });
  return outcome;
}

/** O(period). */
function setAbs(m: Sim, abs: number): Result<void> {
  const c = clockAt(abs, m.gt);
  if (!c.ok) return c;
  m.s.clock = c.value;
  m.abs = abs;
  return ok(undefined);
}

/** O(1). */
function end(m: Sim, reason: EndReason, detail: EndDetail): void {
  m.s.phase = { kind: "ended", reason, detail };
  log(m, "end", { detail: { reason, detail: detail ?? "none" } });
}

/** O(S). Index of a PP skater in input order, or -1. */
const inputIndex = (input: RunInput, id: number): number => input.pp.skaters.findIndex((s) => s.id === id);

/** O(S). On-ice ids in input order. */
function rosterIds(m: Sim): number[] {
  const on = new Set(m.s.ppSpots.map((x) => x.id));
  return m.input.pp.skaters.filter((s) => on.has(s.id)).map((s) => s.id);
}

/** O(S). First on-ice PP skater in input order: the default puck carrier off a regroup or a centre draw. */
function quarterback(m: Sim): Result<number> {
  const id = rosterIds(m)[0];
  return id === undefined ? err("no PP skaters on ice") : ok(id);
}

/**
 * Make the on-ice PP roster match the current strength (see the roster rule in the header).
 * O(S^2) for S <= 6 skaters.
 */
function syncRoster(m: Sim): Result<void> {
  const st = strengthOf(m.s.penalties, m.s.goaliePulled, m.s.clock.period, m.gt);
  if (!st.ok) return st;
  const n = st.value.pp;
  const cur = m.s.ppSpots;
  if (cur.length === n) return ok(undefined);
  if (!isSkaterCount(n)) return err(`no PP formation for ${n} skaters`);
  if (n > m.input.pp.skaters.length) return err(`strength needs ${n} PP skaters, input has ${m.input.pp.skaters.length}`);
  const carrierId = m.s.carrier.kind === "pp" ? m.s.carrier.id : null;
  if (n < cur.length) {
    const leaving = new Set(cur.filter((x) => x.id !== carrierId)
      .sort((a, b) => inputIndex(m.input, b.id) - inputIndex(m.input, a.id))
      .slice(0, cur.length - n).map((x) => x.id));
    m.s.ppSpots = cur.filter((x) => !leaving.has(x.id));
    return ok(undefined);
  }
  const on = new Set(cur.map((x) => x.id));
  const taken = new Set<SpotName>(cur.map((x) => x.spot));
  const free = [...PP_FORMATIONS[m.input.settings.formation][n], ...Object.keys(OZ_SPOTS).filter(isSpot)]
    .filter((sp) => !taken.has(sp));
  const joining = m.input.pp.skaters.filter((s) => !on.has(s.id)).slice(0, n - cur.length);
  const out: PpSpot[] = cur.map((x) => ({ ...x }));
  for (const s of joining) {
    const spot = free.find((sp) => !taken.has(sp));
    if (spot === undefined) return err("no free spot for a joining PP skater");
    taken.add(spot);
    out.push({ id: s.id, spot });
  }
  m.s.ppSpots = out;
  return ok(undefined);
}

/** Roster sync, then PK positions for the current puck and strength. O(S^2 + D). */
function refresh(m: Sim): Result<void> {
  const r = syncRoster(m);
  if (!r.ok) return r;
  if (m.s.carrier.kind === "pp") {
    const id = m.s.carrier.id;
    if (!m.s.ppSpots.some((x) => x.id === id)) return err(`carrier ${id} is not on the ice`);
  }
  const st = strengthOf(m.s.penalties, m.s.goaliePulled, m.s.clock.period, m.gt);
  if (!st.ok) return st;
  const pk = pkPositions(m.s.puck, st.value.pk);
  if (!pk.ok) return pk;
  m.s.pkPos = pk.value;
  return ok(undefined);
}

/** Line up for a faceoff at `dot`: formation spots, loose puck on the dot. O(S^2 + D). */
function setFaceoff(m: Sim, dot: FaceoffDot): Result<void> {
  m.s.carrier = { kind: "loose" };
  const r = syncRoster(m);
  if (!r.ok) return r;
  const ids = rosterIds(m);
  const first = ids[0];
  if (first === undefined) return err("no PP skaters on ice");
  const placed = placePp(ids, m.input.settings.formation, first);
  if (!placed.ok) return placed;
  m.s.ppSpots = placed.value;
  m.s.puck = copyVec(FACEOFF_DOTS[dot]);
  m.s.phase = { kind: "faceoff", dot };
  log(m, "faceoff_setup", { detail: { dot } });
  return refresh(m);
}

/** O(S). Spot of an on-ice PP skater. */
function spotOf(m: Pick<Sim, "s">, id: number): Result<SpotName> {
  const h = m.s.ppSpots.find((x) => x.id === id);
  return h === undefined ? err(`PP skater ${id} is not on the ice`) : ok(h.spot);
}

/** Give the puck to on-ice PP skater `id` at their spot; phase decision. O(S). */
function giveTo(m: Sim, id: number): Result<null> {
  const sp = spotOf(m, id);
  if (!sp.ok) return sp;
  m.s.carrier = { kind: "pp", id };
  m.s.puck = spotPos(sp.value);
  m.s.phase = { kind: "decision" };
  return ok(null);
}

/** PP recovers the puck: nearest PP skater to `point` gets it. O(S). */
function ppRecovers(m: Sim, point: Vec2): Result<null> {
  const id = nearestPp(m.s.ppSpots, point);
  if (!id.ok) return id;
  return giveTo(m, id.value);
}

/** Move to the zone-entry pause with the quarterback carrying from centre ice. O(S). */
function toZoneEntry(m: Sim): Result<null> {
  const qb = quarterback(m);
  if (!qb.ok) return qb;
  m.s.carrier = { kind: "pp", id: qb.value };
  m.s.puck = copyVec(FACEOFF_DOTS.centre);
  m.s.phase = { kind: "zone_entry" };
  return ok(null);
}

// ============================================================================ evaluating calls

/** Read-only view used to price calls. */
interface View { input: RunInput; gt: GameType; s: RunState; now: number; boundary: number }

type Plan =
  | { kind: "pass"; to: number; p: number; mid: Vec2 }
  | { kind: "skate"; to: SpotName; p: number; mid: Vec2 }
  | { kind: "shoot"; shooterId: number; at: Vec2; shot: ShotLikelihood }
  | { kind: "set_play"; receiverId: number; toSpot: SpotName; passP: number; mid: Vec2; shot: ShotLikelihood }
  | { kind: "faceoff"; dot: FaceoffDot; takerId: number; target: FaceoffTarget; p: number }
  | { kind: "zone_entry"; method: EntryMethod; p: number }
  | { kind: "breakout"; method: BreakoutMethod; p: number };
interface Evaluated { option: CallOption; plan: Plan }

/** O(K^3 + period). */
function makeView(state: RunState, input: RunInput, gt: GameType): Result<View> {
  const vs = validateState(state);
  if (!vs.ok) return vs;
  const now = absS(state.clock, gt);
  if (!now.ok) return now;
  const b = nextBoundaryS(state.penalties, state.clock, gt);
  if (!b.ok) return b;
  return ok({ input, gt, s: state, now: now.value, boundary: b.value });
}

/** O(1). */
function option(v: View, call: Call, p: number, breakdown: Record<string, number>, durationS: number): Result<CallOption> {
  if (!isProb(p)) return err(`probability ${p} for ${call.type} is not in [0,1]`);
  if (!Number.isInteger(durationS) || durationS < MIN_STEP_S) return err(`invalid duration ${durationS}`);
  return ok({ call, p, breakdown, durationS, cutByClock: v.now + durationS > v.boundary });
}

/** O(S). An on-ice PP skater as a likelihood Skater standing on its spot. */
function ppSkaterAt(v: View, id: number, at?: SpotName): Result<Skater> {
  const base = v.input.pp.skaters.find((s) => s.id === id);
  if (base === undefined) return err(`unknown PP skater ${id}`);
  const sp = at ?? v.s.ppSpots.find((x) => x.id === id)?.spot;
  if (sp === undefined) return err(`PP skater ${id} is not on the ice`);
  return ok({ ...base, pos: spotPos(sp) });
}

const defendersOf = (v: View): Defender[] => v.s.pkPos.map((pos) => ({ pos: copyVec(pos) }));

/** O(S). The puck carrier in a decision phase. */
function carrierOf(v: View): Result<Skater> {
  const c = v.s.carrier;
  if (c.kind !== "pp") return err(`decision phase needs a PP carrier, carrier is ${c.kind}`);
  return ppSkaterAt(v, c.id);
}

/** O(S). Receiver for a set play: a non-carrier on toSpot, else the nearest within range (ties: lowest id). */
function setPlayReceiver(v: View, carrierId: number, toSpot: SpotName): number | null {
  const others = v.s.ppSpots.filter((x) => x.id !== carrierId);
  const holder = others.find((x) => x.spot === toSpot);
  if (holder !== undefined) return holder.id;
  const target = spotPos(toSpot);
  let best: { id: number; d: number } | null = null;
  for (const x of others) {
    const d = dist(spotPos(x.spot), target);
    if (d > SET_PLAY_MAX_SPOT_DIST_FT) continue;
    if (best === null || d < best.d || (d === best.d && x.id < best.id)) best = { id: x.id, d };
  }
  return best === null ? null : best.id;
}

/** O(P). Best PK faceoff taker (ties: lowest id). */
function bestPkTaker(input: RunInput): { id: number; rate: number } | null {
  let best: { id: number; rate: number } | null = null;
  for (const k of input.pk.skaters) {
    if (best === null || k.faceoffWinRate > best.rate || (k.faceoffWinRate === best.rate && k.id < best.id)) {
      best = { id: k.id, rate: k.faceoffWinRate };
    }
  }
  return best;
}

/**
 * The split actually sampled for an unblocked shot: goal [0, pGU), save [pGU, saveCut), miss above.
 * pOnNet is a display number; the save band is max(pGU, pOnNet) - pGU. O(1).
 */
function shotSplit(shot: ShotLikelihood): { pGU: number; saveCut: number } {
  const unblocked = 1 - shot.pBlocked;
  const pGU = unblocked > 0 ? Math.min(1, shot.pGoal / unblocked) : 0;
  return { pGU, saveCut: Math.max(pGU, shot.pOnNet) };
}

/** Breakdown fields for a priced shot, including the sampled conditional split. O(1). */
function shotBreakdown(shot: ShotLikelihood): Record<string, number> {
  const { pGU, saveCut } = shotSplit(shot);
  return {
    pGoal: shot.pGoal, pBlocked: shot.pBlocked, pOnNet: shot.pOnNet, distanceFt: shot.distanceFt,
    pGoalIfUnblocked: pGU, pSaveIfUnblocked: saveCut - pGU, pMissIfUnblocked: 1 - saveCut,
  };
}

/** Only the known fields of a (validated) call, for the persisted log. O(1). */
function callDetail(call: Call): Record<string, string | number> {
  switch (call.type) {
    case "pass": return { type: call.type, to: call.to };
    case "skate": return { type: call.type, to: call.to };
    case "shoot": return { type: call.type, option: call.option, corner: call.corner };
    case "set_play": return { type: call.type, id: call.id };
    case "faceoff": return { type: call.type, takerId: call.takerId, target: call.target };
    case "zone_entry": return { type: call.type, method: call.method };
    case "breakout": return { type: call.type, method: call.method };
  }
}

/** O(D + R). Shot numbers for `shooter` (already positioned). */
function priceShot(v: View, shooter: Skater, opt: ShotOption, corner: Corner): Result<ShotLikelihood> {
  const shot = shotLikelihood(shooter, v.input.pk.goalie, opt, zoneFor(corner, v.input.pk.goalie), defendersOf(v), v.input.rates);
  if (!shot.ok) return shot;
  const { pGoal, pBlocked, pOnNet } = shot.value;
  if (!isProb(pGoal) || !isProb(pBlocked) || !isProb(pOnNet)) return err("shot probabilities out of range");
  return shot;
}

/**
 * Price one call in the current phase and say how it would resolve. Errors for calls that are not
 * legal here (wrong phase, unknown target, self pass, unavailable set play). O(D + R + S).
 */
function evaluate(v: View, call: Call): Result<Evaluated> {
  const ph = v.s.phase;
  if (ph.kind === "ended") return err("run has ended");
  if (call === null || typeof call !== "object") return err("call must be an object");
  const wrongPhase = (): Result<Evaluated> => err(`call ${String(call.type)} is not legal in phase ${ph.kind}`);
  const done = (o: Result<CallOption>, plan: Plan): Result<Evaluated> => (o.ok ? ok({ option: o.value, plan }) : o);
  switch (call.type) {
    case "pass": {
      if (ph.kind !== "decision") return wrongPhase();
      const from = carrierOf(v);
      if (!from.ok) return from;
      if (call.to === from.value.id) return err("cannot pass to self");
      if (!v.s.ppSpots.some((x) => x.id === call.to)) return err(`unknown pass target ${call.to}`);
      const to = ppSkaterAt(v, call.to);
      if (!to.ok) return to;
      const r = passLikelihood(from.value, to.value, defendersOf(v));
      if (!r.ok) return r;
      const { p, distanceFt, laneThreat, receiverThreat } = r.value;
      return done(option(v, call, p, { distanceFt, laneThreat, receiverThreat }, TIME.PASS_S),
        { kind: "pass", to: call.to, p, mid: midpoint(from.value.pos, to.value.pos) });
    }
    case "skate": {
      if (ph.kind !== "decision") return wrongPhase();
      const c = carrierOf(v);
      if (!c.ok) return c;
      if (!isSpot(call.to)) return err(`unknown spot ${String(call.to)}`);
      const here = v.s.ppSpots.find((x) => x.id === c.value.id)?.spot;
      if (here === call.to) return err(`carrier is already on spot ${call.to}`);
      const r = skateLikelihood(c.value, call.to, defendersOf(v));
      if (!r.ok) return r;
      const d = Math.max(MIN_STEP_S, Math.ceil(r.value.distanceFt / SKATE_SPEED_FPS));
      return done(option(v, call, r.value.p, { distanceFt: r.value.distanceFt, pathThreat: r.value.pathThreat }, d),
        { kind: "skate", to: call.to, p: r.value.p, mid: midpoint(c.value.pos, spotPos(call.to)) });
    }
    case "shoot": {
      if (ph.kind !== "decision") return wrongPhase();
      if (!isShotOption(call.option)) return err(`unknown shot option ${String(call.option)}`);
      if (!isCorner(call.corner)) return err(`unknown corner ${String(call.corner)}`);
      const c = carrierOf(v);
      if (!c.ok) return c;
      const shot = priceShot(v, c.value, call.option, call.corner);
      if (!shot.ok) return shot;
      return done(option(v, call, shot.value.pGoal, shotBreakdown(shot.value), TIME.SHOT_S),
        { kind: "shoot", shooterId: c.value.id, at: copyVec(c.value.pos), shot: shot.value });
    }
    case "set_play": {
      if (ph.kind !== "decision") return wrongPhase();
      if (!isSetPlay(call.id)) return err(`unknown set play ${String(call.id)}`);
      const c = carrierOf(v);
      if (!c.ok) return c;
      const sp = SET_PLAYS[call.id];
      const rid = setPlayReceiver(v, c.value.id, sp.toSpot);
      if (rid === null) return err(`set play ${call.id} is not available: nobody can reach ${sp.toSpot}`);
      const recv = ppSkaterAt(v, rid, sp.toSpot);
      if (!recv.ok) return recv;
      const pass = passLikelihood(c.value, recv.value, defendersOf(v));
      if (!pass.ok) return pass;
      const shot = priceShot(v, recv.value, sp.option, sp.corner);
      if (!shot.ok) return shot;
      const passP = pass.value.p;
      return done(option(v, call, passP * shot.value.pGoal, { ...shotBreakdown(shot.value), passP, receiverId: rid },
        TIME.PASS_S + TIME.SHOT_S),
      { kind: "set_play", receiverId: rid, toSpot: sp.toSpot, passP, mid: midpoint(c.value.pos, recv.value.pos), shot: shot.value });
    }
    case "faceoff": {
      if (ph.kind !== "faceoff") return wrongPhase();
      if (!isTarget(call.target)) return err(`unknown faceoff target ${String(call.target)}`);
      if (!v.s.ppSpots.some((x) => x.id === call.takerId)) return err(`unknown faceoff taker ${call.takerId}`);
      const taker = v.input.pp.skaters.find((s) => s.id === call.takerId);
      const opp = bestPkTaker(v.input);
      if (taker === undefined || opp === null) return err(`unknown faceoff taker ${call.takerId}`);
      const pA = taker.faceoffWinRate, pB = opp.rate;
      const p = (pA * (1 - pB)) / (pA * (1 - pB) + pB * (1 - pA));
      return done(option(v, call, p, { pTaker: pA, pOpponent: pB, opponentId: opp.id }, TIME.FACEOFF_S),
        { kind: "faceoff", dot: ph.dot, takerId: call.takerId, target: call.target, p });
    }
    case "zone_entry": {
      if (ph.kind !== "zone_entry") return wrongPhase();
      if (!isEntry(call.method)) return err(`unknown entry method ${String(call.method)}`);
      const c = carrierOf(v);
      if (!c.ok) return c;
      const p = call.method === "carry" ? sigmoid(logit(ENTRY.CARRY_P) + Math.log(c.value.puckControlMult))
        : call.method === "drop" ? sigmoid(logit(ENTRY.DROP_P) + Math.log(c.value.playmakingMult))
          : ENTRY.DUMP_RECOVER_P;
      return done(option(v, call, p, { carrierId: c.value.id }, TIME.ENTRY_S), { kind: "zone_entry", method: call.method, p });
    }
    case "breakout": {
      if (ph.kind !== "breakout") return wrongPhase();
      if (!isBreakout(call.method)) return err(`unknown breakout method ${String(call.method)}`);
      const p = call.method === "carry" ? BREAKOUT.CARRY_P : call.method === "pass" ? BREAKOUT.PASS_P : BREAKOUT.RIM_P;
      return done(option(v, call, p, {}, TIME.BREAKOUT_S), { kind: "breakout", method: call.method, p });
    }
    default:
      return err(`unknown call type ${String((call as { type?: unknown }).type)}`);
  }
}

/** Every call legal in the current phase, in a stable order. O(C + S) for C candidate calls. */
function candidates(v: View): Result<Call[]> {
  const ph = v.s.phase;
  switch (ph.kind) {
    case "ended": return err("run has ended");
    case "faceoff":
      return ok(v.s.ppSpots.flatMap((x) => FACEOFF_TARGETS.map((target): Call => ({ type: "faceoff", takerId: x.id, target }))));
    case "zone_entry": return ok(ENTRY_METHODS.map((method): Call => ({ type: "zone_entry", method })));
    case "breakout": return ok(BREAKOUT_METHODS.map((method): Call => ({ type: "breakout", method })));
    case "decision": {
      const c = carrierOf(v);
      if (!c.ok) return c;
      const here = v.s.ppSpots.find((x) => x.id === c.value.id)?.spot;
      const calls: Call[] = [];
      for (const x of v.s.ppSpots) if (x.id !== c.value.id) calls.push({ type: "pass", to: x.id });
      for (const sp of Object.keys(OZ_SPOTS).filter(isSpot)) if (sp !== here) calls.push({ type: "skate", to: sp });
      for (const option of Object.keys(SHOT_OPTIONS).filter(isShotOption)) {
        for (const corner of CORNERS) calls.push({ type: "shoot", option, corner });
      }
      for (const id of Object.keys(SET_PLAYS).filter(isSetPlay)) {
        if (setPlayReceiver(v, c.value.id, SET_PLAYS[id].toSpot) !== null) calls.push({ type: "set_play", id });
      }
      return ok(calls);
    }
  }
}

// ============================================================================ resolving

/** Auto-played follow-ups, processed until a pause phase. */
type Action =
  | { k: "loose" } | { k: "pk_possession" } | { k: "clear" } | { k: "regroup" } | { k: "auto_breakout" }
  | { k: "setup"; carrierId: number };

/** True when the clock sits exactly at the end of its period. O(1). */
function atPeriodEnd(m: Sim): Result<boolean> {
  const len = periodLengthS(m.s.clock.period, m.gt);
  return len.ok ? ok(m.s.clock.elapsedS === len.value) : len;
}

/** Period over: end the game or start the next period with a centre faceoff. O(S^2 + D). */
function endOfPeriod(m: Sim): Result<void> {
  const r = endPeriod(m.s.clock, m.s.score, m.gt);
  if (!r.ok) return r;
  log(m, "period_end", { detail: { period: m.s.clock.period } });
  if ("ended" in r.value) {
    end(m, "game_end", r.value.ended);
    return ok(undefined);
  }
  m.s.clock = r.value.next; // same absolute second
  return setFaceoff(m, "centre");
}

/** The clock reached nextBoundaryS mid-step: PP end or period end. O(K^2 + S^2). */
function atBoundary(m: Sim): Result<void> {
  m.s.penalties = expireUpTo(m.s.penalties, m.abs, true);
  if (!ppActive(m.s.penalties)) { end(m, "pp_expired", null); return ok(undefined); }
  const pe = atPeriodEnd(m);
  if (!pe.ok) return pe;
  if (pe.value) return endOfPeriod(m);
  return err(`clock boundary at ${m.abs} but neither the power play nor the period ended`);
}

/**
 * One timed step of `d` seconds following the clock protocol in the header. `resolve` runs at t1
 * (unless the step is cut) and returns the follow-up action or null at a pause. O(K^3 + S^2 + resolve).
 */
function timed(m: Sim, d: number, label: string, resolve: () => Result<Action | null>): Result<Action | null> {
  const e = nextBoundaryS(m.s.penalties, m.s.clock, m.gt);
  if (!e.ok) return e;
  m.s.step++;
  if (m.abs + d > e.value) {
    const c = setAbs(m, e.value);
    if (!c.ok) return c;
    log(m, "cut_by_clock", { detail: { step: label, durationS: d } });
    const b = atBoundary(m);
    return b.ok ? ok(null) : b;
  }
  const c = setAbs(m, m.abs + d);
  if (!c.ok) return c;
  m.s.penalties = expireUpTo(m.s.penalties, m.abs, false);
  const r = resolve();
  if (!r.ok || m.s.phase.kind === "ended") return r.ok ? ok(null) : r;
  m.s.penalties = expireUpTo(m.s.penalties, m.abs, true);
  if (!ppActive(m.s.penalties)) { end(m, "pp_expired", null); return ok(null); }
  const pe = atPeriodEnd(m);
  if (!pe.ok) return pe;
  if (pe.value) {
    const eop = endOfPeriod(m);
    return eop.ok ? ok(null) : eop;
  }
  const f = refresh(m);
  return f.ok ? ok(r.value) : f;
}

/** PP goal at the current second. O(K + S^2). */
function ppGoal(m: Sim): Result<null> {
  m.s.score.pp++;
  m.s.justScored = true;
  m.s.penalties = releaseOnGoal(m.s.penalties, m.abs);
  m.s.goaliePulled = false;
  log(m, "goal", { detail: { side: "pp" } });
  if (m.s.clock.period > REGULATION_PERIODS) { end(m, "game_end", "ot_goal"); return ok(null); }
  if (!ppActive(m.s.penalties)) { end(m, "pp_expired", null); return ok(null); }
  const f = setFaceoff(m, "centre");
  return f.ok ? ok(null) : f;
}

/** Shorthanded goal: the run ends. O(1). */
function shGoal(m: Sim): Result<null> {
  m.s.score.pk++;
  log(m, "goal", { detail: { side: "pk" } });
  end(m, "sh_goal", m.s.goaliePulled ? "empty_net" : null);
  return ok(null);
}

/** Failed pass: interception or a loose puck at the lane midpoint. O(1). */
function passFailure(m: Sim, mid: Vec2): Result<Action> {
  m.s.puck = copyVec(mid);
  if (draw(m, "intercept", RECOVERY.PASS_INTERCEPT_P)) {
    m.s.carrier = { kind: "pk" };
    return ok({ k: "pk_possession" });
  }
  m.s.carrier = { kind: "loose" };
  return ok({ k: "loose" });
}

/** PK gains the puck at `at`. O(1). */
function pkGets(m: Sim, at: Vec2): Result<Action> {
  m.s.puck = copyVec(at);
  m.s.carrier = { kind: "pk" };
  return ok({ k: "pk_possession" });
}

/** Block / goal / save / miss chain for a shot from `at` by `shooterId`. O(S + K + D). */
function shotChain(m: Sim, shooterId: number, at: Vec2, shot: ShotLikelihood): Result<Action | null> {
  const { pBlocked } = shot;
  if (draw(m, "block", pBlocked, { shooterId })) {
    if (draw(m, "blocked_recover", RECOVERY.BLOCKED_PP_P)) return ppRecovers(m, at);
    return pkGets(m, at);
  }
  const { pGU, saveCut } = shotSplit(shot);
  const outcome = drawSplit(m, "shot", [pGU, saveCut], { shooterId });
  if (outcome === 0) return ppGoal(m);
  if (outcome === 1) {
    log(m, "save");
    if (draw(m, "freeze", RECOVERY.SAVE_FREEZE_P)) {
      const f = setFaceoff(m, at.y >= 0 ? "oz_left" : "oz_right");
      return f.ok ? ok(null) : f;
    }
    if (draw(m, "rebound", RECOVERY.REBOUND_PP_P)) {
      const front = m.s.ppSpots.find((x) => x.spot === "net_front");
      return front !== undefined ? giveTo(m, front.id) : ppRecovers(m, NET);
    }
    return pkGets(m, NET);
  }
  log(m, "miss");
  const wide = spotPos(at.y >= 0 ? "goal_line_left" : "goal_line_right");
  if (draw(m, "miss_recover", RECOVERY.MISS_PP_P)) return ppRecovers(m, wide);
  return pkGets(m, wide);
}

/** O(S). Faceoff winner group: point spots, half-wall spots, or nearest to the dot. */
function faceoffWinner(m: Sim, target: FaceoffTarget, dot: FaceoffDot): Result<number> {
  const prefix = target === "point" ? "point_" : target === "half_wall" ? "half_wall_" : null;
  const group = prefix === null ? m.s.ppSpots : m.s.ppSpots.filter((x) => x.spot.startsWith(prefix));
  return nearestPp(group.length > 0 ? group : m.s.ppSpots, FACEOFF_DOTS[dot]);
}

/** Resolve the player's call at t1. O(S + K + D). */
function resolvePlan(m: Sim, plan: Plan): Result<Action | null> {
  switch (plan.kind) {
    case "pass":
      if (draw(m, "pass", plan.p, { to: plan.to })) return giveTo(m, plan.to);
      return passFailure(m, plan.mid);
    case "skate": {
      const c = m.s.carrier;
      if (c.kind !== "pp") return err("skate without a PP carrier");
      if (draw(m, "skate", plan.p, { to: plan.to })) {
        const moved = moveCarrierTo(m.s.ppSpots, c.id, plan.to);
        if (!moved.ok) return moved;
        m.s.ppSpots = moved.value;
        return giveTo(m, c.id);
      }
      m.s.puck = copyVec(plan.mid);
      m.s.carrier = { kind: "loose" };
      return ok({ k: "loose" });
    }
    case "shoot":
      return shotChain(m, plan.shooterId, plan.at, plan.shot);
    case "set_play": {
      if (!draw(m, "pass", plan.passP, { to: plan.receiverId, setPlay: true })) return passFailure(m, plan.mid);
      const moved = moveCarrierTo(m.s.ppSpots, plan.receiverId, plan.toSpot);
      if (!moved.ok) return moved;
      m.s.ppSpots = moved.value;
      const g = giveTo(m, plan.receiverId);
      if (!g.ok) return g;
      return shotChain(m, plan.receiverId, spotPos(plan.toSpot), plan.shot);
    }
    case "faceoff":
      if (draw(m, "faceoff", plan.p, { takerId: plan.takerId, dot: plan.dot })) {
        if (plan.dot === "centre") return toZoneEntry(m);
        const w = faceoffWinner(m, plan.target, plan.dot);
        return w.ok ? giveTo(m, w.value) : w;
      }
      m.s.carrier = { kind: "pk" };
      return ok(draw(m, "faceoff_loss_clear", FACEOFF.LOSS_CLEAR_P) ? { k: "clear" } : { k: "pk_possession" });
    case "zone_entry": {
      const c = m.s.carrier;
      if (c.kind !== "pp") return err("zone entry without a PP carrier");
      if (draw(m, "entry", plan.p, { method: plan.method })) return ok({ k: "setup", carrierId: c.id });
      return pkGets(m, { x: OZ_BOUNDS.X_MIN, y: 0 });
    }
    case "breakout":
      if (draw(m, "breakout", plan.p, { method: plan.method })) return toZoneEntry(m);
      return ok({ k: "clear" });
  }
}

/** One auto-played follow-up. O(K^3 + S^2 + D). */
function runAction(m: Sim, a: Action): Result<Action | null> {
  switch (a.k) {
    case "loose":
      return timed(m, TIME.LOOSE_S, "loose", () => {
        if (draw(m, "loose", RECOVERY.LOOSE_PP_P)) return ppRecovers(m, m.s.puck);
        m.s.carrier = { kind: "pk" };
        return ok({ k: "pk_possession" });
      });
    case "pk_possession":
      return timed(m, TIME.PK_POSSESSION_S, "pk_possession", () => {
        const o = drawSplit(m, "pk_possession", [PK.CLEAR_P, PK.CLEAR_P + PK.SH_CHANCE_P]);
        if (o === 0) {
          if (m.s.goaliePulled && draw(m, "en_clear", PK.EN_CLEAR_GOAL_P)) return shGoal(m);
          return ok({ k: "clear" });
        }
        if (o === 1) {
          log(m, "sh_chance");
          if (draw(m, "sh_goal", m.s.goaliePulled ? PK.EN_GOAL_P : PK.SH_GOAL_P)) return shGoal(m);
          return ok({ k: "clear" });
        }
        return ppRecovers(m, m.s.puck);
      });
    case "clear": {
      const ppEnd = ppEndS(m.s.penalties);
      if (ppEnd === null) { end(m, "pp_expired", null); return ok(null); }
      const remainingS = ppEnd - m.abs;
      m.s.carrier = { kind: "pk" };
      m.s.puck = copyVec(FACEOFF_DOTS.centre);
      log(m, "clear", { detail: { remainingS } });
      if (remainingS < CLEAR_REENTRY_MIN_S) { end(m, "cleared_out", null); return ok(null); }
      const f = refresh(m);
      return f.ok ? ok({ k: "regroup" }) : f;
    }
    case "regroup":
      return timed(m, TIME.REGROUP_S, "regroup", () => {
        const qb = quarterback(m);
        if (!qb.ok) return qb;
        m.s.carrier = { kind: "pp", id: qb.value };
        if (m.input.settings.askEveryTouch) { m.s.phase = { kind: "breakout" }; return ok(null); }
        return ok({ k: "auto_breakout" });
      });
    case "auto_breakout":
      return timed(m, TIME.BREAKOUT_S, "auto_breakout", () => {
        if (draw(m, "breakout", BREAKOUT.PASS_P, { method: "pass" })) return toZoneEntry(m);
        return ok({ k: "clear" });
      });
    case "setup":
      return timed(m, TIME.SETUP_S, "setup", () => {
        const placed = placePp(rosterIds(m), m.input.settings.formation, a.carrierId);
        if (!placed.ok) return placed;
        m.s.ppSpots = placed.value;
        return giveTo(m, a.carrierId);
      });
  }
}

/** True for phases where the player is asked for a call. O(1). */
function isPause(m: Sim): boolean {
  const k = m.s.phase.kind;
  return k === "faceoff" || k === "decision" || k === "zone_entry" || k === "ended"
    || (k === "breakout" && m.input.settings.askEveryTouch);
}

// ============================================================================ public API

/** Validate the input and build the opening state (one logged draw picks the OZ dot). O(S + R + K^3). */
export function initRun(input: RunInput): Result<RunState> {
  const gt = validateStatic(input);
  if (!gt.ok) return gt;
  const now = validateStart(input, gt.value);
  if (!now.ok) return now;
  const ids = input.pp.skaters.slice(0, now.value.ppOnIce).map((s) => s.id);
  const first = ids[0];
  if (first === undefined) return err("no PP skaters");
  const placed = placePp(ids, input.settings.formation, first);
  if (!placed.ok) return placed;
  const m: Sim = {
    input, gt: gt.value, abs: now.value.now, ci: null,
    s: {
      v: STATE_VERSION, rng: input.seed >>> 0, callCount: 0, step: 0,
      clock: { ...input.clock }, penalties: input.penalties.map((p) => ({ ...p })), score: { ...input.score },
      goaliePulled: input.goaliePulled, phase: { kind: "faceoff", dot: "centre" }, puck: copyVec(FACEOFF_DOTS.centre),
      carrier: { kind: "loose" }, ppSpots: placed.value, pkPos: [], justScored: false, log: [],
    },
  };
  const left = draw(m, "opening_faceoff", OPENING_FACEOFF_LEFT_P);
  const f = setFaceoff(m, left ? "oz_left" : "oz_right");
  return f.ok ? ok(m.s) : f;
}

/** Options for the current phase, each priced exactly as applyCall would sample it. O(C x (D + R + S)), C <= ~60. */
export function legalCalls(state: RunState, input: RunInput): Result<CallOption[]> {
  const gt = validateStatic(input);
  if (!gt.ok) return gt;
  const v = makeView(state, input, gt.value);
  if (!v.ok) return v;
  const calls = candidates(v.value);
  if (!calls.ok) return calls;
  const out: CallOption[] = [];
  for (const c of calls.value) {
    const e = evaluate(v.value, c);
    if (!e.ok) return err(`pricing ${c.type}: ${e.error}`);
    out.push(e.value.option);
  }
  return ok(out);
}

/**
 * Apply the player's call number `callIndex` (must equal state.callCount), then auto-play to the
 * next pause or the end. Returns a new state; `state` is untouched on success and on error.
 * O(A x (K^3 + S^2 + D + R)) for A <= MAX_AUTO_STEPS_PER_CALL + remaining PP seconds auto steps, plus O(L) to copy the log.
 */
export function applyCall(state: RunState, input: RunInput, call: Call, callIndex: number): Result<RunState> {
  const gt = validateStatic(input);
  if (!gt.ok) return gt;
  const v = makeView(state, input, gt.value);
  if (!v.ok) return v;
  if (!Number.isInteger(callIndex) || callIndex !== state.callCount) {
    return err(`callIndex ${callIndex} does not match the next call ${state.callCount} (stale or repeated)`);
  }
  if (state.phase.kind === "ended") return err("run has ended");
  if (state.callCount + 1 > MAX_CALLS_PER_RUN) return err(`call cap reached (MAX_CALLS_PER_RUN ${MAX_CALLS_PER_RUN})`);
  const ev = evaluate(v.value, call);
  if (!ev.ok) return ev;

  const m: Sim = { input, gt: gt.value, s: cloneState(state), abs: v.value.now, ci: callIndex };
  m.s.callCount++;
  m.s.justScored = false;
  log(m, "call", { p: ev.value.option.p, detail: callDetail(call) });
  let next = timed(m, ev.value.option.durationS, call.type, () => resolvePlan(m, ev.value.plan));
  m.ci = null;
  // Loop guard that a legitimate run can never hit: every timed auto step uses >= 1 s and the run
  // ends with the advantage, so allow one step per remaining PP second on top of the base cap.
  const ppEnd = ppEndS(m.s.penalties);
  const stepCap = MAX_AUTO_STEPS_PER_CALL + Math.max(0, (ppEnd ?? m.abs) - m.abs);
  for (let steps = 0; ; steps++) {
    if (!next.ok) return next;
    const a = next.value;
    if (a === null) break;
    if (steps >= stepCap) return err(`more than ${stepCap} auto steps after one call (loop guard)`);
    next = runAction(m, a);
  }
  if (!isPause(m)) return err(`internal: stopped in non-pause phase ${m.s.phase.kind}`);
  return ok(m.s);
}

/** Let `policy` make up to `maxCalls` calls (stops early when the run ends). O(maxCalls x applyCall). */
export function autoPlay(state: RunState, input: RunInput, policy: Policy, maxCalls: number): Result<RunState> {
  if (!Number.isInteger(maxCalls) || maxCalls < 0) return err(`maxCalls must be a non-negative integer, got ${maxCalls}`);
  const vs = validateState(state);
  if (!vs.ok) return vs;
  let s = vs.value;
  for (let k = 0; k < maxCalls && s.phase.kind !== "ended"; k++) {
    const opts = legalCalls(s, input);
    if (!opts.ok) return opts;
    if (opts.value.length === 0) return err(`no legal calls in phase ${s.phase.kind}`);
    const next = applyCall(s, input, policy(opts.value, s), s.callCount);
    if (!next.ok) return next;
    s = next.value;
  }
  return ok(s);
}

/** Rebuild a run from its replay key. O(N x applyCall) for N calls. */
export function replay(input: RunInput, calls: Call[]): Result<RunState> {
  const init = initRun(input);
  if (!init.ok) return init;
  if (!Array.isArray(calls)) return err("calls must be an array");
  let s = init.value;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i];
    if (c === undefined) return err(`call ${i} is missing`);
    const next = applyCall(s, input, c, i);
    if (!next.ok) return err(`call ${i}: ${next.error}`);
    s = next.value;
  }
  return ok(s);
}

