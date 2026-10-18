/**
 * Clock and scoreboard text for the decision pause. Pure over the run snapshot; no DOM, no clock.
 * Everything comes from the engine clock helpers (absS, ppEndS, strengthOf): the UI invents no time.
 * Complexity: O(period + K^3) for K penalties (ppEndS), K <= 4.
 */
import { absS, periodLengthS, ppEndS, strengthOf } from "@powerplay/engine/clock.ts";
import { err, ok, type Result } from "@powerplay/engine/result.ts";
import type { Clock, GameType, Penalty, Strength } from "@powerplay/engine/sim-types.ts";
import type { RunSnapshot } from "../contracts.ts";

const SECONDS_PER_MINUTE = 60;
const CLOCK_PLACEHOLDER = "--:--";

/** Seconds -> "m:ss" ("12:05"). Fractions floor; negatives clamp to 0:00; non-finite gives "--:--". */
export function formatClock(totalS: number): string {
  if (!Number.isFinite(totalS)) return CLOCK_PLACEHOLDER;
  const s = Math.max(0, Math.floor(totalS));
  const m = Math.floor(s / SECONDS_PER_MINUTE);
  return `${m}:${String(s % SECONDS_PER_MINUTE).padStart(2, "0")}`;
}

/** Time left in the period (what a scoreboard shows). Error if the clock is outside its period. */
export function periodClockLeftS(clock: Clock, gameType: GameType): Result<number> {
  const len = periodLengthS(clock.period, gameType);
  if (!len.ok) return len;
  if (!Number.isInteger(clock.elapsedS) || clock.elapsedS < 0 || clock.elapsedS > len.value) {
    return err(`elapsedS ${clock.elapsedS} out of range for period ${clock.period}`);
  }
  return ok(len.value - clock.elapsedS);
}

/** Seconds of power play left (engine ppEndS - now). null when no advantage is running. Never negative. */
export function ppRemainingS(
  penalties: readonly Penalty[],
  clock: Clock,
  gameType: GameType,
): Result<number | null> {
  const now = absS(clock, gameType);
  if (!now.ok) return now;
  const end = ppEndS(penalties);
  return ok(end === null ? null : Math.max(0, end - now.value));
}

export interface ScoreboardModel {
  periodNumber: number;
  /** Time left in the period, "m:ss". */
  periodClock: string;
  /** Time left on the power play, "m:ss"; null when the advantage is over. */
  ppClock: string | null;
  strength: Strength;
  score: { pp: number; pk: number };
}

/** Everything the scoreboard prints. Errors (bad clock, impossible penalties) are returned, not thrown. */
export function scoreboardModel(s: Pick<RunSnapshot, "state" | "input">): Result<ScoreboardModel> {
  const { state, input } = s;
  const left = periodClockLeftS(state.clock, input.gameType);
  if (!left.ok) return left;
  const pp = ppRemainingS(state.penalties, state.clock, input.gameType);
  if (!pp.ok) return pp;
  const strength = strengthOf(state.penalties, state.goaliePulled, state.clock.period, input.gameType);
  if (!strength.ok) return strength;
  return ok({
    periodNumber: state.clock.period,
    periodClock: formatClock(left.value),
    ppClock: pp.value === null ? null : formatClock(pp.value),
    strength: strength.value,
    score: { pp: state.score.pp, pk: state.score.pk },
  });
}
