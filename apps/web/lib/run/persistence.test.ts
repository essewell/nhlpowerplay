import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clearRun, MAX_HISTORY_DATES, parseStoredRun, readDailyHistory, readQueue, readRun, recordDailyFinished, STORAGE_KEYS,
  writeQueue, writeRun, type StoredRun,
} from "./persistence.ts";
import { dailyStatus, planRun, type PlanDeps } from "./plan.ts";
import { createMemoryStore, createStore } from "./store.ts";
import { fixtureSource, SCENARIO_A, SCENARIO_B } from "../testing/fixtures.ts";

const run = (patch: Partial<StoredRun> = {}): StoredRun => ({
  v: 1, mode: "daily", date: "2099-01-01", scenarioId: SCENARIO_A, seed: 12345,
  calls: [{ type: "pass", to: 9900002 }], ended: false, ...patch,
});

test("persistence: write then read round-trips a run; clear removes it", () => {
  const store = createMemoryStore();
  assert.deepEqual(readRun(store, "daily"), { ok: true, value: null });
  assert.equal(writeRun(store, run()), false, "memory store reports not persistent but keeps the value");
  const back = readRun(store, "daily");
  assert.ok(back.ok);
  assert.deepEqual(back.value, run());
  clearRun(store, "daily");
  assert.deepEqual(readRun(store, "daily"), { ok: true, value: null });
});

test("persistence edge: modes use separate keys", () => {
  const store = createMemoryStore();
  writeRun(store, run());
  writeRun(store, run({ mode: "endless", date: null, scenarioId: SCENARIO_B }));
  const d = readRun(store, "daily");
  const e = readRun(store, "endless");
  assert.ok(d.ok && e.ok);
  assert.equal(d.value?.scenarioId, SCENARIO_A);
  assert.equal(e.value?.scenarioId, SCENARIO_B);
});

test("persistence edge: storage unavailable (getter throws) still works in-session and never throws", () => {
  const store = createStore(() => {
    throw new Error("SecurityError");
  });
  assert.equal(store.get("k"), null);
  assert.equal(store.set("k", "v"), false);
  assert.equal(store.persistent, false);
  assert.equal(store.get("k"), "v", "latest write readable from memory");
  store.remove("k");
  assert.equal(store.get("k"), null);
});

test("persistence edge: storage methods throw (quota / blocked) -> no throw, memory keeps the value", () => {
  const backing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  const store = createStore(() => backing);
  assert.equal(store.get("a"), null);
  assert.equal(store.set("a", "1"), false);
  assert.equal(store.get("a"), "1");
  store.remove("a");
  assert.equal(store.get("a"), null, "tombstone beats a stale persisted value");
});

test("persistence edge: a failed removeItem cannot resurrect the old value", () => {
  const data = new Map<string, string>([["k", "old"]]);
  const store = createStore(() => ({
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: () => {
      throw new Error("blocked");
    },
  }));
  assert.equal(store.get("k"), "old");
  store.remove("k");
  assert.equal(store.get("k"), null);
});

test("persistence edge: corrupt values are explicit errors, not defaults", () => {
  const store = createMemoryStore();
  store.set(STORAGE_KEYS.run("daily"), "{ broken");
  const bad = readRun(store, "daily");
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /invalid JSON/);
  const cases: [string, unknown][] = [
    ["not an object", 5],
    ["version", { ...run(), v: 2 }],
    ["wrong mode", { ...run(), mode: "endless" }],
    ["bad date", { ...run(), date: "2099-13-40" }],
    ["daily without date", { ...run(), date: null }],
    ["bad scenario id", { ...run(), scenarioId: "../x" }],
    ["bad seed", { ...run(), seed: -1 }],
    ["fractional seed", { ...run(), seed: 1.5 }],
    ["bad calls", { ...run(), calls: "nope" }],
    ["unknown call type", { ...run(), calls: [{ type: "teleport" }] }],
    ["missing ended", { ...run(), ended: undefined }],
  ];
  for (const [name, value] of cases) assert.equal(parseStoredRun(value, "daily").ok, false, name);
});

