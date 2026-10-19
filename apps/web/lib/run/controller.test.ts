import { test } from "node:test";
import assert from "node:assert/strict";
import type { Call } from "@powerplay/engine/sim-types.ts";
import { replay } from "@powerplay/engine/sim.ts";
import type { Loadable, Mode, RunSnapshot } from "../contracts.ts";
import { TEST_BASE, fixtureSource, firstOption, makeFiles, SCENARIO_A, SCENARIO_B, type FileMap } from "../testing/fixtures.ts";
import { RunController, type ControllerDeps } from "./controller.ts";
import { HostRunner, type FromHost } from "./host.ts";
import { readRun, STORAGE_KEYS, writeRun } from "./persistence.ts";
import type { PlanOpts } from "./plan.ts";
import { createMemoryStore, createStore, type KeyValueStore } from "./store.ts";
import { InlineTransport, type Transport } from "./transport.ts";

const TICK_LIMIT = 50;

function deps(opts: { files?: FileMap; store?: KeyValueStore; today?: () => string; transports?: Transport[] } = {}): ControllerDeps {
  const source = fixtureSource(opts.files ?? makeFiles());
  return {
    store: opts.store ?? createMemoryStore(),
    source,
    today: opts.today ?? (() => "2099-01-01"),
    newSeed: () => 5150,
    dataBase: TEST_BASE,
    makeTransport: () => {
      const t = new InlineTransport(source);
      opts.transports?.push(t);
      return t;
    },
  };
}

