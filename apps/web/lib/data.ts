/**
 * Data layer: fetches the exported JSON, validates it with the engine parsers, caches in memory and
 * builds the rating indexes once. Nothing here throws to the UI: every failure is a Result / Loadable.
 *
 * Ownership: a DataSource holds mutable caches (promises). Create one per execution context; the
 * main thread uses `defaultSource()`, the run worker builds its own from the base URL it is sent.
 * Cost: bundle load is O(total export bytes) once; scenario load is O(scenario bytes + loadScenario).
 */
import { indexAllRatings, loadScenario, type LoadOpts, type Loaded, type RatingIndexes } from "@powerplay/engine/loader.ts";
import { err, ok, type Result } from "@powerplay/engine/result.ts";
import {
  EXPORT_FILES, parseBaseRates, parseEndlessIndex, parseFaceoffRatings, parseGoalieRatings,
  parsePlaymakerRatings, parseScenario, parseSchedule, parseShooterRatings,
  type BaseRatesFile, type EndlessIndexFile, type Scenario, type ScheduleFile,
} from "@powerplay/engine/schema.ts";
import type { Loadable, ScenarioView } from "./contracts.ts";
import { toScenarioView } from "./view.ts";

/** Where the exported JSON is served from (`pnpm data:sync` fills apps/web/public/data). */
export const DATA_BASE: string = process.env.NEXT_PUBLIC_DATA_BASE ?? "/data";

/** v1 run defaults (no settings UI). Same values data-sync cross-checks every scenario under. */
export const V1_LOAD_OPTS: LoadOpts = { formation: "umbrella", askEveryTouch: false };

/** Scenario ids double as file names; refuse anything that could escape the scenarios/ directory. */
const SCENARIO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export interface DataBundle {
  baseRates: BaseRatesFile;
  ratings: RatingIndexes;
  schedule: ScheduleFile;
  endlessIndex: EndlessIndexFile;
}

export interface LoadedRun { scenario: Scenario; loaded: Loaded }

export interface DataSource {
  readonly base: string;
  bundle(): Promise<Result<DataBundle>>;
  scenario(id: string): Promise<Result<Scenario>>;
  /** Scenario + engine RunInput under `opts` (default V1_LOAD_OPTS). */
  runInput(id: string, opts?: LoadOpts): Promise<Result<LoadedRun>>;
}

export type FetchFn = (url: string) => Promise<Response>;

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** GET + JSON parse, as a Result. Never throws. */
async function getJson(fetchFn: FetchFn, url: string, label: string): Promise<Result<unknown>> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (e) {
    return err(`${label}: network error: ${errMessage(e)}`);
  }
  if (!res.ok) return err(`${label}: HTTP ${res.status}`);
  try {
    return ok(await res.json());
  } catch (e) {
    return err(`${label}: invalid JSON: ${errMessage(e)}`);
  }
}

async function fetchParsed<T>(fetchFn: FetchFn, base: string, file: string,
  parse: (data: unknown, file: string) => Result<T>): Promise<Result<T>> {
  const raw = await getJson(fetchFn, `${base}/${file}`, file);
  return raw.ok ? parse(raw.value, file) : err(raw.error);
}

async function loadBundle(fetchFn: FetchFn, base: string): Promise<Result<DataBundle>> {
  const [baseRates, shooter, goalie, faceoff, playmaker, schedule, endless] = await Promise.all([
    fetchParsed(fetchFn, base, "base_rates.json", parseBaseRates),
    fetchParsed(fetchFn, base, "shooter_ratings.json", parseShooterRatings),
    fetchParsed(fetchFn, base, "goalie_ratings.json", parseGoalieRatings),
    fetchParsed(fetchFn, base, "faceoff_ratings.json", parseFaceoffRatings),
    fetchParsed(fetchFn, base, "playmaker_ratings.json", parsePlaymakerRatings),
    fetchParsed(fetchFn, base, "schedule.json", parseSchedule),
    fetchParsed(fetchFn, base, "endless_index.json", parseEndlessIndex),
  ]);
  if (!baseRates.ok) return baseRates;
  if (!shooter.ok) return shooter;
  if (!goalie.ok) return goalie;
  if (!faceoff.ok) return faceoff;
  if (!playmaker.ok) return playmaker;
  if (!schedule.ok) return schedule;
  if (!endless.ok) return endless;
  const ratings = indexAllRatings({
    shooter: shooter.value, goalie: goalie.value, faceoff: faceoff.value, playmaker: playmaker.value,
  });
  if (!ratings.ok) return err(`ratings: ${ratings.error}`);
  return ok({ baseRates: baseRates.value, ratings: ratings.value, schedule: schedule.value, endlessIndex: endless.value });
}

/**
 * A DataSource over `fetchFn`. Successful loads are cached for the life of the source; failures are
 * evicted so a later call can retry (e.g. after coming back online).
 */
export function createDataSource(cfg: { base: string; fetchFn: FetchFn }): DataSource {
  const base = cfg.base.replace(/\/+$/, "");
  let bundleP: Promise<Result<DataBundle>> | null = null;
  const scenarioP = new Map<string, Promise<Result<Scenario>>>();

  const bundle = (): Promise<Result<DataBundle>> => {
    if (bundleP === null) {
      const p = loadBundle(cfg.fetchFn, base);
      bundleP = p;
      void p.then((r) => {
        if (!r.ok && bundleP === p) bundleP = null;
      });
    }
    return bundleP;
  };

  const scenario = (id: string): Promise<Result<Scenario>> => {
    if (!SCENARIO_ID_RE.test(id)) return Promise.resolve(err(`scenario id "${id}" is not file-safe`));
    let p = scenarioP.get(id);
    if (p === undefined) {
      const file = EXPORT_FILES.scenarioFile(id);
      const fresh = fetchParsed(cfg.fetchFn, base, file, parseScenario).then((r): Result<Scenario> =>
        r.ok && r.value.id !== id ? err(`${file}: file holds scenario "${r.value.id}", expected "${id}"`) : r);
      p = fresh;
      scenarioP.set(id, fresh);
      void fresh.then((r) => {
        if (!r.ok && scenarioP.get(id) === fresh) scenarioP.delete(id);
      });
    }
    return p;
  };

  const runInput = async (id: string, opts: LoadOpts = V1_LOAD_OPTS): Promise<Result<LoadedRun>> => {
    const [b, sc] = await Promise.all([bundle(), scenario(id)]);
    if (!b.ok) return b;
    if (!sc.ok) return sc;
    const loaded = loadScenario(sc.value, b.value.ratings, b.value.baseRates, opts);
    return loaded.ok ? ok({ scenario: sc.value, loaded: loaded.value }) : err(loaded.error);
  };

  return { base, bundle, scenario, runInput };
}

let main: DataSource | null = null;

/** The main-thread source over global fetch and DATA_BASE. Created on first use (never during SSR import). */
export function defaultSource(): DataSource {
  main ??= createDataSource({ base: DATA_BASE, fetchFn: (url) => fetch(url) });
  return main;
}

/** Result -> Loadable ("empty" is for the caller to produce when a lookup finds nothing). */
export function toLoadable<T>(r: Result<T>): Loadable<T> {
  return r.ok ? { status: "ready", value: r.value } : { status: "error", message: r.error };
}

/** Scenario view for the UI. Never rejects. */
export async function loadScenarioView(id: string, source: DataSource = defaultSource()): Promise<Loadable<ScenarioView>> {
  const sc = await source.scenario(id);
  return sc.ok ? { status: "ready", value: toScenarioView(sc.value) } : { status: "error", message: sc.error };
}
