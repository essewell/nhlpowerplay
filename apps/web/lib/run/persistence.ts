/**
 * What is saved in localStorage for a run (v1 has no backend; docs/LAUNCH.md):
 *   powerplay.v1.run.daily    StoredRun   latest Daily run (its `ended` flag is the "already played" lock)
 *   powerplay.v1.run.endless  StoredRun   latest Endless run
 *   powerplay.v1.formation.<mode>  PpFormationName  last starting formation the player picked in that mode
 *   powerplay.v1.endless.queue  QueueState  seed + how many scenarios were served (rebuilds EndlessQueue)
 *   powerplay.v1.daily.history  string[]    dates (YYYY-MM-DD, America/Vancouver) of finished Dailies, for the streak
 * A StoredRun is the replay key: (scenarioId, seed, formation, calls) -> sim.replay gives the exact state.
 * `formation` is the STARTING formation (RunInput.settings.formation); a run saved before formations existed has none and
 * replays with umbrella, which is what it was played with.
 *
 * Reads validate shape and return Result (a corrupt value is an explicit error, never a silent
 * default). Main thread only. All O(size of the value).
 */
import { err, ok, type Result } from "@powerplay/engine/result.ts";
import { isCalendarDate } from "@powerplay/engine/schema.ts";
import type { Call, PpFormationName } from "@powerplay/engine/sim-types.ts";
import type { Mode } from "../contracts.ts";
import { DEFAULT_FORMATION, isFormationName } from "../play/formations.ts";
import type { KeyValueStore } from "./store.ts";

export const STORAGE_KEYS = {
  run: (mode: Mode): string => `powerplay.v1.run.${mode}`,
  formation: (mode: Mode): string => `powerplay.v1.formation.${mode}`,
  queue: "powerplay.v1.endless.queue",
  history: "powerplay.v1.daily.history",
} as const;

export interface StoredRun {
  v: 1;
  mode: Mode;
  /** Daily date the run started on (America/Vancouver); null for Endless. */
  date: string | null;
  scenarioId: string;
  seed: number;
  /** Starting formation. Absent in runs saved before formations existed: read it with `storedFormation`. */
  formation?: PpFormationName;
  calls: Call[];
  /** true once the run reached its end: for Daily this is the "no second attempt" lock and the result. */
  ended: boolean;
}

export interface QueueState { v: 1; seed: number; served: number }

const MAX_UINT32 = 0xffff_ffff;
const SCENARIO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const CALL_TYPES: ReadonlySet<string> = new Set([
  "pass", "skate", "shoot", "set_play", "faceoff", "zone_entry", "breakout",
]);
/** Upper bound on scenarios served from one queue seed; beyond this the value is treated as corrupt. */
const MAX_SERVED = 1_000_000;
/** Upper bound on stored calls (engine MAX_CALLS_PER_RUN is far lower); stops a corrupt value hanging a replay. */
const MAX_STORED_CALLS = 1_000;
/** Finished-Daily dates kept for the streak; ~13 months, far beyond any streak a player can hold in view. */
export const MAX_HISTORY_DATES = 400;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const isUint32 = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0 && x <= MAX_UINT32;

