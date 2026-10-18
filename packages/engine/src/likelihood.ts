/**
 * Likelihood model behind every option's subtext ("Pass to Kucherov · 78% connects").
 *
 * Pure functions, no I/O, no randomness, no module state: safe in Web Workers
 * and on the server. Errors are returned as Result values, never thrown, so the
 * UI can show "n/a" instead of crashing; nothing fails silently.
 *
 * Complexity: each call is O(D) for D defenders (D <= 5).
 */
import {
  BLOCK, DISTANCE_BUCKETS_FT, GOAL_CAP, MIN_BASE_SAMPLE, NET, OZ_SPOTS, PASS, SHOT_OPTIONS, SKATE,
  ZONE_ACCURACY, ZONE_FACTOR, type NetZone, type ShotOption, type SpotName,
} from "./constants.ts";

export type Vec2 = { x: number; y: number };
export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface Skater {
  id: number;
  name: string;
  pos: Vec2;
  playmakingMult: number;   // from playmaker_ratings (1 = league average)
  finishingMult: number;    // from shooter_ratings
  puckControlMult: number;  // ASSUMPTION until a carry metric exists; default 1
  accuracy: number;         // shooter_ratings.accuracy: on-net share of unblocked PP shots
  shootsLeft: boolean;
}
export interface Goalie { id: number; name: string; gaMult: number; catchesLeft: boolean }
export interface Defender { pos: Vec2 }

/** One row of base_rates.json (scope 'all'). */
export interface BaseRateRow { shot_type: string; dist_bucket: number; attempts: number; p_unblocked: number }

const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const err = <T>(error: string): Result<T> => ({ ok: false, error });
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function validMult(m: number): boolean {
  return Number.isFinite(m) && m > 0;
}

/** Gaussian "threat" of defenders near the segment a->b (only those whose projection falls on it). */
export function laneThreat(a: Vec2, b: Vec2, defenders: Defender[], sigma: number): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return 0;
  let threat = 0;
  for (const d of defenders) {
    const t = ((d.pos.x - a.x) * dx + (d.pos.y - a.y) * dy) / len2;
    if (t <= 0 || t >= 1) continue;
    const px = a.x + t * dx, py = a.y + t * dy;
    const perp = Math.hypot(d.pos.x - px, d.pos.y - py);
    threat += Math.exp(-((perp / sigma) ** 2));
  }
  return threat;
}

function nearestThreat(p: Vec2, defenders: Defender[], sigma: number): number {
  let t = 0;
  for (const d of defenders) t += Math.exp(-((dist(p, d.pos) / sigma) ** 2));
  return t;
}

export interface PassLikelihood { p: number; distanceFt: number; laneThreat: number; receiverThreat: number }

/** P(pass connects tape-to-tape). */
export function passLikelihood(passer: Skater, receiver: Skater, defenders: Defender[]): Result<PassLikelihood> {
  if (passer.id === receiver.id) return err("cannot pass to self");
  if (!validMult(passer.playmakingMult)) return err(`invalid playmakingMult for ${passer.name}`);
  const d = dist(passer.pos, receiver.pos);
  const lane = laneThreat(passer.pos, receiver.pos, defenders, PASS.LANE_SIGMA_FT);
  const press = nearestThreat(receiver.pos, defenders, PASS.PRESSURE_SIGMA_FT);
  const z = PASS.B0 + PASS.DIST_PER_FT * d + PASS.LANE * lane + PASS.PRESSURE * press
    + PASS.SKILL * Math.log(passer.playmakingMult);
  return ok({ p: clamp(sigmoid(z), PASS.FLOOR, PASS.CAP), distanceFt: d, laneThreat: lane, receiverThreat: press });
}

export interface SkateLikelihood { p: number; target: SpotName; distanceFt: number; pathThreat: number }

/** P(carrier reaches the named spot still controlling the puck). */
export function skateLikelihood(carrier: Skater, target: SpotName, defenders: Defender[]): Result<SkateLikelihood> {
  const to = OZ_SPOTS[target];
  if (!to) return err(`unknown spot ${String(target)}`);
  if (!validMult(carrier.puckControlMult)) return err(`invalid puckControlMult for ${carrier.name}`);
  const d = dist(carrier.pos, to);
  const threat = laneThreat(carrier.pos, to, defenders, SKATE.SIGMA_FT) + nearestThreat(to, defenders, SKATE.SIGMA_FT);
  const z = SKATE.B0 + SKATE.DIST_PER_FT * d + SKATE.THREAT * threat + SKATE.SKILL * Math.log(carrier.puckControlMult);
  return ok({ p: clamp(sigmoid(z), SKATE.FLOOR, SKATE.CAP), target, distanceFt: d, pathThreat: threat });
}

