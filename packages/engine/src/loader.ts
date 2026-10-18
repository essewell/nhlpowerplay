/**
 * Turns one exported scenario + rating tables + base rates into an engine RunInput, and reports
 * every place a default or fallback was used (RatingFlag for ratings, ShapeFallback for scenario
 * fields older exports lack) so the UI can say so. Only returns inputs sim.initRun accepts.
 *
 * Stateless and pure: safe in a Web Worker and on the server. No randomness, no clock.
 * Data truth: no numbers are typed here. Defaults are either the rating scale's definition of
 * league average (multiplier 1), a constants.ts tunable, or computed from base_rates.
 */
import { FACEOFF, PENALTY_S } from "./constants.ts";
import { absS, maxPpStrength, strengthOf } from "./clock.ts";
import { placePp, spotPos } from "./formation.ts";
import type { BaseRateRow, Goalie } from "./likelihood.ts";
import { err, ok, type Result } from "./result.ts";
import {
  parseStrength, SCOPE_ALL, type BaseRatesFile, type FaceoffRatingRow, type GoalieRatingRow,
  type PlaymakerRatingRow, type Scenario, type ScenarioPenalty, type ScenarioSkater, type ShooterRatingRow,
} from "./schema.ts";
import { initRun } from "./sim.ts";
import type {
  Clock, GameType, Penalty, PenaltyKind, PkSkater, PpFormationName, PpSkater, RunInput,
} from "./sim-types.ts";

/** Rating multipliers are scaled so 1 is league average (pipeline ratings.py); used when a rating is missing. */
const LEAGUE_AVERAGE_MULT = 1;
/** The only strengths whose penalty state can be inferred from pp_remaining_s alone (one PK penalty). */
const FALLBACK_STRENGTHS: Readonly<Record<string, { goaliePulled: boolean }>> = {
  "5v4": { goaliePulled: false },
  "6v4": { goaliePulled: true },
};
/** NHL game ids start with the season's first year (e.g. 2023020204 -> 2023-24). */
const GAME_ID_YEAR_DIGITS = 4;

export type RatingField = "shooter" | "goalie" | "faceoff" | "playmaker" | "catches_left" | "shoots_left";
export type RatingFlagReason =
  | "missing"                       // no usable row: league-average default used
  | "low_sample_fallback_all"       // season row is low-sample: career ("all") row used
  | "season_missing_fallback_all"   // no season row: career ("all") row used
  | "unknown_catch_hand"            // not in the export: default catchesLeft = true
  | "unknown_shoot_hand";           // not in the export: default shootsLeft = true
export interface RatingFlag { playerId: number; field: RatingField; reason: RatingFlagReason }

/** A scenario field absent from an older export and filled by an explicit fallback. */
export interface ShapeFallback { field: "penalties" | "goalie_pulled" | "bench"; detail: string }

export interface RatingTables {
  shooter: readonly ShooterRatingRow[];
  goalie: readonly GoalieRatingRow[];
  faceoff: readonly FaceoffRatingRow[];
  playmaker: readonly PlaymakerRatingRow[];
}
type Keyed = { player_id: number; scope: string };
/** Rows by "<player_id>|<scope>". */
export type RatingIndex<T extends Keyed> = ReadonlyMap<string, T>;
export interface RatingIndexes {
  shooter: RatingIndex<ShooterRatingRow>;
  goalie: RatingIndex<GoalieRatingRow>;
  faceoff: RatingIndex<FaceoffRatingRow>;
  playmaker: RatingIndex<PlaymakerRatingRow>;
}
export interface LoadOpts { formation: PpFormationName; askEveryTouch: boolean }
export interface Loaded { input: RunInput; flags: RatingFlag[]; fallbacks: ShapeFallback[] }

const keyOf = (playerId: number, scope: string): string => `${playerId}|${scope}`;

/** Index rating rows by (player_id, scope). Duplicate keys are an error. O(N). */
export function indexRatings<T extends Keyed>(rows: readonly T[]): Result<RatingIndex<T>> {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = keyOf(r.player_id, r.scope);
    if (m.has(k)) return err(`duplicate rating row for player ${r.player_id}, scope ${r.scope}`);
    m.set(k, r);
  }
  return ok(m);
}

