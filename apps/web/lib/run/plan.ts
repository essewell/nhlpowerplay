/**
 * Decides WHAT run to show before anything is simulated: resume the stored one, show the finished
 * Daily, or start a fresh scenario. Pure over its deps (store, data source, today, seed source), so
 * every rule below is unit-tested without a browser.
 *
 * Rules (docs/KICKOFF.md edge cases 6 and 7, docs/LAUNCH.md):
 *  - Daily, stored run unfinished: resume it on ITS date and scenario, even after midnight (edge 7).
 *    Exception: a run with zero calls from an earlier date was never played, so today's Daily replaces it.
 *  - Daily, stored run ended on today's date: show that result; no second attempt (edge 6).
 *  - Daily, otherwise: today's scenario (or the caller's, from getDaily), seed = the scenario's seed
 *    (identical for everyone).
 *  - Endless, stored run (ended or not) for the requested scenario (or any, when none requested): resume.
 *    Otherwise the next scenario from the stored EndlessQueue (random seed kept in storage).
 *  A fresh plan is written to storage at once (calls: []), so planning twice (React StrictMode, a
 *  reload on the intro screen) resumes the same scenario instead of skipping ahead in the queue.
 *
 * Main thread only. Cost: O(S + P log P) for a fresh pick (queue rebuild is O(served)), O(1) to resume.
 */
import { EndlessQueue, fnv1a } from "@powerplay/engine/modes.ts";
import { err, ok, type Result } from "@powerplay/engine/result.ts";
import type { Call } from "@powerplay/engine/sim-types.ts";
import type { Mode } from "../contracts.ts";
import { pickDaily } from "../daily.ts";
import type { DataSource } from "../data.ts";
import {
  clearRun, readQueue, readRun, writeQueue, writeRun, type QueueState, type StoredRun,
} from "./persistence.ts";
import type { KeyValueStore } from "./store.ts";

export interface RunPlan {
  mode: Mode;
  date: string | null;
  scenarioId: string;
  /** Run seed (RunInput.seed). null only if a caller builds a plan by hand; planRun always sets it. */
  seed: number | null;
  calls: Call[];
  /** The stored run already finished: show its final state, do not offer another attempt. */
  ended: boolean;
  resumed: boolean;
}

export interface PlanDeps {
  store: KeyValueStore;
  source: DataSource;
  /** Today in America/Vancouver (YYYY-MM-DD). */
  today: () => string;
  /** Random uint32 (crypto in the web layer, fixed in tests). */
  newSeed: () => number;
}

export interface PlanOpts {
  /** Daily: the date the caller resolved (from getDaily). Defaults to deps.today(). */
  date?: string;
  /** Skip the stored run (it failed to replay and was discarded). */
  ignoreStored?: boolean;
}

function planFromStored(s: StoredRun): RunPlan {
  return { mode: s.mode, date: s.date, scenarioId: s.scenarioId, seed: s.seed, calls: s.calls, ended: s.ended, resumed: true };
}

/** Stored run, or null. A corrupt value is reported with console.warn, discarded, and treated as absent. */
function loadStored(store: KeyValueStore, mode: Mode, ignore: boolean): StoredRun | null {
  if (ignore) return null;
  const r = readRun(store, mode);
  if (r.ok) return r.value;
  console.warn(`PowerPlay: discarding unreadable saved run: ${r.error}`);
  clearRun(store, mode);
  return null;
}

function persistFresh(store: KeyValueStore, plan: RunPlan): RunPlan {
  if (plan.seed !== null) {
    writeRun(store, {
      v: 1, mode: plan.mode, date: plan.date, scenarioId: plan.scenarioId, seed: plan.seed, calls: [], ended: false,
    });
  }
  return plan;
}

