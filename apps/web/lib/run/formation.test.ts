/** Starting formation: persistence, planning and the controller (real engine, synthetic data). */
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Loadable, Mode, RunSnapshot } from "../contracts.ts";
import { TEST_BASE, fixtureSource, firstOption, makeFiles, SCENARIO_A } from "../testing/fixtures.ts";
import { RunController, type ControllerDeps } from "./controller.ts";
import {
  parseStoredRun, readFormationPref, readRun, setStoredFormation, STORAGE_KEYS, storedFormation, writeFormationPref,
  writeRun, type StoredRun,
} from "./persistence.ts";
import { planRun } from "./plan.ts";
import { createMemoryStore, createStore, type KeyValueStore } from "./store.ts";
import { InlineTransport } from "./transport.ts";

const run = (patch: Partial<StoredRun> = {}): StoredRun => ({
  v: 1, mode: "daily", date: "2099-01-01", scenarioId: SCENARIO_A, seed: 12345, calls: [], ended: false, ...patch,
});

// ---------------------------------------------------------------- persistence

test("formation: a stored run keeps its starting formation through write and read", () => {
  const store = createMemoryStore();
  writeRun(store, run({ formation: "overload" }));
  const back = readRun(store, "daily");
  assert.ok(back.ok && back.value !== null);
  assert.equal(storedFormation(back.value), "overload");
});

test("formation edge: an old run saved before formations existed replays with umbrella", () => {
  const old = { v: 1, mode: "daily", date: "2099-01-01", scenarioId: SCENARIO_A, seed: 1, calls: [], ended: false };
  const parsed = parseStoredRun(old, "daily");
  assert.ok(parsed.ok);
  assert.equal(parsed.value.formation, "umbrella");
  assert.equal(storedFormation({}), "umbrella");
});

test("formation edge: an unknown or non-string stored formation is a corrupt run, not a silent default", () => {
  for (const bad of ["box", 5, null, ""]) {
    assert.equal(parseStoredRun({ ...run(), formation: bad }, "daily").ok, false, String(bad));
  }
});

test("formation preference: per mode, default umbrella, junk ignored, survives a blocked store in-session", () => {
  const store = createMemoryStore();
  assert.equal(readFormationPref(store, "daily"), "umbrella");
  writeFormationPref(store, "daily", "spread");
  writeFormationPref(store, "endless", "one_three_one");
  assert.equal(readFormationPref(store, "daily"), "spread");
  assert.equal(readFormationPref(store, "endless"), "one_three_one");
  store.set(STORAGE_KEYS.formation("daily"), "not-a-formation");
  assert.equal(readFormationPref(store, "daily"), "umbrella");
  const blocked = createStore(() => {
    throw new Error("SecurityError");
  });
  assert.equal(writeFormationPref(blocked, "daily", "overload"), false);
  assert.equal(readFormationPref(blocked, "daily"), "overload");
});

test("formation: setStoredFormation changes a fresh run and remembers the choice", () => {
  const store = createMemoryStore();
  writeRun(store, run());
  assert.ok(setStoredFormation(store, "daily", "overload").ok);
  const back = readRun(store, "daily");
  assert.ok(back.ok && back.value !== null);
  assert.equal(back.value.formation, "overload");
  assert.equal(readFormationPref(store, "daily"), "overload");
});

test("formation edge: setStoredFormation refuses once a call exists, with no run, and on a corrupt save", () => {
  const store = createMemoryStore();
  assert.equal(setStoredFormation(store, "daily", "spread").ok, false, "no run");
  writeRun(store, run({ formation: "umbrella", calls: [{ type: "pass", to: 1 }] }));
  assert.equal(setStoredFormation(store, "daily", "spread").ok, false);
  const back = readRun(store, "daily");
  assert.ok(back.ok && back.value !== null);
  assert.equal(back.value.formation, "umbrella", "unchanged");
  assert.equal(readFormationPref(store, "daily"), "umbrella", "pref not touched by a refused change");
  store.set(STORAGE_KEYS.run("daily"), "{{{");
  assert.equal(setStoredFormation(store, "daily", "spread").ok, false);
});

// ---------------------------------------------------------------- planning

test("formation: a fresh plan starts with the mode's remembered formation and saves it; the Daily seed is unaffected", async () => {
  const plan = async (pref: "umbrella" | "spread") => {
    const store = createMemoryStore();
    writeFormationPref(store, "daily", pref);
    const p = await planRun("daily", null, { store, source: fixtureSource(), today: () => "2099-01-01", newSeed: () => 7 });
    assert.ok(p.ok);
    const saved = readRun(store, "daily");
    assert.ok(saved.ok);
    return { plan: p.value, saved: saved.value };
  };
  const a = await plan("umbrella");
  const b = await plan("spread");
  assert.equal(a.plan.formation, "umbrella");
  assert.equal(b.plan.formation, "spread");
  assert.equal(b.saved?.formation, "spread");
  assert.equal(a.plan.seed, b.plan.seed, "everyone gets the same Daily seed");
});

