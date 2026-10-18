/**
 * Rink motion planning. Pure: no DOM, no clock (callers pass `nowMs`), no randomness.
 *
 * Given what the rink showed last time (`RinkMemo`) and the new engine state, `planMotion` says how to get
 * from one to the other: PP skaters and PK skaters interpolate between their old and new engine positions,
 * and the puck follows a polyline implied by the NEW log events since the last state. Nothing is invented:
 * every waypoint is an engine position (previous puck, NET, the faceoff centre the engine sends a clear to,
 * the new puck) or the point where the straight line to such a position leaves the rink art.
 * Positions are engine feet; mapping to pixels is geometry.ts.
 * Thread ownership: none (stateless).
 */
import { FACEOFF_DOTS, NET, OZ_BOUNDS, OZ_SPOTS } from "@powerplay/engine/constants.ts";
import type { Vec2 } from "@powerplay/engine/likelihood.ts";
import { err, ok, type Result } from "@powerplay/engine/result.ts";
import type { Carrier, RunEvent, RunState } from "@powerplay/engine/sim-types.ts";
import { RINK_VIEWBOX } from "./geometry.ts";

/** Whole move lasts MIN..MAX ms; longer moves get more time. UI tunables, not engine values. */
export const ANIM_MIN_MS = 400;
export const ANIM_MAX_MS = 700;
export const ANIM_MS_PER_FT = 6;
/** A remembered state older than this is a different visit, not "the previous frame". */
export const MEMO_STALE_MS = 30_000;
/** Two points closer than this (ft) are the same point. */
const SAME_POINT_FT = 0.01;

export type PpSpot = RunState["ppSpots"][number];

/** The slice of RunState the rink draws, plus the log so new events can be told from old ones. */
export interface RinkSnapshot {
  puck: Vec2;
  pkPos: readonly Vec2[];
  ppSpots: readonly PpSpot[];
  carrier: Carrier;
  /** Absent for callers that cannot say what happened: then nothing animates. */
  log?: readonly RunEvent[];
}

/** What the rink remembers about the last state it drew. */
export interface RinkMemo {
  puck: Vec2;
  pkPos: readonly Vec2[];
  ppSpots: readonly PpSpot[];
  carrier: Carrier;
  logLength: number;
  firstKey: string | null;
  lastKey: string | null;
  atMs: number;
}

export interface MotionPlan {
  /** >= 2 engine-feet points. */
  puckPath: Vec2[];
  prevPpSpots: readonly PpSpot[];
  prevPkPos: readonly Vec2[];
  prevPuckHeld: boolean;
  nextPuckHeld: boolean;
  durationMs: number;
}

// ---------------------------------------------------------------- numbers

export const clamp01 = (t: number): number => (Number.isFinite(t) ? Math.min(1, Math.max(0, t)) : 1);

/** O(1). Cubic ease in-out on [0, 1]. */
export const easeInOutCubic = (t: number): number => {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpVec = (a: Vec2, b: Vec2, t: number): Vec2 => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) });
export const dist = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
const isFiniteVec = (p: Vec2): boolean => Number.isFinite(p.x) && Number.isFinite(p.y);

/** O(n). Sum of segment lengths. */
export function pathLength(path: readonly Vec2[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a !== undefined && b !== undefined) total += dist(a, b);
  }
  return total;
}

/** O(n). Point at fraction `t` of the path's length (not of its vertex count). Empty path -> error. */
export function puckAt(path: readonly Vec2[], t: number): Result<Vec2> {
  const first = path[0];
  if (first === undefined) return err("empty puck path");
  const last = path[path.length - 1] ?? first;
  const x = clamp01(t);
  const total = pathLength(path);
  if (total <= SAME_POINT_FT || x >= 1) return ok(x >= 1 ? last : first);
  let want = x * total;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    if (a === undefined || b === undefined) continue;
    const seg = dist(a, b);
    if (want <= seg) return ok(seg <= SAME_POINT_FT ? b : lerpVec(a, b, want / seg));
    want -= seg;
  }
  return ok(last);
}

