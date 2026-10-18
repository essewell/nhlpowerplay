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

export type ScheduleRow = { date: string; scenario_id: string };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** FNV-1a 32-bit. O(n) in string length. */
export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 PRNG: small, fast, deterministic across JS engines. Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Daily scenario for a YYYY-MM-DD date (date already resolved in the app's rollover time zone). O(S). */
export function dailyScenario(date: string, schedule: ScheduleRow[], pool: string[]): Result<string> {
  if (!ISO_DATE.test(date)) return { ok: false, error: `bad date ${date}` };
  const hit = schedule.find((r) => r.date === date);
  if (hit) return { ok: true, value: hit.scenario_id };
  if (pool.length === 0) return { ok: false, error: "empty scenario pool" };
  const sorted = [...pool].sort();           // order-independent of export order
  return { ok: true, value: sorted[fnv1a(date) % sorted.length] };
}

/** Endless mode: Fisher-Yates shuffle once (O(n)), then O(1) per next(); reshuffles after a full pass. */
export class EndlessQueue {
  private order: string[] = [];
  private i = 0;
  private readonly rand: () => number;
  private readonly pool: string[];

  constructor(pool: string[], seed: number) {
    if (pool.length === 0) throw new RangeError("EndlessQueue needs a non-empty pool");
    this.pool = [...new Set(pool)].sort();
    this.rand = mulberry32(seed);
    this.reshuffle();
  }

  private reshuffle(): void {
    this.order = [...this.pool];
    for (let k = this.order.length - 1; k > 0; k--) {
      const j = Math.floor(this.rand() * (k + 1));
      [this.order[k], this.order[j]] = [this.order[j], this.order[k]];
    }
    this.i = 0;
  }

  next(): string {
    if (this.i >= this.order.length) this.reshuffle();
    return this.order[this.i++];
  }

  get size(): number {
    return this.pool.length;
  }
}