/** Index all four tables once; pass the result to loadScenario to load many scenarios in O(1) per lookup. O(N). */
export function indexAllRatings(t: RatingTables): Result<RatingIndexes> {
  const shooter = indexRatings(t.shooter);
  if (!shooter.ok) return err(`shooter_ratings: ${shooter.error}`);
  const goalie = indexRatings(t.goalie);
  if (!goalie.ok) return err(`goalie_ratings: ${goalie.error}`);
  const faceoff = indexRatings(t.faceoff);
  if (!faceoff.ok) return err(`faceoff_ratings: ${faceoff.error}`);
  const playmaker = indexRatings(t.playmaker);
  if (!playmaker.ok) return err(`playmaker_ratings: ${playmaker.error}`);
  return ok({ shooter: shooter.value, goalie: goalie.value, faceoff: faceoff.value, playmaker: playmaker.value });
}

/** Season scope ("20232024") from an NHL game id. O(1). */
export function seasonScope(nhlGameId: number): Result<string> {
  const s = String(nhlGameId);
  if (!/^\d{10}$/.test(s)) return err(`invalid NHL game id ${nhlGameId}`);
  const y = Number(s.slice(0, GAME_ID_YEAR_DIGITS));
  return ok(`${y}${y + 1}`);
}

/**
 * League on-net share of the unblocked shots in base_rates (scope "all"): sum(on_net) / sum(attempts).
 * The default accuracy for shooters without a rating; computed, never typed. O(R).
 */
export function leagueOnNetShare(rows: BaseRatesFile): Result<number> {
  let attempts = 0, onNet = 0;
  for (const r of rows) {
    if (r.scope !== SCOPE_ALL) continue;
    attempts += r.attempts;
    onNet += r.on_net;
  }
  if (attempts === 0) return err("base_rates has no scope \"all\" attempts; cannot compute league on-net share");
  const share = onNet / attempts;
  if (!(share > 0 && share <= 1)) return err(`league on-net share ${share} is outside (0, 1]`);
  return ok(share);
}

/**
 * Season row unless missing or low-sample, then the "all" row, then null (caller defaults).
 * Pushes a flag whenever the season row is not used. O(1).
 */
function pick<T extends Keyed>(idx: RatingIndex<T>, playerId: number, season: string, field: RatingField,
  isLow: (r: T) => boolean, flags: RatingFlag[]): T | null {
  const s = idx.get(keyOf(playerId, season));
  if (s !== undefined && !isLow(s)) return s;
  const all = idx.get(keyOf(playerId, SCOPE_ALL));
  if (all !== undefined) {
    flags.push({ playerId, field, reason: s === undefined ? "season_missing_fallback_all" : "low_sample_fallback_all" });
    return all;
  }
  flags.push({ playerId, field, reason: "missing" });
  return null;
}
const lowSample = (r: { low_sample: 0 | 1 }): boolean => r.low_sample === 1;
const neverLow = (): boolean => false;

/** Sweater number, then id: a stable, data-derived order. O(n log n). */
const byNumber = (a: ScenarioSkater, b: ScenarioSkater): number => a.number - b.number || a.id - b.id;
const fullName = (p: { first: string; last: string }): string => `${p.first} ${p.last}`;

/** Penalty kind implied by the time left on a lone PP-creating penalty (fallback only). O(1). */
function kindFromRemaining(remainingS: number): Result<PenaltyKind> {
  if (remainingS <= PENALTY_S.minor) return ok("minor");
  if (remainingS <= PENALTY_S.double_minor) return ok("double_minor");
  if (remainingS <= PENALTY_S.major) return ok("major");
  return err(`pp_remaining_s ${remainingS} is longer than any single penalty (${PENALTY_S.major} s); cannot infer penalties`);
}

/** Export penalties -> engine penalties with absolute expiry. O(K). */
function toEnginePenalties(ps: readonly ScenarioPenalty[], now: number): Penalty[] {
  return ps.map((p, i) => ({
    id: i + 1,
    side: p.side,
    kind: p.kind,
    expiresAtS: p.queued ? null : now + p.remaining_s,
    durationS: PENALTY_S[p.kind],
  }));
}