function parseJson(raw: string, label: string): Result<unknown> {
  try {
    return ok(JSON.parse(raw));
  } catch (e) {
    return err(`${label}: invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Shape check only; the engine validates call contents when it replays. O(calls). */
export function parseStoredRun(raw: unknown, mode: Mode): Result<StoredRun> {
  const label = STORAGE_KEYS.run(mode);
  if (!isRecord(raw)) return err(`${label}: not an object`);
  if (raw.v !== 1) return err(`${label}: unsupported version ${String(raw.v)}`);
  if (raw.mode !== mode) return err(`${label}: mode is ${String(raw.mode)}`);
  const date = raw.date;
  if (date !== null && !(typeof date === "string" && isCalendarDate(date))) return err(`${label}: bad date`);
  if (mode === "daily" && date === null) return err(`${label}: a daily run needs a date`);
  if (typeof raw.scenarioId !== "string" || !SCENARIO_ID_RE.test(raw.scenarioId)) return err(`${label}: bad scenarioId`);
  if (!isUint32(raw.seed)) return err(`${label}: bad seed`);
  if (typeof raw.ended !== "boolean") return err(`${label}: bad ended flag`);
  if (raw.formation !== undefined && !isFormationName(raw.formation)) return err(`${label}: bad formation`);
  const calls = raw.calls;
  if (!Array.isArray(calls) || calls.length > MAX_STORED_CALLS) return err(`${label}: bad calls`);
  for (const c of calls) {
    if (!isRecord(c) || typeof c.type !== "string" || !CALL_TYPES.has(c.type)) return err(`${label}: bad call`);
  }
  return ok({
    v: 1, mode, date, scenarioId: raw.scenarioId, seed: raw.seed, formation: raw.formation ?? DEFAULT_FORMATION,
    calls: calls as Call[], ended: raw.ended,
  });
}

/** The formation a stored run starts with: its own, or umbrella for a run saved before formations existed. */
export function storedFormation(run: Pick<StoredRun, "formation">): PpFormationName {
  return run.formation ?? DEFAULT_FORMATION;
}

/** Last starting formation the player picked in `mode`; umbrella when none, unreadable or unknown. O(1). */
export function readFormationPref(store: KeyValueStore, mode: Mode): PpFormationName {
  const raw = store.get(STORAGE_KEYS.formation(mode));
  return isFormationName(raw) ? raw : DEFAULT_FORMATION;
}

/** false when the browser refused the write. */
export function writeFormationPref(store: KeyValueStore, mode: Mode, formation: PpFormationName): boolean {
  return store.set(STORAGE_KEYS.formation(mode), formation);
}

/**
 * Change the starting formation of the stored run, only while it has no calls (the formation is part of the replay
 * key, so it cannot change once a call has been applied). Also remembers it as the mode's preference.
 * Err when there is no usable stored run or it already has calls.
 */
export function setStoredFormation(store: KeyValueStore, mode: Mode, formation: PpFormationName): Result<StoredRun> {
  const read = readRun(store, mode);
  if (!read.ok) return read;
  if (read.value === null) return err(`${STORAGE_KEYS.run(mode)}: no run to change`);
  if (read.value.calls.length > 0) return err(`${STORAGE_KEYS.run(mode)}: the formation is fixed once a call is made`);
  const next: StoredRun = { ...read.value, formation };
  writeRun(store, next);
  writeFormationPref(store, mode, formation);
  return ok(next);
}

/** Ok(null) when nothing is stored; Err when something is stored but unusable. */
export function readRun(store: KeyValueStore, mode: Mode): Result<StoredRun | null> {
  const raw = store.get(STORAGE_KEYS.run(mode));
  if (raw === null) return ok(null);
  const json = parseJson(raw, STORAGE_KEYS.run(mode));
  if (!json.ok) return json;
  const run = parseStoredRun(json.value, mode);
  return run.ok ? ok(run.value) : run;
}

/** false when the browser refused the write (the in-session copy is still kept by the store). */
export function writeRun(store: KeyValueStore, run: StoredRun): boolean {
  const saved = store.set(STORAGE_KEYS.run(run.mode), JSON.stringify(run));
  // The Daily's "ended" write is the one moment a Daily counts as played, so the streak history is fed here.
  if (run.mode === "daily" && run.ended && run.date !== null) recordDailyFinished(store, run.date);
  return saved;
}

/**
 * Finished-Daily dates, sorted ascending, deduplicated. Ok([]) when nothing is stored; Err when the stored
 * value is unusable (the caller shows no streak rather than a made-up one). O(n log n), n <= MAX_HISTORY_DATES.
 */
export function readDailyHistory(store: KeyValueStore): Result<string[]> {
  const raw = store.get(STORAGE_KEYS.history);
  if (raw === null) return ok([]);
  const json = parseJson(raw, STORAGE_KEYS.history);
  if (!json.ok) return json;
  const list = json.value;
  if (!Array.isArray(list)) return err(`${STORAGE_KEYS.history}: not an array`);
  const dates = new Set<string>();
  for (const d of list) {
    if (typeof d !== "string" || !isCalendarDate(d)) return err(`${STORAGE_KEYS.history}: bad date`);
    dates.add(d);
  }
  return ok([...dates].sort());
}

/**
 * Add `date` to the history (idempotent), keep the newest MAX_HISTORY_DATES. A corrupt stored history is
 * replaced by just this date. false when the browser refused the write. O(n log n).
 */
export function recordDailyFinished(store: KeyValueStore, date: string): boolean {
  if (!isCalendarDate(date)) return false;
  const prior = readDailyHistory(store);
  const dates = new Set(prior.ok ? prior.value : []);
  dates.add(date);
  const kept = [...dates].sort().slice(-MAX_HISTORY_DATES);
  return store.set(STORAGE_KEYS.history, JSON.stringify(kept));
}

export function clearRun(store: KeyValueStore, mode: Mode): void {
  store.remove(STORAGE_KEYS.run(mode));
}

export function readQueue(store: KeyValueStore): Result<QueueState | null> {
  const raw = store.get(STORAGE_KEYS.queue);
  if (raw === null) return ok(null);
  const json = parseJson(raw, STORAGE_KEYS.queue);
  if (!json.ok) return json;
  const q = json.value;
  if (!isRecord(q) || q.v !== 1 || !isUint32(q.seed)) return err(`${STORAGE_KEYS.queue}: bad shape`);
  if (typeof q.served !== "number" || !Number.isInteger(q.served) || q.served < 0 || q.served > MAX_SERVED) {
    return err(`${STORAGE_KEYS.queue}: bad served count`);
  }
  return ok({ v: 1, seed: q.seed, served: q.served });
}

export function writeQueue(store: KeyValueStore, q: QueueState): boolean {
  return store.set(STORAGE_KEYS.queue, JSON.stringify(q));
}