async function planDaily(requestedId: string | null, deps: PlanDeps, opts: PlanOpts): Promise<Result<RunPlan>> {
  const today = opts.date ?? deps.today();
  const stored = loadStored(deps.store, "daily", opts.ignoreStored === true);
  if (stored !== null) {
    const sameDay = stored.date === today;
    if (stored.ended && sameDay) return ok(planFromStored(stored));
    if (!stored.ended && (sameDay || stored.calls.length > 0)) return ok(planFromStored(stored));
  }
  let scenarioId = requestedId;
  if (scenarioId === null) {
    const bundle = await deps.source.bundle();
    if (!bundle.ok) return bundle;
    const pick = pickDaily(today, bundle.value.schedule, bundle.value.endlessIndex);
    if (!pick.ok) return pick;
    scenarioId = pick.value.scenarioId;
  }
  const sc = await deps.source.scenario(scenarioId);
  if (!sc.ok) return sc;
  return ok(persistFresh(deps.store, {
    mode: "daily", date: today, scenarioId, seed: sc.value.seed, calls: [], ended: false, resumed: false,
  }));
}

/** Next scenario id from the stored queue, advancing and saving the queue state. O(served + P log P). */
async function nextFromQueue(deps: PlanDeps): Promise<Result<{ id: string; runSeed: number }>> {
  const bundle = await deps.source.bundle();
  if (!bundle.ok) return bundle;
  const pool = [...bundle.value.endlessIndex];
  const q = readQueue(deps.store);
  if (!q.ok) console.warn(`PowerPlay: resetting unreadable endless queue: ${q.error}`);
  const state: QueueState = q.ok && q.value !== null ? q.value : { v: 1, seed: deps.newSeed(), served: 0 };
  const queue = EndlessQueue.create(pool, state.seed);
  if (!queue.ok) return queue;
  for (let i = 0; i < state.served; i++) {
    const skipped = queue.value.next();
    if (!skipped.ok) return skipped;
  }
  const id = queue.value.next();
  if (!id.ok) return id;
  writeQueue(deps.store, { v: 1, seed: state.seed, served: state.served + 1 });
  return ok({ id: id.value, runSeed: fnv1a(`${state.seed}:${state.served}`) });
}

async function planEndless(requestedId: string | null, deps: PlanDeps, opts: PlanOpts): Promise<Result<RunPlan>> {
  const stored = loadStored(deps.store, "endless", opts.ignoreStored === true);
  if (stored !== null && (requestedId === null || requestedId === stored.scenarioId)) {
    return ok(planFromStored(stored));
  }
  let scenarioId: string;
  let seed: number;
  if (requestedId !== null) {
    scenarioId = requestedId;
    seed = deps.newSeed();
  } else {
    const next = await nextFromQueue(deps);
    if (!next.ok) return next;
    scenarioId = next.value.id;
    seed = next.value.runSeed;
  }
  const sc = await deps.source.scenario(scenarioId);
  if (!sc.ok) return sc;
  return ok(persistFresh(deps.store, {
    mode: "endless", date: null, scenarioId, seed, calls: [], ended: false, resumed: false,
  }));
}

/** Resolve the run to show for `mode`. `requestedId` null means "whatever is due". */
export function planRun(mode: Mode, requestedId: string | null, deps: PlanDeps, opts: PlanOpts = {}): Promise<Result<RunPlan>> {
  if (mode === "daily") return planDaily(requestedId, deps, opts);
  if (mode === "endless") return planEndless(requestedId, deps, opts);
  return Promise.resolve(err(`unknown mode ${String(mode)}`));
}

/** Home-screen helper: has today's Daily been played, is a run waiting, or is it fresh? Reads storage only. */
export function dailyStatus(store: KeyValueStore, today: string): "fresh" | "resume" | "done" {
  const r = readRun(store, "daily");
  const stored = r.ok ? r.value : null;
  if (stored === null) return "fresh";
  if (stored.ended) return stored.date === today ? "done" : "fresh";
  return stored.date === today || stored.calls.length > 0 ? "resume" : "fresh";
}