/** Penalties and goalie state, from the export or by flagged fallback. O(K). */
function penaltyState(sc: Scenario, clock: Clock, gt: GameType, now: number, fallbacks: ShapeFallback[]):
  Result<{ penalties: Penalty[]; goaliePulled: boolean }> {
  const st = sc.state;
  const strength = parseStrength(st.strength);
  if (strength === null) return err(`invalid strength ${st.strength}`);
  if (st.penalties !== undefined) {
    const penalties = toEnginePenalties(st.penalties, now);
    if (st.goalie_pulled !== undefined) return ok({ penalties, goaliePulled: st.goalie_pulled });
    // The penalties fix the skater count without the goalie; one extra PP skater means he is pulled.
    const base = strengthOf(penalties, false, clock.period, gt);
    if (!base.ok) return base;
    const goaliePulled = strength.pp === base.value.pp + 1;
    fallbacks.push({ field: "goalie_pulled", detail: `absent; inferred ${goaliePulled} from strength ${st.strength} and penalties` });
    return ok({ penalties, goaliePulled });
  }
  const fb = FALLBACK_STRENGTHS[st.strength];
  if (fb === undefined) {
    return err(`scenario ${sc.id}: state.penalties is absent and strength ${st.strength} cannot be inferred (only ${Object.keys(FALLBACK_STRENGTHS).join(", ")})`);
  }
  const kind = kindFromRemaining(st.pp_remaining_s);
  if (!kind.ok) return err(`scenario ${sc.id}: ${kind.error}`);
  const penalties = toEnginePenalties([{ side: "pk", player_id: null, kind: kind.value, remaining_s: st.pp_remaining_s, queued: false }], now);
  fallbacks.push({ field: "penalties", detail: `absent; one PK ${kind.value} with ${st.pp_remaining_s} s left inferred from pp_remaining_s` });
  const goaliePulled = st.goalie_pulled ?? fb.goaliePulled;
  if (st.goalie_pulled === undefined) {
    fallbacks.push({ field: "goalie_pulled", detail: `absent; ${goaliePulled} inferred from strength ${st.strength}` });
  }
  return ok({ penalties, goaliePulled });
}

/**
 * Position of each roster skater: on-ice skaters from the start formation; a bench skater gets the
 * spot the formation would give it when it joins (cosmetic: the sim re-derives positions from spots).
 * O(n^2) for n <= 6 roster skaters.
 */
function rosterPositions(ids: number[], onIce: number, formation: PpFormationName): Result<Map<number, { x: number; y: number }>> {
  const out = new Map<number, { x: number; y: number }>();
  const first = ids[0];
  if (first === undefined) return err("no PP skaters");
  for (let n = onIce; n <= ids.length; n++) {
    const placed = placePp(ids.slice(0, n), formation, first);
    if (!placed.ok) return placed;
    for (const s of placed.value) if (!out.has(s.id)) out.set(s.id, spotPos(s.spot));
  }
  return ok(out);
}

/**
 * Build a RunInput from a validated scenario. Season ratings from game.nhl_game_id; fallbacks flagged.
 * O(N) when given raw rating tables (indexing), O(S + R + K^3) when given RatingIndexes.
 */
