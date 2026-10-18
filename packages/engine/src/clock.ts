/**
 * Game clock, strength and penalty bookkeeping for the run simulation.
 *
 * Stateless: every function is pure, takes plain data and returns new values (penalty arrays are
 * never mutated). Safe to call from a Web Worker and on the server; no shared state, no ambient
 * time or randomness.
 *
 * Time model: integer seconds. A Clock is (period, elapsedS counting up); penalty expiry is in
 * ABSOLUTE game seconds (sum of earlier period lengths + elapsed), so carry-over across periods
 * needs no bookkeeping. A penalty is "active" when expiresAtS !== null, "queued" otherwise.
 *
 * Expiry convention: a penalty with expiresAtS === t is still active AT t, so a goal scored at the
 * exact expiry second counts as a power-play goal. The sim calls expireUpTo(ps, t, false) before
 * resolving an event at t and expireUpTo(ps, t, true) after it.
 *
 * K below is the number of penalties (at most a handful in practice).
 */
import {
  BASE_SKATERS, MAX_ACTIVE_PENALTIES_PER_SIDE, MIN_SKATERS, PENALTY_S, PERIOD_LENGTH_S, PLAYOFF_OT_LENGTH_S,
  REG_OT_BASE_SKATERS, REG_OT_LENGTH_S, REGULATION_PERIODS,
} from "./constants.ts";
import { err, ok, type Result } from "./result.ts";
import type { Clock, EndDetail, GameType, Penalty, Score, Side, Strength } from "./sim-types.ts";

/** Periods are numbered from 1 (NHL API convention). */
const FIRST_PERIOD = 1;
/** A pulled goalie is replaced by exactly one extra skater. */
const EXTRA_ATTACKER = 1;
const REGULAR_SEASON: GameType = 2;
const OT_PERIOD = REGULATION_PERIODS + 1;

const isActive = (p: Penalty): boolean => p.expiresAtS !== null;

/** Active penalty count for one side. O(K). */
function activeCount(penalties: readonly Penalty[], side: Side): number {
  let n = 0;
  for (const p of penalties) if (p.side === side && isActive(p)) n++;
  return n;
}

/** Length (s) of a period. Regular-season period 5+ is an error: the shootout is not a period. O(1). */
export function periodLengthS(period: number, gameType: GameType): Result<number> {
  if (!Number.isInteger(period) || period < FIRST_PERIOD) return err(`invalid period ${period}`);
  if (period <= REGULATION_PERIODS) return ok(PERIOD_LENGTH_S);
  if (gameType === REGULAR_SEASON) {
    if (period === OT_PERIOD) return ok(REG_OT_LENGTH_S);
    return err(`regular season has no period ${period} (shootout is not a period)`);
  }
  return ok(PLAYOFF_OT_LENGTH_S);
}

/** Absolute game second of a clock reading. O(period). */
export function absS(clock: Clock, gameType: GameType): Result<number> {
  const len = periodLengthS(clock.period, gameType);
  if (!len.ok) return len;
  const e = clock.elapsedS;
  if (!Number.isInteger(e) || e < 0 || e > len.value) {
    return err(`elapsedS ${e} out of range [0, ${len.value}] for period ${clock.period}`);
  }
  let total = 0;
  for (let p = FIRST_PERIOD; p < clock.period; p++) {
    const l = periodLengthS(p, gameType);
    if (!l.ok) return l;
    total += l.value;
  }
  return ok(total + e);
}

/**
 * Inverse of absS. At an exact period boundary this returns the END of the earlier period
 * (elapsedS === its length), not second 0 of the next one: the boundary second still belongs to
 * the period that is ending, so the sim sees "period over" and calls endPeriod to move on.
 * Errors past the end of a regular-season OT. O(period).
 */
export function clockAt(abs: number, gameType: GameType): Result<Clock> {
  if (!Number.isInteger(abs) || abs < 0) return err(`invalid absolute second ${abs}`);
  let start = 0;
  for (let period = FIRST_PERIOD; ; period++) {
    const len = periodLengthS(period, gameType);
    if (!len.ok) return err(`absolute second ${abs} is past the end of the game`);
    if (abs <= start + len.value) return ok({ period, elapsedS: abs - start });
    start += len.value;
  }
}

/**
 * Skaters on ice per side. Regulation and playoff OT: 5 minus active penalties (floor 3), +1 for
 * the PP side if its goalie is pulled. Regular-season OT starts at 3-on-3 and a penalty ADDS a
 * skater to the other side instead (capped at 5, or 6 with the goalie pulled). O(K).
 */
