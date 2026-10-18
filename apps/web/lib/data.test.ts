import { test } from "node:test";
import assert from "node:assert/strict";
import { createDataSource, loadScenarioView } from "./data.ts";
import { fakeFetch, fixtureSource, makeFiles, SCENARIO_A, SCENARIO_B, TEST_BASE } from "./testing/fixtures.ts";

test("data: bundle loads once, indexes ratings, and is cached", async () => {
  const counter = { n: 0 };
  const src = fixtureSource(makeFiles(), counter);
  const a = await src.bundle();
  assert.ok(a.ok);
  assert.equal(a.value.endlessIndex.length, 3);
  const afterFirst = counter.n;
  assert.equal(afterFirst, 7);
  await src.bundle();
  assert.equal(counter.n, afterFirst, "second call hits the cache");
  const sc1 = await src.scenario(SCENARIO_A);
  const sc2 = await src.scenario(SCENARIO_A);
  assert.ok(sc1.ok && sc2.ok);
  assert.equal(counter.n, afterFirst + 1);
});

test("data edge: missing scenario file -> error naming the file, then retry works", async () => {
  const files = makeFiles();
  const body = files.get(`scenarios/${SCENARIO_B}.json`) as string;
  files.delete(`scenarios/${SCENARIO_B}.json`);
  const src = fixtureSource(files);
  const miss = await src.scenario(SCENARIO_B);
  assert.equal(miss.ok, false);
  if (!miss.ok) assert.match(miss.error, /scenarios\/zz-synthetic-demo-b\.json: HTTP 404/);
  files.set(`scenarios/${SCENARIO_B}.json`, body);
  const retry = await src.scenario(SCENARIO_B);
  assert.ok(retry.ok, "failures are not cached");
});

test("data edge: malformed JSON and schema violations are errors, never throws", async () => {
  const files = makeFiles();
  files.set(`scenarios/${SCENARIO_A}.json`, "{ not json");
  files.set("base_rates.json", JSON.stringify([{ nope: 1 }]));
  const src = fixtureSource(files);
  const sc = await src.scenario(SCENARIO_A);
  assert.equal(sc.ok, false);
  if (!sc.ok) assert.match(sc.error, /invalid JSON/);
  const bundle = await src.bundle();
  assert.equal(bundle.ok, false);
  if (!bundle.ok) assert.match(bundle.error, /base_rates\.json/);
});

test("data edge: scenario id that is not file-safe is refused before any fetch", async () => {
  const counter = { n: 0 };
  const src = fixtureSource(makeFiles(), counter);
  const r = await src.scenario("../secrets");
  assert.equal(r.ok, false);
  assert.equal(counter.n, 0);
});

test("data edge: file holding a different scenario id is rejected", async () => {
  const files = makeFiles();
  files.set(`scenarios/${SCENARIO_B}.json`, files.get(`scenarios/${SCENARIO_A}.json`) as string);
  const r = await fixtureSource(files).scenario(SCENARIO_B);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /holds scenario/);
});

test("data edge: network failure becomes an error", async () => {
  const src = createDataSource({ base: TEST_BASE, fetchFn: () => Promise.reject(new Error("offline")) });
  const r = await src.bundle();
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /network error: offline/);
});

test("data: runInput returns the engine input and view loads as Loadable", async () => {
  const src = fixtureSource();
  const run = await src.runInput(SCENARIO_A);
  assert.ok(run.ok);
  assert.equal(run.value.loaded.input.settings.formation, "umbrella");
  assert.equal(run.value.loaded.input.settings.askEveryTouch, false);
  const view = await loadScenarioView(SCENARIO_A, src);
  assert.equal(view.status, "ready");
  const bad = await loadScenarioView("nope", createDataSource({ base: TEST_BASE, fetchFn: fakeFetch(new Map()) }));
  assert.equal(bad.status, "error");
});
