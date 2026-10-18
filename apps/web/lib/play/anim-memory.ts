/**
 * What the rink drew last, kept outside React because PlayScreen remounts the rink after every call
 * (key = calls.length) and React StrictMode runs effects twice in dev.
 * Thread ownership: UI main thread only; module-level state, one rink on screen at a time.
 */
import { planMotion, toMemo, type MotionPlan, type RinkMemo, type RinkSnapshot } from "./anim.ts";
import type { Result } from "@powerplay/engine/result.ts";
import { ok } from "@powerplay/engine/result.ts";

/** A plan computed this recently for the same state is reused (StrictMode's second effect run). */
const PLAN_REUSE_MS = 1000;

let memo: RinkMemo | null = null;
let cached: { logLength: number; atMs: number; plan: MotionPlan | null } | null = null;

/**
 * Plan the motion into `next` and remember `next` as the new "previous". O(E + S^2 + D).
 * Asking again for the same state within PLAN_REUSE_MS returns the same plan instead of "nothing changed".
 */
export function advanceRink(next: RinkSnapshot, nowMs: number, reducedMotion: boolean): Result<MotionPlan | null> {
  const length = next.log?.length ?? 0;
  if (cached !== null && cached.logLength === length && nowMs >= cached.atMs && nowMs - cached.atMs <= PLAN_REUSE_MS) {
    return ok(reducedMotion ? null : cached.plan);
  }
  const planned = planMotion(memo, next, nowMs, reducedMotion);
  memo = toMemo(next, nowMs);
  cached = { logLength: length, atMs: nowMs, plan: planned.ok ? planned.value : null };
  return planned;
}

/** Forget everything (tests, and a run that is thrown away). */
export function resetRinkMemory(): void {
  memo = null;
  cached = null;
}