export function strengthOf(penalties: readonly Penalty[], goaliePulled: boolean, period: number,
  gameType: GameType): Result<Strength> {
  const len = periodLengthS(period, gameType);
  if (!len.ok) return len;
  const ppA = activeCount(penalties, "pp");
  const pkA = activeCount(penalties, "pk");
  if (ppA > MAX_ACTIVE_PENALTIES_PER_SIDE || pkA > MAX_ACTIVE_PENALTIES_PER_SIDE) {
    return err(`more than ${MAX_ACTIVE_PENALTIES_PER_SIDE} active penalties on a side (pp ${ppA}, pk ${pkA})`);
  }
  const extra = goaliePulled ? EXTRA_ATTACKER : 0;
  if (gameType === REGULAR_SEASON && period === OT_PERIOD) {
    const d = pkA - ppA;
    return ok({
      pp: Math.min(REG_OT_BASE_SKATERS + Math.max(0, d), BASE_SKATERS) + extra,
      pk: REG_OT_BASE_SKATERS + Math.max(0, -d),
    });
  }
  return ok({
    pp: Math.max(MIN_SKATERS, BASE_SKATERS - ppA) + extra,
    pk: Math.max(MIN_SKATERS, BASE_SKATERS - pkA),
  });
}

/** True while the PK side has more active penalties than the PP side. O(K). */
export function ppActive(penalties: readonly Penalty[]): boolean {
  return activeCount(penalties, "pk") > activeCount(penalties, "pp");
}

/**
 * Lowest-id queued penalty of a side, or undefined. O(K).
 */
function firstQueued(penalties: readonly Penalty[], side: Side): Penalty | undefined {
  let best: Penalty | undefined;
  for (const p of penalties) {
    if (p.side === side && !isActive(p) && (best === undefined || p.id < best.id)) best = p;
  }
  return best;
}

/**
 * Fill free active slots of `side` from its queue (id order), each starting at `startS`. O(K^2)
 * worst case, but at most MAX_ACTIVE_PENALTIES_PER_SIDE promotions happen.
 */
function promote(penalties: readonly Penalty[], side: Side, startS: number): Penalty[] {
  let out = [...penalties];
  while (activeCount(out, side) < MAX_ACTIVE_PENALTIES_PER_SIDE) {
    const q = firstQueued(out, side);
    if (q === undefined) break;
    const started: Penalty = { ...q, expiresAtS: startS + q.durationS };
    out = out.map((p) => (p === q ? started : p));
  }
  return out;
}

/**
 * Drop active penalties expiring before `abs` (or at it, if inclusive), in chronological order
 * (ties: lowest id), promoting queued penalties of the same side as slots free up; a promoted
 * penalty starts at the expiry second of the one it replaces and may itself expire in the same
 * call. Array order of surviving penalties is preserved. O(K^2): each of <= K removals scans K.
 */
export function expireUpTo(penalties: readonly Penalty[], abs: number, inclusive: boolean): Penalty[] {
  let out = [...penalties];
  for (;;) {
    let next: Penalty | undefined;
    for (const p of out) {
      if (p.expiresAtS === null) continue;
      const due = inclusive ? p.expiresAtS <= abs : p.expiresAtS < abs;
      if (!due) continue;
      if (next === undefined || next.expiresAtS === null || p.expiresAtS < next.expiresAtS
        || (p.expiresAtS === next.expiresAtS && p.id < next.id)) next = p;
    }
    if (next === undefined || next.expiresAtS === null) return out;
    const gone = next;
    out = promote(out.filter((p) => p !== gone), gone.side, next.expiresAtS);
  }
}

/**
 * A power-play goal at `abs`. Only applies while ppActive (no release at even strength, e.g.
 * 4-on-4). The PK-side active minor or double minor with the earliest expiry (ties: lowest id)
 * is released: a minor ends; a double minor with more than one minor's length left is cut to one
 * minor from now, otherwise it ends. Majors are never released. A freed slot is filled from the PK
 * queue starting at `abs`. Returns the input contents unchanged when nothing is releasable. O(K).
 */
export function releaseOnGoal(penalties: readonly Penalty[], abs: number): Penalty[] {
  if (!ppActive(penalties)) return [...penalties];
  let target: Penalty | undefined;
  for (const p of penalties) {
    if (p.side !== "pk" || p.expiresAtS === null || p.kind === "major") continue;
    if (target === undefined || target.expiresAtS === null || p.expiresAtS < target.expiresAtS
      || (p.expiresAtS === target.expiresAtS && p.id < target.id)) target = p;
  }
  if (target === undefined || target.expiresAtS === null) return [...penalties];
  const hit = target;
  if (hit.kind === "double_minor" && target.expiresAtS - abs > PENALTY_S.minor) {
    const cut: Penalty = { ...hit, expiresAtS: abs + PENALTY_S.minor };
    return penalties.map((p) => (p === hit ? cut : p));
  }
  return promote(penalties.filter((p) => p !== hit), "pk", abs);
}

