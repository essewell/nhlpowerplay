/**
 * Game modes.
 *  - Daily: one scenario per calendar date, identical for every player. Taken from the
 *    exported schedule; if the date is past the schedule's end, a deterministic pick by
 *    date hash keeps it identical for everyone.
 *  - Endless: random real scenarios, no repeats until the pool is exhausted, reproducible
 *    from a seed (so a run can be replayed and scored server-side).
 *
 * Pure / instance-scoped state only; one EndlessQueue per run (not shared across threads).
 */
import { err, ok, type Result } from "./result.ts";

export type { Result } from "./result.ts";
export type ScheduleRow = { date: string; scenario_id: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UINT32_RANGE = 4294967296; // 2^32: maps a uint32 to [0, 1)

/** FNV-1a 32-bit. O(n) in string length. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * One mulberry32 step on a plain uint32 state, so run state can store the PRNG as a number.
 * Returns [uint32 output, next state]. Integer-only: identical on every JS engine. O(1).
 */
export function prngNext(state: number): readonly [number, number] {
  const next = (state + 0x6d2b79f5) >>> 0;
  let t = next;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [(t ^ (t >>> 14)) >>> 0, next];
}

/** mulberry32 PRNG over prngNext. Returns floats in [0, 1). O(1) per draw. */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    const [u, next] = prngNext(s);
    s = next;
    return u / UINT32_RANGE;
  };
}

/** Daily scenario for a YYYY-MM-DD date (date already resolved in the app's rollover time zone). O(S + P log P). */
export function dailyScenario(date: string, schedule: ScheduleRow[], pool: string[]): Result<string> {
  if (!ISO_DATE.test(date)) return err(`bad date ${date}`);
  const hit = schedule.find((r) => r.date === date);
  if (hit) return ok(hit.scenario_id);
  if (pool.length === 0) return err("empty scenario pool");
  const sorted = [...pool].sort();           // order-independent of export order
  const pick = sorted[fnv1a(date) % sorted.length];
  return pick === undefined ? err("daily pick out of range") : ok(pick);
}

/** Endless mode: Fisher-Yates shuffle once (O(n)), then O(1) per next(); reshuffles after a full pass. */
export class EndlessQueue {
  private order: string[] = [];
  private i = 0;
  private readonly rand: () => number;
  private readonly pool: string[];

  private constructor(pool: string[], seed: number) {
    this.pool = [...new Set(pool)].sort();
    this.rand = mulberry32(seed);
    this.reshuffle();
  }

  /** O(n log n) for the dedupe sort. */
  static create(pool: string[], seed: number): Result<EndlessQueue> {
    if (pool.length === 0) return err("EndlessQueue needs a non-empty pool");
    if (!Number.isInteger(seed)) return err(`EndlessQueue seed must be an integer, got ${seed}`);
    return ok(new EndlessQueue(pool, seed));
  }

  private reshuffle(): void {
    const order = [...this.pool];
    for (let k = order.length - 1; k > 0; k--) {
      const j = Math.floor(this.rand() * (k + 1));
      const a = order[k], b = order[j];
      // Unreachable: 0 <= j <= k < length. The guard only satisfies noUncheckedIndexedAccess.
      if (a === undefined || b === undefined) continue;
      order[k] = b;
      order[j] = a;
    }
    this.order = order;
    this.i = 0;
  }

  next(): Result<string> {
    if (this.i >= this.order.length) this.reshuffle();
    const id = this.order[this.i];
    if (id === undefined) return err("EndlessQueue is empty");
    this.i++;
    return ok(id);
  }

  get size(): number {
    return this.pool.length;
  }
}
