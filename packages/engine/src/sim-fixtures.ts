/**
 * SYNTHETIC run inputs for engine tests. Every name, id, rating and base rate below is INVENTED
 * ("Synth A", ...) and is not data about any real player, team or game. Never ship this to the UI.
 *
 * PP rosters may include bench skaters beyond the starting strength (see RunInput.pp).
 * Pure builders: each call returns a fresh RunInput (no shared mutable objects), so tests may
 * mutate what they get. Stateless; safe anywhere.
 */
import { PENALTY_S, PERIOD_LENGTH_S, SHOT_OPTIONS } from "./constants.ts";
import type { BaseRateRow, Goalie } from "./likelihood.ts";
import type {
  Clock, GameType, Penalty, PenaltyKind, PkSkater, PpFormationName, PpSkater, RunInput, Score,
} from "./sim-types.ts";

export interface FixtureOpts { seed?: number; askEveryTouch?: boolean; formation?: PpFormationName }

const DEFAULT_SEED = 12345;
const REG: GameType = 2;
const PO: GameType = 3;

/** SYNTHETIC P(goal | unblocked) per distance bucket 0..5 (invented, decreasing with distance). */
const SYNTH_P_BY_BUCKET = [0.25, 0.18, 0.12, 0.08, 0.05, 0.03] as const;
const SYNTH_ATTEMPTS = 100;

/** SYNTHETIC base-rate rows: every shot data key used by SHOT_OPTIONS x every distance bucket. O(K x B). */
export function synthRates(): BaseRateRow[] {
  const keys = new Set<string>();
  for (const o of Object.values(SHOT_OPTIONS)) for (const k of o.dataKeys) keys.add(k);
  const rows: BaseRateRow[] = [];
  for (const k of [...keys].sort()) {
    SYNTH_P_BY_BUCKET.forEach((p, bucket) => {
      rows.push({ shot_type: k, dist_bucket: bucket, attempts: SYNTH_ATTEMPTS, p_unblocked: p });
    });
  }
  return rows;
}

/** SYNTHETIC PP skaters "Synth A".. with invented ratings. O(n). */
const PP_TABLE: readonly Omit<PpSkater, "pos">[] = [
  { id: 101, name: "Synth A", playmakingMult: 1.2, finishingMult: 1.0, puckControlMult: 1.1, accuracy: 0.6, shootsLeft: true, faceoffWinRate: 0.52 },
  { id: 102, name: "Synth B", playmakingMult: 1.0, finishingMult: 1.25, puckControlMult: 1.0, accuracy: 0.65, shootsLeft: false, faceoffWinRate: 0.48 },
  { id: 103, name: "Synth C", playmakingMult: 0.95, finishingMult: 1.1, puckControlMult: 0.9, accuracy: 0.55, shootsLeft: true, faceoffWinRate: 0.55 },
  { id: 104, name: "Synth D", playmakingMult: 1.05, finishingMult: 0.9, puckControlMult: 1.0, accuracy: 0.5, shootsLeft: true, faceoffWinRate: 0.5 },
  { id: 105, name: "Synth E", playmakingMult: 0.9, finishingMult: 1.15, puckControlMult: 0.95, accuracy: 0.6, shootsLeft: false, faceoffWinRate: 0.45 },
  { id: 106, name: "Synth F", playmakingMult: 1.0, finishingMult: 1.0, puckControlMult: 1.0, accuracy: 0.55, shootsLeft: true, faceoffWinRate: 0.5 },
];
const PK_TABLE: readonly PkSkater[] = [
  { id: 201, name: "Synth K", faceoffWinRate: 0.51 },
  { id: 202, name: "Synth L", faceoffWinRate: 0.47 },
  { id: 203, name: "Synth M", faceoffWinRate: 0.53 },
  { id: 204, name: "Synth N", faceoffWinRate: 0.49 },
  { id: 205, name: "Synth O", faceoffWinRate: 0.5 },
];

export function synthPp(n: number): PpSkater[] {
  return PP_TABLE.slice(0, n).map((s) => ({ ...s, pos: { x: 0, y: 0 } }));
}
export function synthPk(n: number): PkSkater[] {
  return PK_TABLE.slice(0, n).map((s) => ({ ...s }));
}
export function synthGoalie(): Goalie {
  return { id: 301, name: "Synth G", gaMult: 1.0, catchesLeft: true };
}