/** Resolve with the first state satisfying `pred` (checks the current state first). */
function until(ctl: RunController, pred: (s: Loadable<RunSnapshot>) => boolean): Promise<Loadable<RunSnapshot>> {
  return new Promise((resolve, reject) => {
    if (pred(ctl.getSnapshot())) return resolve(ctl.getSnapshot());
    const timer = setTimeout(() => reject(new Error(`timeout; state ${JSON.stringify(ctl.getSnapshot()).slice(0, 200)}`)), 5000);
    const off = ctl.subscribe((s) => {
      if (pred(s)) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });
}

const isReady = (s: Loadable<RunSnapshot>): s is { status: "ready"; value: RunSnapshot } => s.status === "ready";
const settled = (s: Loadable<RunSnapshot>): boolean => isReady(s) && !s.value.busy;

async function snap(ctl: RunController, pred: (s: RunSnapshot) => boolean = () => true): Promise<RunSnapshot> {
  const s = await until(ctl, (x) => settled(x) && pred((x as { value: RunSnapshot }).value));
  if (!isReady(s)) throw new Error("not ready");
  return s.value;
}

async function open(d: ControllerDeps, mode: Mode = "daily", id: string | null = null, o: PlanOpts = {}): Promise<RunController> {
  const ctl = new RunController(d, mode, id, o);
  await ctl.init();
  await snap(ctl);
  return ctl;
}

/** Play with `firstOption` until `calls` calls were made or the run ends. */
async function play(ctl: RunController, maxCalls: number): Promise<RunSnapshot> {
  for (let i = 0; i < TICK_LIMIT; i++) {
    let s = await snap(ctl);
    if (s.machineState === "intro") {
      ctl.controls.start();
      s = await snap(ctl, (x) => x.machineState !== "intro");
    }
    if (s.machineState === "celebrating") {
      ctl.controls.continue();
      s = await snap(ctl, (x) => x.machineState !== "celebrating");
    }
    if (s.machineState === "ended" || s.calls.length >= maxCalls) return s;
    const before = s.calls.length;
    ctl.controls.call(firstOption(s.options));
    await snap(ctl, (x) => x.calls.length > before || x.machineState === "error");
  }
  throw new Error("run did not finish within the tick limit");
}

test("controller: a Daily plays start to finish and is saved as ended", async () => {
  const d = deps();
  const ctl = await open(d);
  const end = await play(ctl, Infinity);
  assert.equal(end.machineState, "ended");
  assert.equal(end.mode, "daily");
  assert.equal(end.date, "2099-01-01");
  assert.ok(end.calls.length > 0);
  const saved = readRun(d.store, "daily");
  assert.ok(saved.ok && saved.value !== null);
  assert.equal(saved.value.ended, true);
  assert.equal(saved.value.calls.length, end.calls.length);
  assert.equal(saved.value.seed, end.input.seed);
  ctl.dispose();
});

test("controller edge: resume after a reload equals the uninterrupted run (determinism)", async () => {
  const straight = await open(deps());
  const full = await play(straight, Infinity);
  straight.dispose();
  assert.ok(full.calls.length >= 2, "need at least two calls to interrupt in the middle");

  const store = createMemoryStore();
  const first = await open(deps({ store }));
  const midway = await play(first, 1);
  assert.equal(midway.calls.length, 1);
  first.dispose(); // "reload"
  const second = await open(deps({ store }));
  const resumed = await snap(second);
  assert.equal(resumed.calls.length, 1, "resumed with the saved call, no intro");
  assert.notEqual(resumed.machineState, "intro");
  assert.deepEqual(resumed.state, midway.state, "replayed state equals the live state");
  const finished = await play(second, Infinity);
  assert.deepEqual(finished.calls, full.calls);
  assert.deepEqual(finished.state, full.state);
  second.dispose();
});

test("controller edge: a double tap records exactly one call (edge 9)", async () => {
  const ctl = await open(deps());
  ctl.controls.start();
  const s = await snap(ctl, (x) => x.machineState !== "intro");
  const c = firstOption(s.options);
  ctl.controls.call(c);
  ctl.controls.call(c); // same frame
  const busy = ctl.getSnapshot();
  assert.ok(isReady(busy) && busy.value.busy, "busy is set synchronously");
  const after = await snap(ctl, (x) => x.calls.length === 1);
  await new Promise((r) => setTimeout(r, 20));
  const final = ctl.getSnapshot();
  assert.ok(isReady(final));
  assert.equal(final.value.calls.length, 1);
  assert.equal(after.busy, false);
  ctl.dispose();
});

test("controller edge: the host itself ignores a repeated callIndex", async () => {
  const source = fixtureSource();
  const out: FromHost[] = [];
  const runner = new HostRunner(() => source, (m) => out.push(m));
  runner.receive({ type: "init", init: { mode: "daily", date: "2099-01-01", scenarioId: SCENARIO_A, seed: null, formation: "umbrella", calls: [], dataBase: TEST_BASE } });
  await new Promise((r) => setTimeout(r, 50));
  runner.receive({ type: "start" });
  await new Promise((r) => setTimeout(r, 20));
  const last = (): RunSnapshot => {
    const m = [...out].reverse().find((x) => x.type === "snapshot");
    if (m === undefined || m.type !== "snapshot") throw new Error("no snapshot");
    return m.snapshot;
  };
  const call = firstOption(last().options);
  runner.receive({ type: "call", call, callIndex: 0 });
  runner.receive({ type: "call", call, callIndex: 0 });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(last().calls.length, 1);
  assert.equal(last().error, null);
  assert.equal(last().busy, false);
  runner.stop();
});

test("controller edge: a Daily that ended cannot be played again that day", async () => {
  const store = createMemoryStore();
  const first = await open(deps({ store }));
  const end = await play(first, Infinity);
  first.dispose();
  const before = store.get(STORAGE_KEYS.run("daily"));

  const again = await open(deps({ store }));
  const s = await snap(again);
  assert.equal(s.machineState, "ended", "shows the finished run");
  assert.deepEqual(s.calls, end.calls);
  again.controls.start();
  again.controls.call({ type: "pass", to: 1 });
  again.controls.playAgain();
  await new Promise((r) => setTimeout(r, 30));
  const still = await snap(again);
  assert.equal(still.machineState, "ended");
  assert.equal(still.calls.length, end.calls.length);
  assert.equal(store.get(STORAGE_KEYS.run("daily")), before, "saved result untouched");
  again.dispose();
});

test("controller edge: a run started on D finishes on D's scenario after midnight (edge 7)", async () => {
  const store = createMemoryStore();
  const dayOne = await open(deps({ store, today: () => "2099-01-01" }));
  const mid = await play(dayOne, 1);
  assert.equal(mid.scenario.id, SCENARIO_A);
  dayOne.dispose();
  const dayTwo = await open(deps({ store, today: () => "2099-01-02" }));
  const resumed = await snap(dayTwo);
  assert.equal(resumed.scenario.id, SCENARIO_A, "not day two's scenario");
  assert.equal(resumed.date, "2099-01-01");
  const end = await play(dayTwo, Infinity);
  assert.equal(end.scenario.id, SCENARIO_A);
  assert.equal(end.date, "2099-01-01");
  dayTwo.dispose();
  // The next open on day two is a fresh Daily with day two's scenario.
  const fresh = await open(deps({ store, today: () => "2099-01-02" }));
  assert.equal((await snap(fresh)).scenario.id, SCENARIO_B);
  fresh.dispose();
});

test("controller edge: works with storage unavailable (resume within the session, no throw)", async () => {
  const store = createStore(() => {
    throw new Error("SecurityError: storage blocked");
  });
  const ctl = await open(deps({ store }));
  const mid = await play(ctl, 1);
  ctl.dispose();
  assert.equal(store.persistent, false);
  const again = await open(deps({ store }));
  const s = await snap(again);
  assert.equal(s.calls.length, mid.calls.length, "in-memory copy resumes it");
  const end = await play(again, Infinity);
  assert.equal(end.machineState, "ended");
  again.dispose();
});

test("controller edge: missing scenario file -> error state, no run saved", async () => {
  const files = makeFiles();
  files.delete(`scenarios/${SCENARIO_A}.json`);
  const d = deps({ files });
  const ctl = new RunController(d, "daily", null);
  await ctl.init();
  const s = await until(ctl, (x) => x.status === "error");
  assert.ok(s.status === "error" && /HTTP 404/.test(s.message));
  assert.deepEqual(readRun(d.store, "daily"), { ok: true, value: null });
  ctl.dispose();
});

test("controller edge: malformed scenario JSON -> error state, UI never gets a throw", async () => {
  const files = makeFiles();
  files.set(`scenarios/${SCENARIO_A}.json`, "{ nope");
  const ctl = new RunController(deps({ files }), "daily", null);
  await ctl.init();
  const s = await until(ctl, (x) => x.status === "error");
  assert.ok(s.status === "error" && /invalid JSON/.test(s.message));
  ctl.dispose();
});

test("controller edge: a save that no longer replays is discarded and the scenario starts fresh", async () => {
  const store = createMemoryStore();
  writeRun(store, {
    v: 1, mode: "daily", date: "2099-01-01", scenarioId: SCENARIO_A, seed: 12345,
    calls: [{ type: "pass", to: 424242 }], ended: false,
  });
  const ctl = await open(deps({ store }));
  const s = await snap(ctl);
  assert.equal(s.calls.length, 0);
  assert.equal(s.machineState, "intro");
  ctl.dispose();
});

test("controller edge: unreadable save JSON is discarded with a warning", async () => {
  const store = createMemoryStore();
  store.set(STORAGE_KEYS.run("daily"), "{{{");
  const ctl = await open(deps({ store }));
  assert.equal((await snap(ctl)).machineState, "intro");
  ctl.dispose();
});

test("controller edge: calls are ignored before start and for the wrong state; continue only celebrates", async () => {
  const ctl = await open(deps());
  const s = await snap(ctl);
  assert.equal(s.machineState, "intro");
  ctl.controls.call({ type: "pass", to: 9900002 });
  ctl.controls.continue();
  await new Promise((r) => setTimeout(r, 20));
  const after = await snap(ctl);
  assert.equal(after.calls.length, 0);
  assert.equal(after.machineState, "intro");
  assert.equal(after.busy, false);
  ctl.dispose();
});

test("controller edge: an illegal call comes back as an error state, busy clears", async () => {
  const ctl = await open(deps());
  ctl.controls.start();
  await snap(ctl, (x) => x.machineState !== "intro");
  ctl.controls.call({ type: "pass", to: 1 }); // nobody with id 1
  const s = await snap(ctl, (x) => x.machineState === "error" || x.calls.length > 0);
  assert.equal(s.busy, false);
  assert.equal(s.calls.length, 0, "the rejected call is not recorded");
  ctl.dispose();
});

test("controller: Endless moves to the next queued scenario on play again and resumes after reload", async () => {
  const store = createMemoryStore();
  const first = await open(deps({ store }), "endless");
  const a = await play(first, Infinity);
  assert.equal(a.machineState, "ended");
  assert.equal(a.date, null);
  first.controls.playAgain();
  const b = await snap(first, (x) => x.scenario.id !== a.scenario.id);
  assert.equal(b.machineState, "intro");
  assert.notEqual(b.input.seed, a.input.seed, "per-run seed differs");
  first.dispose();
  const reopened = await open(deps({ store }), "endless");
  const again = await snap(reopened);
  assert.equal(again.scenario.id, b.scenario.id, "reload resumes the current Endless run");
  reopened.dispose();
});

test("controller edge: Daily playAgain is a no-op; dispose drops late messages", async () => {
  const transports: Transport[] = [];
  const ctl = await open(deps({ transports }));
  ctl.controls.playAgain();
  assert.ok(isReady(ctl.getSnapshot()));
  ctl.controls.start();
  ctl.dispose();
  const frozen = ctl.getSnapshot();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ctl.getSnapshot(), frozen, "no updates after dispose");
});

test("controller: resumed state is exactly sim.replay of the saved key", async () => {
  const store = createMemoryStore();
  const ctl = await open(deps({ store }));
  const mid = await play(ctl, 2);
  ctl.dispose();
  const saved = readRun(store, "daily");
  assert.ok(saved.ok && saved.value !== null);
  const input = { ...mid.input, seed: saved.value.seed };
  const re = replay(input, saved.value.calls as Call[]);
  assert.ok(re.ok);
  assert.deepEqual(re.value, mid.state);
});
