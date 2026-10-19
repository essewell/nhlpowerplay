/**
 * Plain-data types for a simulated power-play run. Everything is JSON-serialisable so a run can
 * be persisted, posted to a Web Worker, or replayed on the server from (RunInput, Call[]).
 * Types only: no runtime code, no state.
 *
 * Time: integer seconds. `Clock.elapsedS` counts up within a period; penalty expiry is stored in
 * ABSOLUTE game seconds (sum of earlier period lengths + elapsed), so carry-over across periods
 * needs no bookkeeping. See clock.ts for the conversions.
 */
import type { SetPlayId, ShotOption, SpotName } from "./constants.ts";
import type { BaseRateRow, Corner, Goalie, Skater, Vec2 } from "./likelihood.ts";

export type Side = "pp" | "pk";
export type PenaltyKind = "minor" | "double_minor" | "major";

export interface Penalty {
  id: number;
  side: Side;
  kind: PenaltyKind;
  /** Absolute game second it expires; null while queued behind the 2 active penalties. */
  expiresAtS: number | null;
  /** Full length in seconds; a queued penalty starts with this when promoted. */
  durationS: number;
  /**
   * NHL Rule 19.1: one minor per team at a stoppage with nothing else on the clocks, both served at
   * 4v4 without substitution. The seat is a skater down on its side like any other penalty, but a
   * goal never releases it (Rule 16.2, "except when coincidental penalties are being served"; Table 12
   * example G4). Absent means false.
   */
  coincidental?: boolean;
}

/** NHL API gameType: 2 = regular season, 3 = playoffs. */
export type GameType = 2 | 3;
export interface Clock { period: number; elapsedS: number }
export interface Score { pp: number; pk: number }
export interface Strength { pp: number; pk: number }

export type FaceoffDot = "oz_left" | "oz_right" | "centre";
export type FaceoffTarget = "point" | "half_wall" | "back";
export type EntryMethod = "carry" | "dump" | "drop";
/** Which lane the entry attacks, from the attacking team's view (y > 0 is left). */
export type EntryLane = "left" | "middle" | "right";
export type BreakoutMethod = "carry" | "pass" | "rim";

export type Carrier = { kind: "pp"; id: number } | { kind: "pk" } | { kind: "loose" };
export type EndReason = "pp_expired" | "sh_goal" | "cleared_out" | "game_end";
export type EndDetail = "ot_goal" | "shootout" | "regulation_end" | "empty_net" | null;

export type Phase =
  | { kind: "faceoff"; dot: FaceoffDot }
  | { kind: "decision" }                 // puck on a PP stick in the offensive zone
  | { kind: "zone_entry" }
  | { kind: "breakout" }                 // only reached when settings.askEveryTouch
  | { kind: "ended"; reason: EndReason; detail: EndDetail };

/** Player-chosen PP setups. "overload" stacks the side of the puck (mirrors left/right with the play). */
export type PpFormationName = "umbrella" | "one_three_one" | "overload" | "spread";

export interface PpSkater extends Skater {
  /** Shrunk faceoff win rate from ratings (pipeline FACEOFF_PRIOR_RATE when unknown). */
  faceoffWinRate: number;
}
export interface PkSkater { id: number; name: string; faceoffWinRate: number }

export interface RunInput {
  scenarioId: string;
  /** uint32 seed; all randomness in the run comes from it. */
  seed: number;
  gameType: GameType;
  clock: Clock;
  score: Score;
  penalties: Penalty[];
  goaliePulled: boolean;
  /**
   * PP skaters in priority order, on-ice skaters first, then bench skaters. Length must be at
   * least the highest PP strength the penalty timeline can reach (clock.maxPpStrength, e.g. 5 for a
   * 4v3 whose PP minor ends first) and at most BASE_SKATERS (+1 while the goalie is pulled). The
   * first starting-strength skaters start on the ice. When strength rises (a PP-side penalty ends),
   * the earliest absent skaters join; when it drops, the non-carrier skaters latest in this order leave.
   */
  pp: { skaters: PpSkater[] };
  pk: { skaters: PkSkater[]; goalie: Goalie };
  rates: BaseRateRow[];
  /** Fixed for the whole run and part of the replay key (it changes the call sequence). */
  settings: { askEveryTouch: boolean; formation: PpFormationName };
}

