/**
 * Test-only helpers: SYNTHETIC data (apps/web/dev-fixtures) served from memory through a fake fetch,
 * plus a call policy to play runs to the end. Never imported by app code.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Call, CallOption } from "@powerplay/engine/sim-types.ts";
import { createDataSource, type DataSource, type FetchFn } from "../data.ts";

const FIXTURES = fileURLToPath(new URL("../../dev-fixtures/", import.meta.url));
export const TEST_BASE = "mem://data";
export const SCENARIO_A = "zz-synthetic-demo-5on4";
export const SCENARIO_B = "zz-synthetic-demo-b";
export const SCENARIO_C = "zz-synthetic-demo-c";

const readJson = (rel: string): unknown => JSON.parse(readFileSync(`${FIXTURES}${rel}`, "utf8"));

/** relative path ("schedule.json", "scenarios/<id>.json") -> raw file text. */
export type FileMap = Map<string, string>;

/**
 * Three synthetic scenarios (A from the fixture; B, C are copies with other ids/seeds) and a schedule
 * 2099-01-01 -> A, 2099-01-02 -> B, 2099-01-03 -> A. Mutate the returned map to simulate bad data.
 */
export function makeFiles(): FileMap {
  const files: FileMap = new Map();
  for (const name of ["base_rates", "shooter_ratings", "goalie_ratings", "faceoff_ratings", "playmaker_ratings"]) {
    files.set(`${name}.json`, JSON.stringify(readJson(`${name}.synthetic.json`)));
  }
  const a = readJson(`scenarios/${SCENARIO_A}.synthetic.json`) as Record<string, unknown>;
  const clone = (id: string, seed: number): Record<string, unknown> => ({ ...a, id, seed });
  files.set(`scenarios/${SCENARIO_A}.json`, JSON.stringify(a));
  files.set(`scenarios/${SCENARIO_B}.json`, JSON.stringify(clone(SCENARIO_B, 777)));
  files.set(`scenarios/${SCENARIO_C}.json`, JSON.stringify(clone(SCENARIO_C, 4242)));
  files.set("schedule.json", JSON.stringify([
    { date: "2099-01-01", scenario_id: SCENARIO_A },
    { date: "2099-01-02", scenario_id: SCENARIO_B },
    { date: "2099-01-03", scenario_id: SCENARIO_A },
  ]));
  files.set("endless_index.json", JSON.stringify([SCENARIO_A, SCENARIO_B, SCENARIO_C]));
  return files;
}

/** A fetch over `files`; unknown paths are 404. `counter.n` counts requests. */
export function fakeFetch(files: FileMap, counter: { n: number } = { n: 0 }): FetchFn {
  return (url) => {
    counter.n++;
    const rel = url.startsWith(`${TEST_BASE}/`) ? url.slice(TEST_BASE.length + 1) : url;
    const body = files.get(rel);
    return Promise.resolve(body === undefined ? new Response("not found", { status: 404 }) : new Response(body, { status: 200 }));
  };
}

export function fixtureSource(files: FileMap = makeFiles(), counter?: { n: number }): DataSource {
  return createDataSource({ base: TEST_BASE, fetchFn: fakeFetch(files, counter) });
}

/** Always the first (lowest-index) option: deterministic, plays any run to its end. */
export const firstOption = (options: readonly CallOption[]): Call => {
  const o = options[0];
  if (o === undefined) throw new Error("no options to choose from");
  return o.call;
};
