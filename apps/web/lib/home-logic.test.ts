import { test } from "node:test";
import assert from "node:assert/strict";
import { clockLeftText, formatMmSs, splitWordmark, stageLine, streakText, strengthText, untilNextDaily } from "./home-logic.ts";

test("clockLeftText: regulation period, elapsed 600 of 1200 -> 10:00 left", () => {
  assert.equal(clockLeftText(2, 600, 3), "10:00 left");
});

test("clockLeftText edge: elapsed 0 is a full period, elapsed at the end is 0:00", () => {
  assert.equal(clockLeftText(1, 0, 3), "20:00 left");
  assert.equal(clockLeftText(3, 1200, 3), "0:00 left");
});

test("clockLeftText edge: playoff overtime is a full 20:00 period, regular-season overtime is shorter", () => {
  assert.equal(clockLeftText(4, 0, 3), "20:00 left");
  assert.notEqual(clockLeftText(4, 0, 2), "20:00 left");
});

test("clockLeftText edge: seconds are zero padded", () => {
  assert.equal(clockLeftText(1, 1141, 3), "0:59 left");
  assert.equal(clockLeftText(1, 1139, 3), "1:01 left");
});

test("clockLeftText edge: defaults to a playoff game when the type is unknown", () => {
  assert.equal(clockLeftText(5, 0), "20:00 left");
});

test("clockLeftText edge: nonsense clocks give null, never a made-up time", () => {
  assert.equal(clockLeftText(1, 1201, 3), null, "elapsed past the end");
  assert.equal(clockLeftText(1, -1, 3), null);
  assert.equal(clockLeftText(0, 10, 3), null, "no period 0");
  assert.equal(clockLeftText(1, 12.5, 3), null);
  assert.equal(clockLeftText(5, 0, 2), null, "regular season has no period 5");
});

test("formatMmSs: whole seconds only", () => {
  assert.equal(formatMmSs(0), "0:00");
  assert.equal(formatMmSs(683), "11:23");
  assert.equal(formatMmSs(Number.NaN), null);
  assert.equal(formatMmSs(-1), null);
});

test("strengthText: 5-on-4 and 4-on-3", () => {
  assert.equal(strengthText({ pp: 5, pk: 4 }), "5-on-4");
  assert.equal(strengthText({ pp: 4, pk: 3 }), "4-on-3");
});

test("stageLine: stage plus game number, stage alone, nothing", () => {
  assert.equal(stageLine("Playoffs", 3), "Playoffs · Game 3");
  assert.equal(stageLine("Final", null), "Final");
  assert.equal(stageLine(null, 3), null, "a bare game number is not a stage line");
  assert.equal(stageLine(null, null), null);
});

test("untilNextDaily: 18:00 Pacific on an ordinary day -> 6h 0m", () => {
  // 2099-03-02 18:00 PST = 2099-03-03T02:00Z
  assert.deepEqual(untilNextDaily(new Date("2099-03-03T02:00:00Z")), { h: 6, m: 0 });
});

test("untilNextDaily edge: rounds up to the next minute, never 0h 0m while time is left", () => {
  // 23:59:30 PST on 2099-03-02 = 2099-03-03T07:59:30Z
  assert.deepEqual(untilNextDaily(new Date("2099-03-03T07:59:30Z")), { h: 0, m: 1 });
});

test("untilNextDaily edge: exactly midnight starts a full new day", () => {
  assert.deepEqual(untilNextDaily(new Date("2099-03-03T08:00:00Z")), { h: 24, m: 0 });
});

test("untilNextDaily edge: spring-forward day is 23 hours long", () => {
  // Pacific DST starts on the second Sunday of March: 2027-03-14. 00:00 PST = 08:00Z.
  // Near-term dates on purpose: far-future tz rules differ between ICU builds (CI vs local).
  assert.deepEqual(untilNextDaily(new Date("2027-03-14T08:00:00Z")), { h: 23, m: 0 });
});

test("untilNextDaily edge: fall-back day is 25 hours long", () => {
  // DST ends on the first Sunday of November: 2026-11-01. 00:00 PDT = 07:00Z.
  assert.deepEqual(untilNextDaily(new Date("2026-11-01T07:00:00Z")), { h: 25, m: 0 });
});

test("streakText: counts shown, no history falls back to the prompt", () => {
  assert.equal(streakText(4), "4-day streak");
  assert.equal(streakText(null), "Start a streak: play today's Daily.");
  assert.equal(streakText(0), "Start a streak: play today's Daily.");
  assert.equal(streakText(-2), "Start a streak: play today's Daily.");
  assert.equal(streakText(1.5), "Start a streak: play today's Daily.");
});

test("splitWordmark: two-part name splits at the second capital; others stay whole", () => {
  assert.deepEqual(splitWordmark("PowerPlay"), ["Power", "Play"]);
  assert.deepEqual(splitWordmark("Power"), ["Power", ""]);
  assert.deepEqual(splitWordmark(""), ["", ""]);
  assert.deepEqual(splitWordmark("POWERPLAY"), ["P", "OWERPLAY"], "all caps splits after the first letter");
});