/** Absolute game second of a regulation-or-earlier clock (P1..P3). O(1). */
const regAbs = (period: number, elapsedS: number): number => (period - 1) * PERIOD_LENGTH_S + elapsedS;

function pen(id: number, kind: PenaltyKind, expiresAtS: number | null, side: "pp" | "pk" = "pk"): Penalty {
  return { id, side, kind, expiresAtS, durationS: PENALTY_S[kind] };
}

interface Spec {
  id: string; gameType: GameType; clock: Clock; score: Score; penalties: Penalty[];
  goaliePulled: boolean; pp: number; pk: number;
}

function build(spec: Spec, o: FixtureOpts): RunInput {
  return {
    scenarioId: `synthetic-${spec.id}`,
    seed: o.seed ?? DEFAULT_SEED,
    gameType: spec.gameType,
    clock: { ...spec.clock },
    score: { ...spec.score },
    penalties: spec.penalties.map((p) => ({ ...p })),
    goaliePulled: spec.goaliePulled,
    pp: { skaters: synthPp(spec.pp) },
    pk: { skaters: synthPk(spec.pk), goalie: synthGoalie() },
    rates: synthRates(),
    settings: { askEveryTouch: o.askEveryTouch ?? false, formation: o.formation ?? "umbrella" },
  };
}

/** 5v4, P2 5:00 elapsed, one PK minor with its full 2:00 left. */
export function fiveOnFour(o: FixtureOpts = {}): RunInput {
  const t = regAbs(2, 300);
  return build({ id: "5v4", gameType: REG, clock: { period: 2, elapsedS: 300 }, score: { pp: 1, pk: 1 },
    penalties: [pen(1, "minor", t + PENALTY_S.minor)], goaliePulled: false, pp: 5, pk: 4 }, o);
}

/** Staggered 5v3: the first minor has 1:00 left, the second the full 2:00. */
export const STAGGER_FIRST_LEFT_S = 60;
export function staggeredFiveOnThree(o: FixtureOpts = {}): RunInput {
  const t = regAbs(2, 300);
  return build({ id: "5v3", gameType: REG, clock: { period: 2, elapsedS: 300 }, score: { pp: 0, pk: 0 },
    penalties: [pen(1, "minor", t + STAGGER_FIRST_LEFT_S), pen(2, "minor", t + PENALTY_S.minor)],
    goaliePulled: false, pp: 5, pk: 3 }, o);
}

/** 5v4 on a fresh double minor. */
export function doubleMinor(o: FixtureOpts = {}): RunInput {
  const t = regAbs(1, 600);
  return build({ id: "double-minor", gameType: REG, clock: { period: 1, elapsedS: 600 }, score: { pp: 0, pk: 0 },
    penalties: [pen(1, "double_minor", t + PENALTY_S.double_minor)], goaliePulled: false, pp: 5, pk: 4 }, o);
}

/** 5v4 on a fresh major. */
export function major(o: FixtureOpts = {}): RunInput {
  const t = regAbs(1, 200);
  return build({ id: "major", gameType: REG, clock: { period: 1, elapsedS: 200 }, score: { pp: 0, pk: 1 },
    penalties: [pen(1, "major", t + PENALTY_S.major)], goaliePulled: false, pp: 5, pk: 4 }, o);
}

/** Regular-season OT, 4v3: a minor carried over from regulation with 1:30 left. Tied game. */
export const OT_CARRY_LEFT_S = 90;
export function regOtFourOnThree(o: FixtureOpts = {}): RunInput {
  const t = regAbs(3, PERIOD_LENGTH_S) + 60;
  return build({ id: "ot-4v3", gameType: REG, clock: { period: 4, elapsedS: 60 }, score: { pp: 2, pk: 2 },
    penalties: [pen(1, "minor", t + OT_CARRY_LEFT_S)], goaliePulled: false, pp: 4, pk: 3 }, o);
}

