/**
 * Scenario -> ScenarioView (contracts.ts). Pure; safe on main thread and in the run worker.
 * Everything shown comes from the export: no game facts are typed here, only code -> label maps.
 */
import { parseStrength, type Scenario } from "@powerplay/engine/schema.ts";
import type { ScenarioView } from "./contracts.ts";

/**
 * Export stage code -> label shown in the UI. Unknown codes map to null (the UI hides the chip).
 * "SCF" is shown as "Final" on purpose: the full trademarked name stays out of the UI (user decision).
 * "R" -> "Playoffs" is as specified for v1.
 */
export const STAGE_TEXT: Readonly<Record<string, string>> = {
  P: "Playoffs",
  R: "Playoffs",
  CONF_FINAL: "Conference Final",
  SCF: "Final",
};

/** NHL game ids are 10 digits: SSSS (season) TT (type) RR (round) M (matchup) G (game of the series). */
const NHL_ID_DIGITS = 10;
const PLAYOFF_TYPE_CODE = "03";
const TYPE_DIGITS_START = 4;
const TYPE_DIGITS_END = 6;
const PLAYOFF_GAME_TYPE = 3;

/** "P" -> "Playoffs"; null when the code is unknown. O(1). */
export function stageText(code: string): string | null {
  return Object.hasOwn(STAGE_TEXT, code) ? (STAGE_TEXT[code] ?? null) : null;
}

/**
 * Game number within a playoff series, from the last digit of the NHL game id (…111 -> 1, …115 -> 5).
 * null for regular-season games, malformed ids, or a 0 game digit. O(1).
 */
export function gameNumberFromId(nhlGameId: number, gameType: number): number | null {
  if (gameType !== PLAYOFF_GAME_TYPE || !Number.isSafeInteger(nhlGameId) || nhlGameId < 0) return null;
  const digits = String(nhlGameId);
  if (digits.length !== NHL_ID_DIGITS) return null;
  if (digits.slice(TYPE_DIGITS_START, TYPE_DIGITS_END) !== PLAYOFF_TYPE_CODE) return null;
  const game = Number(digits.slice(-1));
  return game >= 1 ? game : null;
}

/** Build the UI view of a validated scenario. O(players). */
export function toScenarioView(sc: Scenario): ScenarioView {
  const strength = parseStrength(sc.state.strength) ?? { pp: sc.pp.skaters.length, pk: sc.pk.skaters.length };
  const players: ScenarioView["players"] = {};
  const everyone = [...sc.pp.skaters, ...(sc.pp.bench ?? []), sc.pp.goalie, ...sc.pk.skaters, sc.pk.goalie];
  for (const p of everyone) players[p.id] = { number: p.number, first: p.first, last: p.last, pos: p.pos };
  // The schema requires a narrative today; if the pipeline makes it optional for mined scenarios this
  // yields null for them automatically (stakes = curated narrative only).
  const title = (sc as { narrative?: { title?: string } }).narrative?.title;
  return {
    id: sc.id,
    teams: { pp: sc.pp.abbrev, pk: sc.pk.abbrev },
    score: { pp: sc.state.score.pp, pk: sc.state.score.pk },
    period: sc.state.period,
    clockElapsedS: sc.state.clock_elapsed_s,
    strength,
    stageText: stageText(sc.game.stage),
    gameNumber: gameNumberFromId(sc.game.nhl_game_id, sc.game.game_type),
    stakes: title !== undefined && title.length > 0 ? title : null,
    players,
    gameType: sc.game.game_type,
    realOutcome: {
      result: sc.real_outcome.result,
      scorerId: sc.real_outcome.scorer_id,
      assistIds: [sc.real_outcome.assist1_id, sc.real_outcome.assist2_id],
      endT: sc.real_outcome.end_t,
    },
  };
}