/**
 * Absolute second the current advantage ends if nothing else happens (queued promotions
 * included), or null if there is no advantage now. The PP is still on at that second (see the
 * expiry convention above). O(K^3): <= K expiry steps, each an O(K^2) expireUpTo.
 */
export function ppEndS(penalties: readonly Penalty[]): number | null {
  let ps: Penalty[] = [...penalties];
  if (!ppActive(ps)) return null;
  for (;;) {
    let t: number | null = null;
    for (const p of ps) if (p.expiresAtS !== null && (t === null || p.expiresAtS < t)) t = p.expiresAtS;
    // ppActive implies at least one active PK penalty, so t is set; guard keeps the loop finite.
    if (t === null) return null;
    ps = expireUpTo(ps, t, true);
    if (!ppActive(ps)) return t;
  }
}

/**
 * Most PP skaters the run can need before the advantage ends if nothing but the clock happens:
 * walks every distinct expiry second in order (queued promotions included, as expireUpTo) and,
 * for each penalty state, every period that state can span (period ends may switch regulation to
 * regular-season OT strength rules; periods past the end of the game are skipped). PP goals and a
 * returning goalie only ever lower PP strength, so they are not walked. With no power play now,
 * returns the current PP strength. O(K^3 + K x P) for K penalties and P periods spanned.
 */
export function maxPpStrength(penalties: readonly Penalty[], goaliePulled: boolean, clock: Clock,
  gameType: GameType): Result<number> {
  const start = absS(clock, gameType);
  if (!start.ok) return start;
  const now = strengthOf(penalties, goaliePulled, clock.period, gameType);
  if (!now.ok) return now;
  let best = now.value.pp;
  let ps: Penalty[] = [...penalties];
  let t = start.value;
  let period = clock.period;
  while (ppActive(ps)) {
    let next: number | null = null;
    for (const p of ps) if (p.expiresAtS !== null && (next === null || p.expiresAtS < next)) next = p.expiresAtS;
    // ppActive implies an active PK penalty, so next is set; the guard keeps the loop finite.
    if (next === null || next < t) return err(`penalty timeline goes backwards at ${t}`);
    // Every period this penalty state spans, from the current one to the one containing `next`.
    for (let p = period; ; p++) {
      const pStart = absS({ period: p, elapsedS: 0 }, gameType);
      if (!pStart.ok) break; // past the end of the game
      if (p > period && pStart.value >= next) break;
      const st = strengthOf(ps, goaliePulled, p, gameType);
      if (!st.ok) return st;
      best = Math.max(best, st.value.pp);
      period = p;
    }
    ps = expireUpTo(ps, next, true);
    t = next;
  }
  return ok(best);
}

/** min(ppEndS, absolute end of the current period). O(K^3 + period). */
export function nextBoundaryS(penalties: readonly Penalty[], clock: Clock, gameType: GameType): Result<number> {
  const now = absS(clock, gameType);
  if (!now.ok) return now;
  const len = periodLengthS(clock.period, gameType);
  if (!len.ok) return len;
  const periodEnd = now.value - clock.elapsedS + len.value;
  const pp = ppEndS(penalties);
  return ok(pp === null ? periodEnd : Math.min(pp, periodEnd));
}

/**
 * Called when the current period's clock has run out (elapsedS must equal its length).
 * Periods before the 3rd roll over; after the 3rd an untied game ends in regulation, a tied one
 * goes to OT. A tied regular-season OT goes to the shootout; a tied playoff OT starts another.
 * An untied game in OT is an error: an OT goal ends the game elsewhere. O(1).
 */
export function endPeriod(clock: Clock, score: Score,
  gameType: GameType): Result<{ next: Clock } | { ended: EndDetail }> {
  const len = periodLengthS(clock.period, gameType);
  if (!len.ok) return len;
  if (clock.elapsedS !== len.value) {
    return err(`endPeriod called at elapsedS ${clock.elapsedS}, period ${clock.period} ends at ${len.value}`);
  }
  const next = { next: { period: clock.period + 1, elapsedS: 0 } };
  if (clock.period < REGULATION_PERIODS) return ok(next);
  const tied = score.pp === score.pk;
  if (clock.period === REGULATION_PERIODS) return ok(tied ? next : { ended: "regulation_end" });
  if (!tied) return err(`overtime period ${clock.period} ended with an untied score`);
  return ok(gameType === REGULAR_SEASON ? { ended: "shootout" } : next);
}