export type Call =
  | { type: "pass"; to: number }
  | { type: "skate"; to: SpotName }
  | { type: "shoot"; option: ShotOption; corner: Corner }
  | { type: "set_play"; id: SetPlayId }
  /** `formation` applies if the PP wins an offensive-zone draw; omitted = keep the current one. */
  | { type: "faceoff"; takerId: number; target: FaceoffTarget; formation?: PpFormationName }
  /** `lane` decides where the entry lands; `formation` is the setup after a clean entry.
   *  Both optional for replay of older calls (default: middle / current formation). */
  | { type: "zone_entry"; method: EntryMethod; lane?: EntryLane; formation?: PpFormationName }
  | { type: "breakout"; method: BreakoutMethod };

/** One resolved step, for animation, review and debugging. `p`/`u` are logged for every draw. */
export interface RunEvent {
  i: number;
  callIndex: number | null;   // null for auto-played steps
  atS: number;                // absolute game seconds
  clock: Clock;
  kind: string;
  p?: number;
  u?: number;
  detail?: Record<string, string | number | boolean>;
}

export interface RunState {
  v: 1;
  /** uint32 PRNG state for modes.prngNext. */
  rng: number;
  /** Number of calls applied; the next call must carry callIndex === callCount. */
  callCount: number;
  step: number;
  clock: Clock;
  penalties: Penalty[];
  score: Score;
  goaliePulled: boolean;
  phase: Phase;
  puck: Vec2;
  carrier: Carrier;
  /** PP skater positions are named OZ_SPOTS. */
  ppSpots: { id: number; spot: SpotName }[];
  /** Defender positions (from PK templates, deterministic). */
  pkPos: Vec2[];
  /** True right after a PP goal; the machine shows a celebration, then a centre faceoff. */
  justScored: boolean;
  /** Current PP setup (starts as settings.formation; changed by entry / OZ faceoff calls). */
  formation: PpFormationName;
  /** Strong side for "overload"; ignored by the other formations. */
  formationSide: "left" | "right";
  log: RunEvent[];
}

/** One option offered to the player. `p` is exactly the probability sampled if chosen. */
export interface CallOption {
  call: Call;
  p: number;
  breakdown: Record<string, number>;
  durationS: number;
  /** True if the clock (PP end or period end) would run out before it resolves. */
  cutByClock: boolean;
}

/*
 * API contract (implemented in clock.ts and sim.ts; every function returns Result unless noted).
 *
 * clock.ts — pure helpers, all O(K) for K penalties unless noted:
 *   periodLengthS(period, gameType): Result<number>                         O(1)
 *   absS(clock, gameType): Result<number>                                   O(period)
 *   clockAt(abs, gameType): Result<Clock>                                   O(period)
 *   strengthOf(penalties, goaliePulled, period, gameType): Result<Strength>
 *   ppActive(penalties): boolean            PK has more active penalties than PP
 *   expireUpTo(penalties, abs, inclusive): Penalty[]   drop expired (< abs, or <= if inclusive), promote queued
 *   releaseOnGoal(penalties, abs): Penalty[]           PP goal: earliest PK minor ends, double minor -> 120 s left, major stays
 *   ppEndS(penalties): number | null                   absolute second the advantage ends if nothing happens
 *   nextBoundaryS(penalties, clock, gameType): Result<number>   min(ppEndS, end of current period), absolute
 *   endPeriod(clock, score, gameType): Result<{ next: Clock } | { ended: EndDetail }>
 *
 * sim.ts:
 *   initRun(input): Result<RunState>
 *   legalCalls(state, input): Result<CallOption[]>
 *   applyCall(state, input, call, callIndex): Result<RunState>   resolves the call, then auto-plays to the next pause
 *   autoPlay(state, input, policy, maxCalls): Result<RunState>   policy: (options, state) => Call
 *   replay(input, calls): Result<RunState>
 */