// ---------------------------------------------------------------- geometry

/**
 * The rink art covers engine x in [X_MAX - height, X_MAX] and |y| <= Y_ABS_MAX. O(1).
 * Returns where the ray from `from` toward `toward` leaves that box (the bottom edge for a clear).
 * If `from` is already outside, or the ray never leaves toward `toward`, returns `toward` unchanged.
 */
export function clipToArt(from: Vec2, toward: Vec2): Vec2 {
  const xMin = OZ_BOUNDS.X_MAX - RINK_VIEWBOX.height;
  const dx = toward.x - from.x;
  const dy = toward.y - from.y;
  let t = 1;
  if (dx < 0 && toward.x < xMin) t = Math.min(t, (xMin - from.x) / dx);
  if (dy > 0 && toward.y > OZ_BOUNDS.Y_ABS_MAX) t = Math.min(t, (OZ_BOUNDS.Y_ABS_MAX - from.y) / dy);
  if (dy < 0 && toward.y < -OZ_BOUNDS.Y_ABS_MAX) t = Math.min(t, (-OZ_BOUNDS.Y_ABS_MAX - from.y) / dy);
  if (!Number.isFinite(t) || t < 0) return toward;
  return { x: from.x + dx * t, y: from.y + dy * t };
}

// ---------------------------------------------------------------- the puck's path

const callType = (events: readonly RunEvent[]): string | null => {
  const detail = events.find((e) => e.kind === "call")?.detail;
  const type = detail?.type;
  return typeof type === "string" ? type : null;
};

/**
 * Puck waypoints for the events since the last state. O(E + P).
 *  pass / skate / anything else: straight from the old puck to the new one;
 *  shot that reaches the net (not blocked, not wide): old puck -> NET -> new puck (the rebound spot);
 *  PP goal: old puck -> NET (the state after it is the next faceoff, which is a different scene);
 *  clear: continue off the rink art on the line toward the faceoff centre the engine sends the puck to,
 *         then back to the new puck if the PP got it again.
 */
export function buildPuckPath(from: Vec2, to: Vec2, events: readonly RunEvent[]): Result<Vec2[]> {
  if (!isFiniteVec(from) || !isFiniteVec(to)) return err("non-finite puck position");
  const type = callType(events);
  const isShot = type === "shoot" || type === "set_play";
  const blocked = events.some((e) => e.kind === "draw:block" && e.detail?.hit === true);
  const wide = events.some((e) => e.kind === "miss");
  const ppGoal = events.some((e) => e.kind === "goal" && e.detail?.side === "pp");
  const cleared = events.some((e) => e.kind === "clear");

  const pts: Vec2[] = [from];
  const push = (p: Vec2): void => {
    const last = pts[pts.length - 1] ?? from;
    if (dist(last, p) > SAME_POINT_FT) pts.push(p);
  };

  if (ppGoal) {
    push({ x: NET.x, y: NET.y });
  } else {
    if (isShot && !blocked && !wide) push({ x: NET.x, y: NET.y });
    if (cleared) {
      const last = pts[pts.length - 1] ?? from;
      push(clipToArt(last, FACEOFF_DOTS.centre));
    }
    push(to);
  }
  if (pts.length === 1) pts.push({ x: from.x, y: from.y });
  return ok(pts);
}

// ---------------------------------------------------------------- skaters

const spotVec = (p: PpSpot): Vec2 => OZ_SPOTS[p.spot];

/** O(S^2) for S <= 6. Position of every skater in `next` at fraction `t`; skaters new to the ice are just there. */
export function ppAt(prev: readonly PpSpot[], next: readonly PpSpot[], t: number): { id: number; pos: Vec2 }[] {
  const x = clamp01(t);
  return next.map((n) => {
    const before = prev.find((p) => p.id === n.id);
    const to = spotVec(n);
    return { id: n.id, pos: before === undefined ? to : lerpVec(spotVec(before), to, x) };
  });
}

