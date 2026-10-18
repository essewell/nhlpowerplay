/**
 * Tests for modes.ts. Run from repo root: node --test packages/engine/src/modes.test.ts
 * All scenario ids, dates and pools below are SYNTHETIC test fixtures, not real games.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { dailyScenario, EndlessQueue, fnv1a, mulberry32, prngNext, type ScheduleRow } from "./modes.ts";

const U32_MAX = 4294967295;
const UINT32_RANGE = 4294967296;
const SYNTH_POOL = ["synth-a", "synth-b", "synth-c", "synth-d", "synth-e", "synth-f", "synth-g", "synth-h"];
const SYNTH_SCHEDULE: ScheduleRow[] = [
  { date: "2030-01-01", scenario_id: "synth-sched-1" },
  { date: "2030-01-02", scenario_id: "synth-sched-2" },
];

const isU32 = (n: number) => Number.isInteger(n) && n >= 0 && n <= U32_MAX;

function queue(pool: string[], seed: number): EndlessQueue {
  const r = EndlessQueue.create(pool, seed);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
}
function take(q: EndlessQueue, n: number): string[] {
  return Array.from({ length: n }, () => {
    const r = q.next();
    assert.ok(r.ok, r.ok ? "" : r.error);
    return r.value;
  });
}

// --- fnv1a ------------------------------------------------------------------------------------------
test("fnv1a happy path: matches published FNV-1a 32-bit vectors for ASCII", () => {
  assert.equal(fnv1a("a"), 0xe40c292c);
  assert.equal(fnv1a("foobar"), 0xbf9cf968);
});

test("fnv1a edge: empty string is the offset basis", () => {
  assert.equal(fnv1a(""), 0x811c9dc5);
});

test("fnv1a edge: pinned value for a date key (regression guard for Daily picks)", () => {
  assert.equal(fnv1a("2026-11-01"), 1897800060);
});

test("fnv1a edge: unicode (BMP and astral) hashes to stable uint32 values", () => {
  // Hashes UTF-16 code units, not UTF-8 bytes; values pinned from this implementation.
  assert.equal(fnv1a("é"), 1812687940);
  assert.equal(fnv1a("😀"), 3409036472);
  assert.ok(isU32(fnv1a("😀")));
});

test("fnv1a edge: output is always uint32, including long input", () => {
  for (const s of ["", "x", "x".repeat(100_000), "\u0000", "￿"]) assert.ok(isU32(fnv1a(s)), JSON.stringify(s.slice(0, 5)));
});

test("fnv1a edge: order- and case-sensitive", () => {
  assert.notEqual(fnv1a("ab"), fnv1a("ba"));
  assert.notEqual(fnv1a("a"), fnv1a("A"));
});

// --- prngNext ---------------------------------------------------------------------------------------
test("prngNext happy path: pure, returns [uint32, uint32]", () => {
  const a = prngNext(12345), b = prngNext(12345);
  assert.deepEqual(a, b);
  assert.ok(isU32(a[0]) && isU32(a[1]));
});

test("prngNext edge: seed 0 matches the reference mulberry32 first output", () => {
  const [u, next] = prngNext(0);
  assert.equal(u, 1144304738);
  assert.equal(next, 0x6d2b79f5);
});

test("prngNext edge: seed 2^32-1 wraps the state and stays uint32", () => {
  const [u, next] = prngNext(U32_MAX);
  assert.ok(isU32(u));
  assert.equal(next, (U32_MAX + 0x6d2b79f5) % UINT32_RANGE);
});

test("prngNext edge: chained 10k steps stay uint32 and do not get stuck", () => {
  let s = 0;
  const seen = new Set<number>();
  for (let i = 0; i < 10_000; i++) {
    const [u, next] = prngNext(s);
    assert.ok(isU32(u) && isU32(next));
    seen.add(u);
    s = next;
  }
  assert.ok(seen.size > 9_990);
});

test("prngNext edge: different states give different outputs", () => {
  assert.notEqual(prngNext(1)[0], prngNext(2)[0]);
  assert.notEqual(prngNext(0)[0], prngNext(U32_MAX)[0]);
});

// --- mulberry32 -------------------------------------------------------------------------------------
test("mulberry32 happy path: same seed -> identical sequences", () => {
  const r1 = mulberry32(42), r2 = mulberry32(42);
  assert.deepEqual(Array.from({ length: 500 }, r1), Array.from({ length: 500 }, r2));
});

test("mulberry32 edge: equals prngNext chain divided by 2^32", () => {
  const r = mulberry32(7);
  let s = 7;
  for (let i = 0; i < 100; i++) {
    const [u, next] = prngNext(s);
    s = next;
    assert.equal(r(), u / UINT32_RANGE);
  }
});

test("mulberry32 edge: outputs lie in [0, 1) for seeds 0 and 2^32-1", () => {
  for (const seed of [0, U32_MAX]) {
    const xs = Array.from({ length: 5_000 }, mulberry32(seed));
    assert.ok(xs.every((x) => x >= 0 && x < 1), `seed ${seed}`);
  }
});

test("mulberry32 edge: seed 0 first draw pinned", () => {
  assert.equal(mulberry32(0)(), 1144304738 / UINT32_RANGE);
});

test("mulberry32 edge: different seeds give different sequences", () => {
  assert.notDeepEqual(Array.from({ length: 10 }, mulberry32(1)), Array.from({ length: 10 }, mulberry32(2)));
  assert.notDeepEqual(Array.from({ length: 10 }, mulberry32(0)), Array.from({ length: 10 }, mulberry32(U32_MAX)));
});

test("mulberry32 edge: seeds are reduced mod 2^32 (-1 aliases 2^32-1)", () => {
  assert.deepEqual(Array.from({ length: 5 }, mulberry32(-1)), Array.from({ length: 5 }, mulberry32(U32_MAX)));
});

// --- dailyScenario ----------------------------------------------------------------------------------
test("dailyScenario happy path: schedule hit returns the scheduled id", () => {
  assert.deepEqual(dailyScenario("2030-01-02", SYNTH_SCHEDULE, SYNTH_POOL), { ok: true, value: "synth-sched-2" });
});

test("dailyScenario edge: schedule hit works even with an empty pool", () => {
  assert.deepEqual(dailyScenario("2030-01-01", SYNTH_SCHEDULE, []), { ok: true, value: "synth-sched-1" });
});

test("dailyScenario edge: malformed dates are rejected", () => {
  for (const d of ["", "2030-1-01", "30-01-01", "2030/01/01", "2030-01-01T00:00", " 2030-01-01", "2030-01-01\n"]) {
    assert.equal(dailyScenario(d, SYNTH_SCHEDULE, SYNTH_POOL).ok, false, JSON.stringify(d));
  }
});

test("dailyScenario edge: past schedule end with empty pool -> error", () => {
  assert.equal(dailyScenario("2031-06-01", SYNTH_SCHEDULE, []).ok, false);
});

test("dailyScenario edge: single-item pool always returns that item", () => {
  for (const d of ["2031-01-01", "2031-01-02", "2099-12-31"]) {
    assert.deepEqual(dailyScenario(d, [], ["synth-only"]), { ok: true, value: "synth-only" });
  }
});

test("dailyScenario edge: fallback picks from the pool, independent of pool order, and pinned", () => {
  const pick = dailyScenario("2026-11-01", [], SYNTH_POOL);
  assert.deepEqual(pick, dailyScenario("2026-11-01", [], [...SYNTH_POOL].reverse()));
  // sorted pool index = fnv1a("2026-11-01") % 8
  assert.deepEqual(pick, { ok: true, value: [...SYNTH_POOL].sort()[1897800060 % SYNTH_POOL.length] });
});

test("dailyScenario edge: first matching schedule row wins on duplicate dates", () => {
  const dup: ScheduleRow[] = [{ date: "2030-05-05", scenario_id: "first" }, { date: "2030-05-05", scenario_id: "second" }];
  assert.deepEqual(dailyScenario("2030-05-05", dup, SYNTH_POOL), { ok: true, value: "first" });
});

test("dailyScenario edge: fallback varies across dates (not a constant)", () => {
  const picks = new Set<string>();
  for (let day = 1; day <= 28; day++) {
    const r = dailyScenario(`2031-02-${String(day).padStart(2, "0")}`, [], SYNTH_POOL);
    assert.ok(r.ok && SYNTH_POOL.includes(r.value));
    picks.add(r.value);
  }
  assert.ok(picks.size > 1);
});

test("dailyScenario edge: does not mutate the pool", () => {
  const pool = ["synth-z", "synth-a", "synth-m"];
  dailyScenario("2031-01-01", [], pool);
  assert.deepEqual(pool, ["synth-z", "synth-a", "synth-m"]);
});

// --- EndlessQueue -----------------------------------------------------------------------------------
test("EndlessQueue happy path: one full pass is a permutation of the pool", () => {
  const q = queue(SYNTH_POOL, 42);
  assert.equal(q.size, SYNTH_POOL.length);
  assert.deepEqual([...take(q, SYNTH_POOL.length)].sort(), [...SYNTH_POOL].sort());
});

test("EndlessQueue.create edge: empty pool -> error", () => {
  assert.equal(EndlessQueue.create([], 1).ok, false);
});

test("EndlessQueue.create edge: non-integer seeds -> error", () => {
  for (const s of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.equal(EndlessQueue.create(SYNTH_POOL, s).ok, false, `seed ${s}`);
  }
});

test("EndlessQueue.create edge: seeds 0 and 2^32-1 are accepted", () => {
  assert.equal(take(queue(SYNTH_POOL, 0), 3).length, 3);
  assert.equal(take(queue(SYNTH_POOL, U32_MAX), 3).length, 3);
});

test("EndlessQueue edge: reshuffle after a full pass covers every item again (3 passes)", () => {
  const n = SYNTH_POOL.length, q = queue(SYNTH_POOL, 7);
  const all = take(q, n * 3);
  for (let p = 0; p < 3; p++) {
    assert.deepEqual(all.slice(p * n, (p + 1) * n).sort(), [...SYNTH_POOL].sort(), `pass ${p}`);
  }
});

test("EndlessQueue edge: single-item pool returns that item forever", () => {
  assert.deepEqual(take(queue(["synth-solo"], 3), 5), Array(5).fill("synth-solo"));
});

test("EndlessQueue edge: duplicates are removed before shuffling", () => {
  const q = queue(["synth-x", "synth-y", "synth-x", "synth-y", "synth-y"], 9);
  assert.equal(q.size, 2);
  assert.deepEqual(take(q, 2).sort(), ["synth-x", "synth-y"]);
  assert.equal(queue(["synth-x", "synth-x"], 1).size, 1);
});

test("EndlessQueue determinism: same pool + seed -> identical runs, regardless of pool order", () => {
  const a = take(queue(SYNTH_POOL, 123), 30);
  const b = take(queue([...SYNTH_POOL].reverse(), 123), 30);
  assert.deepEqual(a, b);
});

test("EndlessQueue edge: different seeds give different orders", () => {
  assert.notDeepEqual(take(queue(SYNTH_POOL, 1), SYNTH_POOL.length), take(queue(SYNTH_POOL, 2), SYNTH_POOL.length));
});

test("EndlessQueue edge: caller's pool array is not mutated", () => {
  const pool = ["synth-c", "synth-a", "synth-b", "synth-a"];
  take(queue(pool, 5), 10);
  assert.deepEqual(pool, ["synth-c", "synth-a", "synth-b", "synth-a"]);
});