export function loadScenario(sc: Scenario, ratings: RatingTables | RatingIndexes, baseRates: BaseRatesFile,
  opts: LoadOpts): Result<Loaded> {
  const idx = Array.isArray(ratings.shooter) ? indexAllRatings(ratings as RatingTables) : ok(ratings as RatingIndexes);
  if (!idx.ok) return idx;
  const R = idx.value;
  const season = seasonScope(sc.game.nhl_game_id);
  if (!season.ok) return season;
  const gt: GameType = sc.game.game_type;
  const clock: Clock = { period: sc.state.period, elapsedS: sc.state.clock_elapsed_s };
  const now = absS(clock, gt);
  if (!now.ok) return err(`scenario ${sc.id}: ${now.error}`);
  const accuracyDefault = leagueOnNetShare(baseRates);
  if (!accuracyDefault.ok) return accuracyDefault;

  const flags: RatingFlag[] = [];
  const fallbacks: ShapeFallback[] = [];
  const ps = penaltyState(sc, clock, gt, now.value, fallbacks);
  if (!ps.ok) return ps;
  const { penalties, goaliePulled } = ps.value;

  const bench = sc.pp.bench;
  if (bench === undefined) fallbacks.push({ field: "bench", detail: "absent; no bench skaters available" });
  const onIce = [...sc.pp.skaters].sort(byNumber);
  const need = maxPpStrength(penalties, goaliePulled, clock, gt);
  if (!need.ok) return err(`scenario ${sc.id}: ${need.error}`);
  const listed = [...onIce, ...[...(bench ?? [])].sort(byNumber)];
  if (listed.length < need.value) {
    return err(`scenario ${sc.id}: the penalty timeline reaches ${need.value} PP skaters but only ${listed.length} are listed (on ice ${onIce.length} + bench ${bench?.length ?? 0})`);
  }
  const roster = listed.slice(0, Math.max(need.value, onIce.length));
  const pos = rosterPositions(roster.map((p) => p.id), onIce.length, opts.formation);
  if (!pos.ok) return err(`scenario ${sc.id}: ${pos.error}`);

  const ppSkaters: PpSkater[] = [];
  for (const p of roster) {
    const at = pos.value.get(p.id);
    if (at === undefined) return err(`scenario ${sc.id}: no position for PP skater ${p.id}`);
    const shot = pick(R.shooter, p.id, season.value, "shooter", lowSample, flags);
    const play = pick(R.playmaker, p.id, season.value, "playmaker", neverLow, flags);
    const fo = pick(R.faceoff, p.id, season.value, "faceoff", neverLow, flags);
    flags.push({ playerId: p.id, field: "shoots_left", reason: "unknown_shoot_hand" });
    ppSkaters.push({
      id: p.id,
      name: fullName(p),
      pos: at,
      playmakingMult: play?.playmaking_mult ?? LEAGUE_AVERAGE_MULT,
      finishingMult: shot?.finishing_mult ?? LEAGUE_AVERAGE_MULT,
      puckControlMult: LEAGUE_AVERAGE_MULT, // ASSUMPTION: no carry metric in the export yet
      accuracy: shot?.accuracy ?? accuracyDefault.value,
      shootsLeft: true,
      faceoffWinRate: fo?.win_rate ?? FACEOFF.PRIOR_RATE,
    });
  }
  const pkSkaters: PkSkater[] = [...sc.pk.skaters].sort(byNumber).map((p) => {
    const fo = pick(R.faceoff, p.id, season.value, "faceoff", neverLow, flags);
    return { id: p.id, name: fullName(p), faceoffWinRate: fo?.win_rate ?? FACEOFF.PRIOR_RATE };
  });
  const g = sc.pk.goalie;
  const gr = pick(R.goalie, g.id, season.value, "goalie", lowSample, flags);
  flags.push({ playerId: g.id, field: "catches_left", reason: "unknown_catch_hand" });
  const goalie: Goalie = { id: g.id, name: fullName(g), gaMult: gr?.ga_mult ?? LEAGUE_AVERAGE_MULT, catchesLeft: true };

  const rates: BaseRateRow[] = baseRates.filter((r) => r.scope === SCOPE_ALL)
    .map((r) => ({ shot_type: r.shot_type, dist_bucket: r.dist_bucket, attempts: r.attempts, p_unblocked: r.p_unblocked }));

  const input: RunInput = {
    scenarioId: sc.id,
    seed: sc.seed,
    gameType: gt,
    clock,
    score: { pp: sc.state.score.pp, pk: sc.state.score.pk },
    penalties,
    goaliePulled,
    pp: { skaters: ppSkaters },
    pk: { skaters: pkSkaters, goalie },
    rates,
    settings: { askEveryTouch: opts.askEveryTouch, formation: opts.formation },
  };
  const check = initRun(input);
  if (!check.ok) return err(`scenario ${sc.id}: engine rejected the input: ${check.error}`);
  return ok({ input, flags, fallbacks });
}
