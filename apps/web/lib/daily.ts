/**
 * Daily scenario: one per calendar date in America/Vancouver (docs/LAUNCH.md), identical for everyone.
 * Pure helpers plus `getDaily()`. No clock reads except the `now` argument default in getDaily.
 */
import { dailyScenario } from "@powerplay/engine/modes.ts";
import { err, ok, type Result } from "@powerplay/engine/result.ts";
import type { ScheduleFile } from "@powerplay/engine/schema.ts";
import type { DailyInfo, Loadable } from "./contracts.ts";
import { defaultSource, type DataSource } from "./data.ts";
import { toScenarioView } from "./view.ts";

/** The rollover zone: the Daily changes at midnight here, wherever the player is. */
export const DAILY_TIME_ZONE = "America/Vancouver";
const MS_PER_DAY = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** YYYY-MM-DD of `at` in America/Vancouver. Formatting only (Intl handles DST); O(1). */
export function vancouverDate(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: DAILY_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(at);
  const pick = (t: string): string => parts.find((p) => p.type === t)?.value ?? "";
  return `${pick("year")}-${pick("month")}-${pick("day")}`;
}

/** Whole calendar days from `from` to `to` (both YYYY-MM-DD); null if either is malformed. O(1). */
export function daysBetween(from: string, to: string): number | null {
  const a = ISO_DATE.exec(from);
  const b = ISO_DATE.exec(to);
  if (a === null || b === null) return null;
  const utc = (m: RegExpExecArray): number => Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Math.round((utc(b) - utc(a)) / MS_PER_DAY);
}

export interface DailyPick { scenarioId: string; number: number }

/**
 * Scenario id + Daily number for `date`.
 * - Date in the schedule: scenario from the schedule row; number = 1-based row index.
 * - Date outside the schedule: the engine's deterministic pick from `pool`; number = whole days since
 *   the first schedule date + 1, floored at 1 (a date before the schedule starts is #1; an empty
 *   schedule is #1).
 * O(S + P log P).
 */
export function pickDaily(date: string, schedule: ScheduleFile, pool: readonly string[]): Result<DailyPick> {
  const picked = dailyScenario(date, [...schedule], [...pool]);
  if (!picked.ok) return picked;
  const idx = schedule.findIndex((r) => r.date === date);
  if (idx >= 0) return ok({ scenarioId: picked.value, number: idx + 1 });
  const first = schedule[0];
  if (first === undefined) return ok({ scenarioId: picked.value, number: 1 });
  const since = daysBetween(first.date, date);
  if (since === null) return err(`bad date ${date}`);
  return ok({ scenarioId: picked.value, number: Math.max(1, since + 1) });
}

/** Today's Daily (Vancouver date of `now`). Never rejects. */
export async function getDaily(source: DataSource = defaultSource(), now: Date = new Date()): Promise<Loadable<DailyInfo>> {
  const b = await source.bundle();
  if (!b.ok) return { status: "error", message: b.error };
  const date = vancouverDate(now);
  if (b.value.schedule.length === 0 && b.value.endlessIndex.length === 0) return { status: "empty" };
  const pick = pickDaily(date, b.value.schedule, b.value.endlessIndex);
  if (!pick.ok) return { status: "error", message: pick.error };
  const sc = await source.scenario(pick.value.scenarioId);
  if (!sc.ok) return { status: "error", message: sc.error };
  return { status: "ready", value: { date, number: pick.value.number, scenario: toScenarioView(sc.value) } };
}
