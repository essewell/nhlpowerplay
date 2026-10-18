/**
 * Pure helpers behind the Home screen (components/home/*). No DOM, no state, no clock reads: the
 * caller passes `now`. Tested in home-logic.test.ts.
 */
import { periodLengthS } from "@powerplay/engine/clock.ts";
import type { GameType } from "@powerplay/engine/sim-types.ts";
import type { ScenarioView } from "./contracts.ts";
import { t } from "./copy.ts";
import { vancouverDate } from "./daily.ts";

const SECONDS_PER_MINUTE = 60;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = SECONDS_PER_MINUTE * MS_PER_SECOND;
const MINUTES_PER_HOUR = 60;
/** v1 data is playoffs only (docs/LAUNCH.md), so a view without a game type is read as a playoff game. */
const DEFAULT_GAME_TYPE: GameType = 3;
/** The longest Vancouver day is 25 h (DST ends); +26 h from any instant is always on a later date. */
const SEARCH_WINDOW_MS = 26 * MINUTES_PER_HOUR * MS_PER_MINUTE;

/** "m:ss" for a whole number of seconds >= 0; null otherwise. O(1). */
export function formatMmSs(totalSeconds: number): string | null {
  if (!Number.isInteger(totalSeconds) || totalSeconds < 0) return null;
  const m = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const s = totalSeconds % SECONDS_PER_MINUTE;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** "m:ss left" from the period length minus elapsed; null when the clock is not a real reading. O(1). */
export function clockLeftText(period: number, elapsedS: number, gameType: GameType = DEFAULT_GAME_TYPE): string | null {
  const len = periodLengthS(period, gameType);
  if (!len.ok) return null;
  if (!Number.isInteger(elapsedS) || elapsedS < 0) return null;
  const clock = formatMmSs(len.value - elapsedS);
  return clock === null ? null : t("home.daily.clock", { clock });
}

/** "5-on-4" from the scenario's strength. O(1). */
export function strengthText(strength: ScenarioView["strength"]): string {
  return t("home.daily.strength", { pp: strength.pp, pk: strength.pk });
}

/** "Stanley Cup Final · Game 1" style line; null when there is no stage label (game number alone is not shown). O(1). */
export function stageLine(stageText: string | null, gameNumber: number | null): string | null {
  if (stageText === null) return null;
  return gameNumber === null ? stageText : t("home.daily.stage", { stageName: stageText, gameNumber });
}

/**
 * Whole hours and minutes until the Daily rolls over (midnight America/Vancouver), rounded UP to the
 * next minute so it never reads "0h 0m" with time left. Binary search to the millisecond on the Vancouver date (Intl
 * handles DST, so 23 h and 25 h days are exact). O(log window).
 */
export function untilNextDaily(now: Date): { h: number; m: number } {
  const today = vancouverDate(now);
  let lo = now.getTime();
  let hi = lo + SEARCH_WINDOW_MS;
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2);
    if (vancouverDate(new Date(mid)) === today) lo = mid;
    else hi = mid;
  }
  const minutes = Math.ceil((hi - now.getTime()) / MS_PER_MINUTE);
  return { h: Math.floor(minutes / MINUTES_PER_HOUR), m: minutes % MINUTES_PER_HOUR };
}

const MS_PER_DAY = 24 * MINUTES_PER_HOUR * MS_PER_MINUTE;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The calendar day before `date` (YYYY-MM-DD); null if malformed. Pure calendar math in UTC, so no DST. O(1). */
export function previousDate(date: string): string | null {
  const m = ISO_DATE.exec(date);
  if (m === null) return null;
  const prev = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - MS_PER_DAY);
  return prev.toISOString().slice(0, 10);
}

/**
 * Consecutive finished-Daily dates ending today, or ending yesterday when today's is not played yet (the
 * streak is still alive until the day rolls over). Order and duplicates in `played` do not matter;
 * dates after `today` are ignored. O(n).
 */
export function dailyStreak(played: readonly string[], today: string): number {
  const set = new Set(played);
  let day: string | null = set.has(today) ? today : previousDate(today);
  let n = 0;
  while (day !== null && set.has(day)) {
    n += 1;
    day = previousDate(day);
  }
  return n;
}

/** Streak copy: "{n}-day streak" for n >= 1, the "start a streak" prompt for anything else. O(1). */
export function streakText(streak: number): string {
  if (!Number.isInteger(streak) || streak < 1) return t("home.streak.none");
  return t("home.streak", { n: streak });
}

/**
 * The Home footer line. A played Daily always counts today (even if history was lost), so the "start a
 * streak" prompt shows only when the streak is 0 and today's Daily is not played. O(n).
 */
export function streakLine(played: readonly string[], today: string, todayPlayed: boolean): string {
  const streak = dailyStreak(todayPlayed ? [...played, today] : played, today);
  return streakText(streak);
}

/**
 * Split the wordmark at its second capital so the second half can take the accent colour
 * ("PowerPlay" -> ["Power", "Play"]). A name with one capital stays whole. O(n).
 */
export function splitWordmark(name: string): [string, string] {
  const i = name.slice(1).search(/[A-Z]/);
  return i < 0 ? [name, ""] : [name.slice(0, i + 1), name.slice(i + 1)];
}

export type DailyStatus = "fresh" | "resume" | "done";
