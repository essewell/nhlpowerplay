import { test } from "node:test";
import assert from "node:assert/strict";
import { vancouverDate } from "./daily.ts";
import {
  clockLeftText, dailyStreak, formatMmSs, previousDate, splitWordmark, stageLine, streakLine, streakText, strengthText,
  untilNextDaily,
} from "./home-logic.ts";

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
  // 2024-03-02 18:00 PST = 2024-03-03T02:00Z
  assert.deepEqual(untilNextDaily(new Date("2024-03-03T02:00:00Z")), { h: 6, m: 0 });
});

test("untilNextDaily edge: rounds up to the next minute, never 0h 0m while time is left", () => {
  // 23:59:30 PST on 2024-03-02 = 2024-03-03T07:59:30Z
  assert.deepEqual(untilNextDaily(new Date("2024-03-03T07:59:30Z")), { h: 0, m: 1 });
});

test("untilNextDaily edge: exactly midnight starts a full new day", () => {
  assert.deepEqual(untilNextDaily(new Date("2024-03-03T08:00:00Z")), { h: 24, m: 0 });
});

// Countdown cases use 2024 dates, which every tz release agrees on. From 2026-11-01 newer tz data has
// America/Vancouver on permanent UTC-7 (BC), older data keeps DST, so future dates are not portable.
// DST days use 2024 transitions. Future Pacific rules differ between
// tz releases (CI's Node and this PC disagree about 2026-11-01), and the countdown simply follows the
// runtime's own tz data, which is the browser's in production.
test("untilNextDaily edge: spring-forward day (2024-03-10) is 23 hours long", () => {
  assert.deepEqual(untilNextDaily(new Date("2024-03-10T08:00:00Z")), { h: 23, m: 0 }); // 00:00 PST
});

test("untilNextDaily edge: fall-back day (2024-11-03) is 25 hours long", () => {
  assert.deepEqual(untilNextDaily(new Date("2024-11-03T07:00:00Z")), { h: 25, m: 0 }); // 00:00 PDT
});

test("streakText: counts shown, zero/invalid falls back to the prompt", () => {
  assert.equal(streakText(4), "4-day streak");
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

const NONE = "Start a streak: play today's Daily.";

test("dailyStreak: happy path counts consecutive days ending today", () => {
  assert.equal(dailyStreak(["2024-05-01", "2024-05-02", "2024-05-03"], "2024-05-03"), 3);
});

test("dailyStreak edge: a gap day breaks the streak", () => {
  assert.equal(dailyStreak(["2024-05-01", "2024-05-03", "2024-05-04"], "2024-05-04"), 2);
});

test("dailyStreak edge: today unplayed but yesterday played keeps the streak alive", () => {
  assert.equal(dailyStreak(["2024-05-01", "2024-05-02"], "2024-05-03"), 2);
});

test("dailyStreak edge: last played two days ago is a dead streak", () => {
  assert.equal(dailyStreak(["2024-05-01", "2024-05-02"], "2024-05-04"), 0);
});

test("dailyStreak edge: duplicates and unsorted input count once", () => {
  assert.equal(dailyStreak(["2024-05-03", "2024-05-02", "2024-05-03", "2024-05-02"], "2024-05-03"), 2);
});

test("dailyStreak edge: first ever play is a 1-day streak; empty history is 0", () => {
  assert.equal(dailyStreak(["2024-05-03"], "2024-05-03"), 1);
  assert.equal(dailyStreak([], "2024-05-03"), 0);
});

test("dailyStreak edge: streak crosses month and year boundaries and leap day", () => {
  assert.equal(dailyStreak(["2023-12-31", "2024-01-01"], "2024-01-01"), 2);
  assert.equal(dailyStreak(["2024-02-28", "2024-02-29", "2024-03-01"], "2024-03-01"), 3);
});

test("dailyStreak edge: dates after today are ignored; malformed today yields 0", () => {
  assert.equal(dailyStreak(["2024-05-04"], "2024-05-03"), 0);
  assert.equal(dailyStreak(["2024-05-03"], "not-a-date"), 0);
});

test("dailyStreak edge: rollover at Vancouver midnight, not UTC midnight", () => {
  const played = ["2024-05-02"];
  // 2024-05-03T06:59Z is 23:59 PDT on May 2 -> still the same day, today played.
  assert.equal(dailyStreak(played, vancouverDate(new Date("2024-05-03T06:59:00Z"))), 1);
  // One minute later it is May 3 in Vancouver: May 3 not played yet, May 2 keeps the streak.
  assert.equal(dailyStreak(played, vancouverDate(new Date("2024-05-03T07:00:00Z"))), 1);
  // A day later with nothing new played the streak is gone.
  assert.equal(dailyStreak(played, vancouverDate(new Date("2024-05-04T07:00:00Z"))), 0);
});

test("previousDate: month, year, leap boundaries; malformed is null", () => {
  assert.equal(previousDate("2024-03-01"), "2024-02-29");
  assert.equal(previousDate("2024-01-01"), "2023-12-31");
  assert.equal(previousDate("nope"), null);
});

test("streakLine: shows the count, and the prompt only when streak is 0 and today is unplayed", () => {
  assert.equal(streakLine(["2024-05-02", "2024-05-03"], "2024-05-03", true), "2-day streak");
  assert.equal(streakLine([], "2024-05-03", false), NONE);
  assert.equal(streakLine(["2024-05-01"], "2024-05-03", false), NONE);
});

test("streakLine edge: today played with lost history never shows the prompt", () => {
  assert.equal(streakLine([], "2024-05-03", true), "1-day streak");
});