test("formation edge: resuming uses the stored formation, not the preference; an old save resumes with umbrella", async () => {
  const store = createMemoryStore();
  writeRun(store, run({ formation: "one_three_one" }));
  writeFormationPref(store, "daily", "spread");
  const deps = { store, source: fixtureSource(), today: () => "2099-01-01", newSeed: () => 7 };
  const resumed = await planRun("daily", null, deps);
  assert.ok(resumed.ok && resumed.value.resumed);
  assert.equal(resumed.value.formation, "one_three_one");
  const oldStore = createMemoryStore();
  oldStore.set(STORAGE_KEYS.run("daily"), JSON.stringify({
    v: 1, mode: "daily", date: "2099-01-01", scenarioId: SCENARIO_A, seed: 5, calls: [], ended: false,
  }));
  const old = await planRun("daily", null, { ...deps, store: oldStore });
  assert.ok(old.ok && old.value.resumed);
  assert.equal(old.value.formation, "umbrella");
});

// ---------------------------------------------------------------- controller

function deps(store: KeyValueStore = createMemoryStore()): ControllerDeps {
  const source = fixtureSource(makeFiles());
  return {
    store, source, today: () => "2099-01-01", newSeed: () => 5150, dataBase: TEST_BASE,
    makeTransport: () => new InlineTransport(source),
  };
}

const isReady = (s: Loadable<RunSnapshot>): s is { status: "ready"; value: RunSnapshot } => s.status === "ready";

function until(ctl: RunController, pred: (s: RunSnapshot) => boolean): Promise<RunSnapshot> {
  const test = (s: Loadable<RunSnapshot>): RunSnapshot | null => (isReady(s) && !s.value.busy && pred(s.value) ? s.value : null);
  return new Promise((resolve, reject) => {
    const now = test(ctl.getSnapshot());
    if (now !== null) return resolve(now);
    const timer = setTimeout(() => reject(new Error("timeout")), 5000);
    const off = ctl.subscribe((s) => {
      const hit = test(s);
      if (hit !== null) {
        clearTimeout(timer);
        off();
        resolve(hit);
      }
    });
  });
}

async function open(d: ControllerDeps, mode: Mode = "daily"): Promise<RunController> {
  const ctl = new RunController(d, mode, null);
  await ctl.init();
  await until(ctl, () => true);
  return ctl;
}

/** Start and make one call with the first option. */
async function playOne(ctl: RunController): Promise<RunSnapshot> {
  ctl.controls.start();
  const s = await until(ctl, (x) => x.machineState !== "intro");
  ctl.controls.call(firstOption(s.options));
  return until(ctl, (x) => x.calls.length === 1);
}

test("controller: the starting formation is chosen in the intro, saved with the run and played with", async () => {
  const d = deps();
  const ctl = await open(d);
  assert.equal((await until(ctl, () => true)).input.settings.formation, "umbrella");
  ctl.controls.setFormation("one_three_one");
  const chosen = await until(ctl, (x) => x.input.settings.formation === "one_three_one");
  assert.equal(chosen.machineState, "intro");
  const saved = readRun(d.store, "daily");
  assert.ok(saved.ok && saved.value !== null);
  assert.equal(saved.value.formation, "one_three_one");
  const mid = await playOne(ctl);
  assert.equal(mid.input.settings.formation, "one_three_one");
  const after = readRun(d.store, "daily");
  assert.ok(after.ok && after.value !== null);
  assert.equal(after.value.formation, "one_three_one");
  assert.equal(after.value.calls.length, 1);
  ctl.dispose();
});

test("controller edge: resume replays with the stored formation and equals the uninterrupted run", async () => {
  const store = createMemoryStore();
  const first = await open(deps(store));
  first.controls.setFormation("spread");
  await until(first, (x) => x.input.settings.formation === "spread");
  const mid = await playOne(first);
  first.dispose();
  const second = await open(deps(store));
  const resumed = await until(second, () => true);
  assert.equal(resumed.input.settings.formation, "spread");
  assert.deepEqual(resumed.state.log, mid.state.log, "same seed + formation + calls => identical run");
  second.dispose();
});

test("controller edge: the formation cannot change after START", async () => {
  const d = deps();
  const ctl = await open(d);
  ctl.controls.start();
  ctl.controls.setFormation("overload");
  const s = await until(ctl, (x) => x.machineState !== "intro");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(s.input.settings.formation, "umbrella");
  const saved = readRun(d.store, "daily");
  assert.ok(saved.ok);
  assert.equal(saved.value?.formation, "umbrella", "storage and play agree");
  ctl.dispose();
});

test("controller edge: the choice is remembered for the next Endless run; Daily keeps its own preference", async () => {
  const store = createMemoryStore();
  const ctl = await open(deps(store), "endless");
  ctl.controls.setFormation("one_three_one");
  await until(ctl, (x) => x.input.settings.formation === "one_three_one");
  ctl.controls.playAgain();
  const next = await until(ctl, (x) => x.machineState === "intro" && x.input.settings.formation === "one_three_one");
  assert.equal(next.mode, "endless");
  ctl.dispose();
  const daily = await open(deps(store), "daily");
  assert.equal((await until(daily, () => true)).input.settings.formation, "umbrella");
  daily.dispose();
});

test("controller edge: setFormation before the run is ready, or to the current one, does nothing", async () => {
  const d = deps();
  const ctl = new RunController(d, "daily", null);
  ctl.controls.setFormation("spread");
  await ctl.init();
  const s = await until(ctl, () => true);
  assert.equal(s.input.settings.formation, "umbrella");
  const before = d.store.get(STORAGE_KEYS.run("daily"));
  ctl.controls.setFormation("umbrella");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(d.store.get(STORAGE_KEYS.run("daily")), before);
  ctl.dispose();
});