test("persistence: endless queue state round-trips and rejects corrupt counts", () => {
  const store = createMemoryStore();
  assert.deepEqual(readQueue(store), { ok: true, value: null });
  writeQueue(store, { v: 1, seed: 99, served: 3 });
  assert.deepEqual(readQueue(store), { ok: true, value: { v: 1, seed: 99, served: 3 } });
  store.set(STORAGE_KEYS.queue, JSON.stringify({ v: 1, seed: 99, served: -2 }));
  assert.equal(readQueue(store).ok, false);
  store.set(STORAGE_KEYS.queue, JSON.stringify({ v: 1, seed: 99, served: 1e12 }));
  assert.equal(readQueue(store).ok, false);
});

function planDeps(today: string, store = createMemoryStore()): PlanDeps {
  return { store, source: fixtureSource(), today: () => today, newSeed: () => 1111 };
}

test("plan: fresh Daily uses the schedule, the scenario's seed, and saves a zero-call run", async () => {
  const deps = planDeps("2099-01-02");
  const p = await planRun("daily", null, deps);
  assert.ok(p.ok);
  assert.equal(p.value.scenarioId, SCENARIO_B);
  assert.equal(p.value.seed, 777);
  assert.equal(p.value.resumed, false);
  const saved = readRun(deps.store, "daily");
  assert.ok(saved.ok);
  assert.equal(saved.value?.calls.length, 0);
  const again = await planRun("daily", null, deps);
  assert.ok(again.ok);
  assert.equal(again.value.resumed, true, "planning twice resumes instead of re-picking");
});

test("plan edge: a never-played Daily from an earlier date is replaced by today's", async () => {
  const store = createMemoryStore();
  await planRun("daily", null, planDeps("2099-01-01", store));
  const p = await planRun("daily", null, planDeps("2099-01-02", store));
  assert.ok(p.ok);
  assert.equal(p.value.scenarioId, SCENARIO_B);
  assert.equal(p.value.date, "2099-01-02");
});

test("plan edge: an unfinished earlier-date Daily with calls resumes on ITS scenario (edge 7)", async () => {
  const store = createMemoryStore();
  writeRun(store, run({ date: "2099-01-01", scenarioId: SCENARIO_A }));
  const p = await planRun("daily", null, planDeps("2099-01-02", store));
  assert.ok(p.ok);
  assert.equal(p.value.scenarioId, SCENARIO_A);
  assert.equal(p.value.date, "2099-01-01");
  assert.equal(p.value.resumed, true);
});

test("plan edge: ended Daily blocks a second attempt that day, but not the next day", async () => {
  const store = createMemoryStore();
  writeRun(store, run({ date: "2099-01-01", ended: true }));
  assert.equal(dailyStatus(store, "2099-01-01"), "done");
  const same = await planRun("daily", null, planDeps("2099-01-01", store));
  assert.ok(same.ok);
  assert.equal(same.value.ended, true);
  assert.equal(same.value.calls.length, 1);
  assert.equal(dailyStatus(store, "2099-01-02"), "fresh");
  const next = await planRun("daily", null, planDeps("2099-01-02", store));
  assert.ok(next.ok);
  assert.equal(next.value.ended, false);
  assert.equal(next.value.scenarioId, SCENARIO_B);
});

test("plan edge: dailyStatus reports resume for unfinished runs and tolerates garbage", () => {
  const store = createMemoryStore();
  assert.equal(dailyStatus(store, "2099-01-01"), "fresh");
  writeRun(store, run());
  assert.equal(dailyStatus(store, "2099-01-01"), "resume");
  store.set(STORAGE_KEYS.run("daily"), "garbage");
  assert.equal(dailyStatus(store, "2099-01-01"), "fresh");
});