export function distanceBucket(d: number): number {
  for (let i = 0; i < DISTANCE_BUCKETS_FT.length - 1; i++) {
    if (d >= DISTANCE_BUCKETS_FT[i] && d < DISTANCE_BUCKETS_FT[i + 1]) return i;
  }
  return DISTANCE_BUCKETS_FT.length - 2;
}

/** League P(goal | unblocked) for the option's data keys at this distance, pooled to reach MIN_BASE_SAMPLE. */
export function baseRate(rows: BaseRateRow[], option: ShotOption, bucket: number): Result<number> {
  const keys: readonly string[] = SHOT_OPTIONS[option].dataKeys;
  const match = rows.filter((r) => r.dist_bucket === bucket && keys.includes(r.shot_type));
  const pool = match.reduce((n, r) => n + r.attempts, 0) >= MIN_BASE_SAMPLE
    ? match : rows.filter((r) => r.dist_bucket === bucket);
  const attempts = pool.reduce((n, r) => n + r.attempts, 0);
  if (attempts === 0) return err(`no base-rate data for bucket ${bucket}`);
  const goals = pool.reduce((n, r) => n + r.p_unblocked * r.attempts, 0);
  return ok(goals / attempts);
}

/** Map a viewer-facing corner to glove/blocker using the goalie's catching hand. */
export function zoneFor(corner: "top_left" | "top_right" | "bottom_left" | "bottom_right" | "five_hole",
                        goalie: Goalie): NetZone {
  if (corner === "five_hole") return "five_hole";
  // From the shooter's view, a left-catching goalie's glove is on the shooter's right.
  const shooterRight = corner.endsWith("right");
  const glove = goalie.catchesLeft ? shooterRight : !shooterRight;
  const high = corner.startsWith("top");
  return `${high ? "high" : "low"}_${glove ? "glove" : "blocker"}` as NetZone;
}

export interface ShotLikelihood { pGoal: number; pBlocked: number; pOnNet: number; distanceFt: number; zone: NetZone }

/** P(goal) for a shot of `option` aimed at `zone`, plus block and on-net display numbers. */
export function shotLikelihood(shooter: Skater, goalie: Goalie, option: ShotOption, zone: NetZone,
                               defenders: Defender[], rates: BaseRateRow[]): Result<ShotLikelihood> {
  if (!validMult(shooter.finishingMult)) return err(`invalid finishingMult for ${shooter.name}`);
  if (!validMult(goalie.gaMult)) return err(`invalid gaMult for ${goalie.name}`);
  if (!(zone in ZONE_FACTOR)) return err(`unknown zone ${zone}`);
  if (!(shooter.accuracy > 0 && shooter.accuracy <= 1)) return err(`invalid accuracy for ${shooter.name}`);
  const d = dist(shooter.pos, NET);
  const base = baseRate(rates, option, distanceBucket(d));
  if (!base.ok) return err(base.error);

  let pass = 1;
  const dx = NET.x - shooter.pos.x, dy = NET.y - shooter.pos.y;
  const len2 = dx * dx + dy * dy;
  for (const def of defenders) {
    if (len2 === 0) break;
    const t = ((def.pos.x - shooter.pos.x) * dx + (def.pos.y - shooter.pos.y) * dy) / len2;
    if (t <= 0 || t >= 1) continue;
    const perp = Math.hypot(def.pos.x - (shooter.pos.x + t * dx), def.pos.y - (shooter.pos.y + t * dy));
    pass *= 1 - BLOCK.PER_DEFENDER * Math.exp(-((perp / BLOCK.SIGMA_FT) ** 2));
  }
  const pBlocked = 1 - pass;
  const pGoalUnblocked = clamp(base.value * shooter.finishingMult * goalie.gaMult * ZONE_FACTOR[zone]
    * SHOT_OPTIONS[option].releaseMult, 0, GOAL_CAP);
  const pOnNet = clamp(shooter.accuracy * ZONE_ACCURACY[zone], 0, 1);
  return ok({ pGoal: (1 - pBlocked) * pGoalUnblocked, pBlocked, pOnNet, distanceFt: d, zone });
}

/** Short UI subtext. Rounds to whole percent; shows "<1%" rather than "0%". */
export function pct(p: number): string {
  const v = Math.round(p * 100);
  return v < 1 ? "<1%" : `${v}%`;
}
export const passSubtext = (r: PassLikelihood, to: Skater) => `Pass to ${to.name} · ${pct(r.p)} connects`;
export const skateSubtext = (r: SkateLikelihood) => `Skate to ${r.target.replaceAll("_", " ")} · ${pct(r.p)} keeps puck`;
export const shotSubtext = (r: ShotLikelihood, option: ShotOption) =>
  `${option.replace("_", "-")} · ${r.zone.replace("_", " ")} · ${pct(r.pGoal)} goal · ${pct(r.pBlocked)} blocked`;