/** 6v4 late in P3: PP trails by one, goalie pulled, PK minor with 1:00 left. */
export function sixOnFourGoaliePulled(o: FixtureOpts = {}): RunInput {
  const t = regAbs(3, 1100);
  return build({ id: "6v4", gameType: REG, clock: { period: 3, elapsedS: 1100 }, score: { pp: 2, pk: 3 },
    penalties: [pen(1, "minor", t + 60)], goaliePulled: true, pp: 6, pk: 4 }, o);
}

/** 5v4 with 5 s left in P1; the minor carries into P2. */
export const LATE_LEFT_S = 5;
export function fiveSecondsLeft(o: FixtureOpts = {}): RunInput {
  const e = PERIOD_LENGTH_S - LATE_LEFT_S;
  const t = regAbs(1, e);
  return build({ id: "5s-left", gameType: REG, clock: { period: 1, elapsedS: e }, score: { pp: 0, pk: 0 },
    penalties: [pen(1, "minor", t + 60)], goaliePulled: false, pp: 5, pk: 4 }, o);
}

/** Playoff 2nd OT (period 5), 5v4, tied. */
export function playoffOt(o: FixtureOpts = {}): RunInput {
  const t = regAbs(3, PERIOD_LENGTH_S) + PERIOD_LENGTH_S + 100;
  return build({ id: "playoff-ot", gameType: PO, clock: { period: 5, elapsedS: 100 }, score: { pp: 3, pk: 3 },
    penalties: [pen(1, "minor", t + 100)], goaliePulled: false, pp: 5, pk: 4 }, o);
}

/** 5v3 with a third PK minor queued behind the two active ones. */
export function thirdPenaltyQueued(o: FixtureOpts = {}): RunInput {
  const t = regAbs(2, 900);
  return build({ id: "queued", gameType: REG, clock: { period: 2, elapsedS: 900 }, score: { pp: 1, pk: 2 },
    penalties: [pen(1, "minor", t + 40), pen(2, "minor", t + 100), pen(3, "minor", null)],
    goaliePulled: false, pp: 5, pk: 3 }, o);
}

/**
 * Regulation 4v3 with a PP-side minor that expires first: 4v3 -> 5v3 (+30 s) -> 5v4 (+90 s) -> 5v5 (+120 s).
 * The input lists 5 PP skaters: 4 start on the ice, the 5th is the bench skater who joins at +30 s.
 */
export const PP_PEN_LEFT_S = 30;
export const FOUR_THREE_FIRST_PK_LEFT_S = 90;
export function fourOnThreePpPenalty(o: FixtureOpts = {}): RunInput {
  const t = regAbs(2, 400);
  return build({ id: "4v3-pp-penalty", gameType: REG, clock: { period: 2, elapsedS: 400 }, score: { pp: 1, pk: 1 },
    penalties: [pen(1, "minor", t + PP_PEN_LEFT_S, "pp"), pen(2, "minor", t + FOUR_THREE_FIRST_PK_LEFT_S),
      pen(3, "minor", t + PENALTY_S.minor)],
    goaliePulled: false, pp: 5, pk: 3 }, o);
}

/** Regular-season OT with an offsetting-then-expiring PP minor: 4v3 now, 5v3 once the PP minor ends. */
export function regOtPpPenalty(o: FixtureOpts = {}): RunInput {
  const t = regAbs(3, PERIOD_LENGTH_S) + 30;
  return build({ id: "ot-pp-penalty", gameType: REG, clock: { period: 4, elapsedS: 30 }, score: { pp: 2, pk: 2 },
    penalties: [pen(1, "minor", t + 20, "pp"), pen(2, "minor", t + 80), pen(3, "minor", t + 110)],
    goaliePulled: false, pp: 5, pk: 3 }, o);
}

/** Every builder by name, for loops in tests and fuzzers. */
export const ALL_FIXTURES: Readonly<Record<string, (o?: FixtureOpts) => RunInput>> = {
  fiveOnFour, staggeredFiveOnThree, doubleMinor, major, regOtFourOnThree, sixOnFourGoaliePulled,
  fiveSecondsLeft, playoffOt, thirdPenaltyQueued, fourOnThreePpPenalty, regOtPpPenalty,
};