test("plan edge: missing scenario file is an error, nothing is saved", async () => {
  const deps = planDeps("2099-01-02");
  const files = new Map<string, string>();
  const empty = { ...deps, source: fixtureSource(files) };
  const p = await planRun("daily", SCENARIO_A, empty);
  assert.equal(p.ok, false);
  assert.deepEqual(readRun(deps.store, "daily"), { ok: true, value: null });
});

test("plan: Endless walks the seeded queue without repeats and persists its position", async () => {
  const store = createMemoryStore();
  const seen: string[] = [];
  for (let i = 0; i < 3; i++) {
    const p = await planRun("endless", null, planDeps("2099-01-01", store));
    assert.ok(p.ok);
    seen.push(p.value.scenarioId);
    clearRun(store, "endless"); // as playAgain does
  }
  assert.equal(new Set(seen).size, 3, "no repeats until the pool is exhausted");
  const q = readQueue(store);
  assert.ok(q.ok);
  assert.equal(q.value?.served, 3);
  assert.equal(q.value?.seed, 1111);
});

test("plan edge: a corrupt queue is reset with a warning, not a crash", async () => {
  const store = createMemoryStore();
  store.set(STORAGE_KEYS.queue, "{{");
  const p = await planRun("endless", null, planDeps("2099-01-01", store));
  assert.ok(p.ok);
});

test("history: ending a Daily records its date once; unfinished and Endless runs record nothing", () => {
  const store = createMemoryStore();
  writeRun(store, run({ ended: false }));
  writeRun(store, run({ mode: "endless", date: null, ended: true }));
  assert.deepEqual(readDailyHistory(store), { ok: true, value: [] });
  writeRun(store, run({ date: "2024-05-02", ended: true }));
  writeRun(store, run({ date: "2024-05-02", ended: true }));
  assert.deepEqual(readDailyHistory(store), { ok: true, value: ["2024-05-02"] });
});

test("history edge: dates come back sorted and deduplicated", () => {
  const store = createMemoryStore();
  for (const d of ["2024-05-03", "2024-05-01", "2024-05-02", "2024-05-01"]) recordDailyFinished(store, d);
  assert.deepEqual(readDailyHistory(store), { ok: true, value: ["2024-05-01", "2024-05-02", "2024-05-03"] });
});

test("history edge: capped at the newest MAX_HISTORY_DATES", () => {
  const store = createMemoryStore();
  const base = Date.UTC(2020, 0, 1);
  const total = MAX_HISTORY_DATES + 5;
  for (let i = 0; i < total; i++) recordDailyFinished(store, new Date(base + i * 86_400_000).toISOString().slice(0, 10));
  const h = readDailyHistory(store);
  assert.ok(h.ok);
  assert.equal(h.value.length, MAX_HISTORY_DATES);
  assert.equal(h.value[h.value.length - 1], new Date(base + (total - 1) * 86_400_000).toISOString().slice(0, 10));
});

test("history edge: storage unavailable never throws and still works in-session", () => {
  const store = createStore(() => {
    throw new Error("SecurityError");
  });
  assert.equal(recordDailyFinished(store, "2024-05-02"), false);
  assert.deepEqual(readDailyHistory(store), { ok: true, value: ["2024-05-02"] });
});

test("history edge: corrupt stored value is an Err on read and is replaced on the next record", () => {
  const store = createMemoryStore();
  store.set(STORAGE_KEYS.history, "{not json");
  assert.equal(readDailyHistory(store).ok, false);
  store.set(STORAGE_KEYS.history, JSON.stringify(["2024-05-02", 7]));
  assert.equal(readDailyHistory(store).ok, false);
  store.set(STORAGE_KEYS.history, JSON.stringify({ a: 1 }));
  assert.equal(readDailyHistory(store).ok, false);
  assert.equal(recordDailyFinished(store, "2024-05-03"), false);
  assert.deepEqual(readDailyHistory(store), { ok: true, value: ["2024-05-03"] });
});

test("history edge: a malformed date is refused", () => {
  const store = createMemoryStore();
  assert.equal(recordDailyFinished(store, "2024-13-40"), false);
  assert.deepEqual(readDailyHistory(store), { ok: true, value: [] });
});
