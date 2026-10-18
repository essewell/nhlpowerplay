import { test } from "node:test";
import assert from "node:assert/strict";
import { daysBetween, getDaily, pickDaily, vancouverDate } from "./daily.ts";
import { fixtureSource, makeFiles, SCENARIO_A, SCENARIO_B, SCENARIO_C } from "./testing/fixtures.ts";

const schedule = [
  { date: "2099-01-01", scenario_id: SCENARIO_A },
  { date: "2099-01-02", scenario_id: SCENARIO_B },
  { date: "2099-01-03", scenario_id: SCENARIO_A },
];
const pool = [SCENARIO_A, SCENARIO_B, SCENARIO_C];

test("daily: today in Vancouver, scenario and number come from the schedule", async () => {
  // 2099-01-02 12:00 UTC is 04:00 on Jan 2 in Vancouver (PST, UTC-8).
  const r = await getDaily(fixtureSource(), new Date("2099-01-02T12:00:00Z"));
  assert.equal(r.status, "ready");
  if (r.status !== "ready") return;
  assert.equal(r.value.date, "2099-01-02");
  assert.equal(r.value.number, 2);
  assert.equal(r.value.scenario.id, SCENARIO_B);
});

test("daily edge: Vancouver midnight rollover (winter, PST)", () => {
  assert.equal(vancouverDate(new Date("2099-01-02T07:59:59Z")), "2099-01-01", "23:59:59 Vancouver");
  assert.equal(vancouverDate(new Date("2099-01-02T08:00:00Z")), "2099-01-02", "00:00:00 Vancouver");
});

test("daily edge: Vancouver midnight rollover (summer, PDT) and DST switch days", () => {
  assert.equal(vancouverDate(new Date("2099-07-02T06:59:59Z")), "2099-07-01");
  assert.equal(vancouverDate(new Date("2099-07-02T07:00:00Z")), "2099-07-02");
  // Spring-forward day (2nd Sunday of March): the date still advances exactly once.
  assert.equal(vancouverDate(new Date("2025-03-09T07:59:59Z")), "2025-03-08");
  assert.equal(vancouverDate(new Date("2025-03-09T08:00:00Z")), "2025-03-09");
  assert.equal(vancouverDate(new Date("2025-03-10T06:59:59Z")), "2025-03-09");
  assert.equal(vancouverDate(new Date("2025-03-10T07:00:00Z")), "2025-03-10");
});

test("daily edge: UTC date differs from Vancouver date late in the evening", () => {
  assert.equal(vancouverDate(new Date("2099-01-03T02:00:00Z")), "2099-01-02");
});

test("daily edge: date outside the schedule uses the deterministic pick and day offset", () => {
  const after = pickDaily("2099-01-10", schedule, pool);
  assert.ok(after.ok);
  assert.equal(after.value.number, 10, "9 days after the first schedule date, +1");
  assert.ok(pool.includes(after.value.scenarioId));
  const again = pickDaily("2099-01-10", schedule, [...pool].reverse());
  assert.ok(again.ok);
  assert.equal(again.value.scenarioId, after.value.scenarioId, "pool order does not matter");
});

test("daily edge: date before the schedule starts is #1 (floored); empty schedule is #1", () => {
  const before = pickDaily("2098-12-01", schedule, pool);
  assert.ok(before.ok);
  assert.equal(before.value.number, 1);
  const empty = pickDaily("2099-05-05", [], pool);
  assert.ok(empty.ok);
  assert.equal(empty.value.number, 1);
});

test("daily edge: empty pool and no schedule hit is an explicit error; bad date too", () => {
  const noPool = pickDaily("2099-05-05", schedule, []);
  assert.equal(noPool.ok, false);
  const bad = pickDaily("not-a-date", schedule, pool);
  assert.equal(bad.ok, false);
});

test("daily edge: daysBetween handles month, year and leap boundaries", () => {
  assert.equal(daysBetween("2099-01-01", "2099-02-01"), 31);
  assert.equal(daysBetween("2099-12-31", "2100-01-01"), 1);
  assert.equal(daysBetween("2096-02-28", "2096-03-01"), 2, "leap year");
  assert.equal(daysBetween("2099-01-05", "2099-01-01"), -4);
  assert.equal(daysBetween("2099-1-5", "2099-01-01"), null);
});

test("daily edge: missing scenario file and malformed bundle surface as errors, not throws", async () => {
  const files = makeFiles();
  files.delete(`scenarios/${SCENARIO_B}.json`);
  const missing = await getDaily(fixtureSource(files), new Date("2099-01-02T12:00:00Z"));
  assert.equal(missing.status, "error");
  const bad = makeFiles();
  bad.set("schedule.json", "{ nope");
  const malformed = await getDaily(fixtureSource(bad), new Date("2099-01-02T12:00:00Z"));
  assert.equal(malformed.status, "error");
  if (malformed.status === "error") assert.match(malformed.message, /schedule\.json: invalid JSON/);
});

test("daily edge: empty schedule and empty pool -> empty", async () => {
  const files = makeFiles();
  files.set("schedule.json", "[]");
  files.set("endless_index.json", "[]");
  const r = await getDaily(fixtureSource(files), new Date("2099-01-02T12:00:00Z"));
  assert.equal(r.status, "empty");
});