/** O(D). PK skaters carry no id: match by index; extras on either side are not interpolated. */
export function pkAt(prev: readonly Vec2[], next: readonly Vec2[], t: number): Vec2[] {
  const x = clamp01(t);
  return next.map((n, i) => {
    const before = prev[i];
    return before === undefined ? n : lerpVec(before, n, x);
  });
}

/** Largest straight-line move (ft) of any skater between two states. O(S^2 + D). */
export function maxSkaterMoveFt(
  prevPp: readonly PpSpot[], nextPp: readonly PpSpot[], prevPk: readonly Vec2[], nextPk: readonly Vec2[],
): number {
  let m = 0;
  for (const n of nextPp) {
    const before = prevPp.find((p) => p.id === n.id);
    if (before !== undefined) m = Math.max(m, dist(spotVec(before), spotVec(n)));
  }
  nextPk.forEach((n, i) => {
    const before = prevPk[i];
    if (before !== undefined) m = Math.max(m, dist(before, n));
  });
  return m;
}

/** MIN..MAX ms, growing with the longest thing that moves. O(1). */
export function durationMs(longestMoveFt: number): number {
  const ft = Number.isFinite(longestMoveFt) ? Math.max(0, longestMoveFt) : 0;
  return Math.round(Math.min(ANIM_MAX_MS, Math.max(ANIM_MIN_MS, ANIM_MIN_MS + ft * ANIM_MS_PER_FT)));
}

// ---------------------------------------------------------------- memory <-> new state

const eventKey = (e: RunEvent | undefined): string | null => (e === undefined ? null : `${e.i}|${e.kind}|${e.atS}`);

/** O(1). Remember a state for the next `planMotion`. */
export function toMemo(s: RinkSnapshot, nowMs: number): RinkMemo {
  const log = s.log ?? [];
  return {
    puck: s.puck,
    pkPos: s.pkPos,
    ppSpots: s.ppSpots,
    carrier: s.carrier,
    logLength: log.length,
    firstKey: eventKey(log[0]),
    lastKey: eventKey(log[log.length - 1]),
    atMs: nowMs,
  };
}

/** O(1). True when `next`'s log extends the log the memo saw: the same run, later. */
export function isContinuation(memo: RinkMemo, next: RinkSnapshot): boolean {
  const log = next.log;
  if (log === undefined || log.length <= memo.logLength) return false;
  if (memo.logLength === 0) return true;
  return eventKey(log[0]) === memo.firstKey && eventKey(log[memo.logLength - 1]) === memo.lastKey;
}

/**
 * How to animate from what the rink last drew to `next`, or ok(null) for "just show it" (first draw, stale
 * memory, a different run, the same state again, reduced motion, or nothing moved). O(E + S^2 + D).
 */
export function planMotion(
  memo: RinkMemo | null, next: RinkSnapshot, nowMs: number, reducedMotion: boolean,
): Result<MotionPlan | null> {
  if (reducedMotion || memo === null || next.log === undefined) return ok(null);
  if (!Number.isFinite(nowMs) || nowMs - memo.atMs > MEMO_STALE_MS || nowMs < memo.atMs) return ok(null);
  if (!isContinuation(memo, next)) return ok(null);

  const path = buildPuckPath(memo.puck, next.puck, next.log.slice(memo.logLength));
  if (!path.ok) return path;
  const skaterMove = maxSkaterMoveFt(memo.ppSpots, next.ppSpots, memo.pkPos, next.pkPos);
  const puckMove = pathLength(path.value);
  if (skaterMove <= SAME_POINT_FT && puckMove <= SAME_POINT_FT) return ok(null);

  return ok({
    puckPath: path.value,
    prevPpSpots: memo.ppSpots,
    prevPkPos: memo.pkPos,
    prevPuckHeld: memo.carrier.kind === "pp",
    nextPuckHeld: next.carrier.kind === "pp",
    durationMs: durationMs(Math.max(skaterMove, puckMove)),
  });
}
