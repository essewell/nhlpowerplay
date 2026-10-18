/**
 * Likelihood model behind every option's subtext ("Pass to Kucherov · 78% connects").
 *
 * Pure functions, no I/O, no randomness, no module state: safe in Web Workers
 * and on the server. Errors are returned as Result values, never thrown, so the
 * UI can show "n/a" instead of crashing; nothing fails silently.
 *
 * Distances use Math.sqrt (correctly rounded on every JS engine) rather than Math.hypot
 * (implementation-defined), so a server replay sees the same numbers as the browser.
 *
 * Complexity: each call is O(D) for D defenders (D <= 5), except baseRate which is O(R) rows.
 */
import {
  BLOCK, DISTANCE_BUCKETS_FT, GOAL_CAP, MIN_BASE_SAMPLE, NET, OZ_SPOTS, PASS, SHOT_OPTIONS, SKATE,
  ZONE_ACCURACY, ZONE_FACTOR, type NetZone, type ShotOption, type SpotName,
} from "./constants.ts";
import { err, ok, type Result } from "./result.ts";

export type { Result } from "./result.ts";
export type Vec2 = { x: number; y: number };

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

export type Corner = "top_left" | "top_right" | "bottom_left" | "bottom_right" | "five_hole";

const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Euclidean distance. O(1). */
export function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x, dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function validPos(p: Vec2): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y);
}

function validMult(m: number): boolean {
  return Number.isFinite(m) && m > 0;
}

/** First invalid position among skaters and defenders, as an error message. O(S + D). */
function badPositions(skaters: Skater[], defenders: Defender[]): string | null {
  for (const s of skaters) if (!validPos(s.pos)) return `non-finite position for ${s.name}`;
  for (const d of defenders) if (!validPos(d.pos)) return "non-finite defender position";
  return null;
}

/** Sum of Gaussian "threat" from defenders near the segment a->b (only those whose projection falls on it). O(D). */
export function laneThreat(a: Vec2, b: Vec2, defenders: Defender[], sigma: number): Result<number> {
  if (!(Number.isFinite(sigma) && sigma > 0)) return err(`sigma must be a positive number, got ${sigma}`);
  if (!validPos(a) || !validPos(b)) return err("non-finite lane endpoint");
  if (defenders.some((d) => !validPos(d.pos))) return err("non-finite defender position");
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return ok(0);
  let threat = 0;
  for (const d of defenders) {
    const t = ((d.pos.x - a.x) * dx + (d.pos.y - a.y) * dy) / len2;
    if (t <= 0 || t >= 1) continue;
    const perp = dist(d.pos, { x: a.x + t * dx, y: a.y + t * dy });
    threat += Math.exp(-((perp / sigma) ** 2));
  }
  return ok(threat);
}

/** Inputs are validated by the public callers. O(D). */
function nearestThreat(p: Vec2, defenders: Defender[], sigma: number): number {
  let t = 0;
  for (const d of defenders) t += Math.exp(-((dist(p, d.pos) / sigma) ** 2));
  return t;
}

export interface PassLikelihood { p: number; distanceFt: number; laneThreat: number; receiverThreat: number }

/** P(pass connects tape-to-tape). O(D). */
export function passLikelihood(passer: Skater, receiver: Skater, defenders: Defender[]): Result<PassLikelihood> {
  if (passer.id === receiver.id) return err("cannot pass to self");
  if (!validMult(passer.playmakingMult)) return err(`invalid playmakingMult for ${passer.name}`);
  const bad = badPositions([passer, receiver], defenders);
  if (bad) return err(bad);
  const d = dist(passer.pos, receiver.pos);
  const lane = laneThreat(passer.pos, receiver.pos, defenders, PASS.LANE_SIGMA_FT);
  if (!lane.ok) return err(lane.error);
  const press = nearestThreat(receiver.pos, defenders, PASS.PRESSURE_SIGMA_FT);
  const z = PASS.B0 + PASS.DIST_PER_FT * d + PASS.LANE * lane.value + PASS.PRESSURE * press
    + PASS.SKILL * Math.log(passer.playmakingMult);
  return ok({ p: clamp(sigmoid(z), PASS.FLOOR, PASS.CAP), distanceFt: d, laneThreat: lane.value, receiverThreat: press });
}

export interface SkateLikelihood { p: number; target: SpotName; distanceFt: number; pathThreat: number }

/** P(carrier reaches the named spot still controlling the puck). O(D). */
export function skateLikelihood(carrier: Skater, target: SpotName, defenders: Defender[]): Result<SkateLikelihood> {
  if (!Object.hasOwn(OZ_SPOTS, target)) return err(`unknown spot ${String(target)}`);
  const to = OZ_SPOTS[target];
  if (!validMult(carrier.puckControlMult)) return err(`invalid puckControlMult for ${carrier.name}`);
  const bad = badPositions([carrier], defenders);
  if (bad) return err(bad);
  const d = dist(carrier.pos, to);
  const lane = laneThreat(carrier.pos, to, defenders, SKATE.SIGMA_FT);
  if (!lane.ok) return err(lane.error);
  const threat = lane.value + nearestThreat(to, defenders, SKATE.SIGMA_FT);
  const z = SKATE.B0 + SKATE.DIST_PER_FT * d + SKATE.THREAT * threat + SKATE.SKILL * Math.log(carrier.puckControlMult);
  return ok({ p: clamp(sigmoid(z), SKATE.FLOOR, SKATE.CAP), target, distanceFt: d, pathThreat: threat });
}

/**
 * Index of the distance bucket containing d (buckets are [edge_i, edge_i+1)).
 * Distances past the last edge fall in the last bucket. Rejects NaN, infinite and negative. O(B).
 */
export function distanceBucket(d: number): Result<number> {
  if (!Number.isFinite(d) || d < 0) return err(`invalid distance ${d}`);
  let bucket = 0;
  DISTANCE_BUCKETS_FT.forEach((edge, i) => {
    if (d >= edge) bucket = i;
  });
  return ok(Math.min(bucket, DISTANCE_BUCKETS_FT.length - 2));
}

/** League P(goal | unblocked) for the option's data keys at this distance, pooled to reach MIN_BASE_SAMPLE. O(R). */
export function baseRate(rows: BaseRateRow[], option: ShotOption, bucket: number): Result<number> {
  if (!Object.hasOwn(SHOT_OPTIONS, option)) return err(`unknown shot option ${String(option)}`);
  const keys: readonly string[] = SHOT_OPTIONS[option].dataKeys;
  const match = rows.filter((r) => r.dist_bucket === bucket && keys.includes(r.shot_type));
  const pool = match.reduce((n, r) => n + r.attempts, 0) >= MIN_BASE_SAMPLE
    ? match : rows.filter((r) => r.dist_bucket === bucket);
  const attempts = pool.reduce((n, r) => n + r.attempts, 0);
  if (attempts === 0) return err(`no base-rate data for bucket ${bucket}`);
  const goals = pool.reduce((n, r) => n + r.p_unblocked * r.attempts, 0);
  return ok(goals / attempts);
}

/** Map a viewer-facing corner to glove/blocker using the goalie's catching hand. O(1). */
export function zoneFor(corner: Corner, goalie: Goalie): NetZone {
  if (corner === "five_hole") return "five_hole";
  // From the shooter's view, a left-catching goalie's glove is on the shooter's right.
  const shooterRight = corner.endsWith("right");
  const glove = goalie.catchesLeft ? shooterRight : !shooterRight;
  const high = corner.startsWith("top");
  return `${high ? "high" : "low"}_${glove ? "glove" : "blocker"}` as NetZone;
}

export interface ShotLikelihood { pGoal: number; pBlocked: number; pOnNet: number; distanceFt: number; zone: NetZone }

/** P(goal) for a shot of `option` aimed at `zone`, plus block and on-net display numbers. O(D + R). */
export function shotLikelihood(shooter: Skater, goalie: Goalie, option: ShotOption, zone: NetZone,
                               defenders: Defender[], rates: BaseRateRow[]): Result<ShotLikelihood> {
  if (!validMult(shooter.finishingMult)) return err(`invalid finishingMult for ${shooter.name}`);
  if (!validMult(goalie.gaMult)) return err(`invalid gaMult for ${goalie.name}`);
  if (!Object.hasOwn(ZONE_FACTOR, zone)) return err(`unknown zone ${zone}`);
  if (!Object.hasOwn(SHOT_OPTIONS, option)) return err(`unknown shot option ${String(option)}`);
  if (!(shooter.accuracy > 0 && shooter.accuracy <= 1)) return err(`invalid accuracy for ${shooter.name}`);
  const bad = badPositions([shooter], defenders);
  if (bad) return err(bad);
  const d = dist(shooter.pos, NET);
  const bucket = distanceBucket(d);
  if (!bucket.ok) return err(bucket.error);
  const base = baseRate(rates, option, bucket.value);
  if (!base.ok) return err(base.error);

  let pass = 1;
  const dx = NET.x - shooter.pos.x, dy = NET.y - shooter.pos.y;
  const len2 = dx * dx + dy * dy;
  for (const def of defenders) {
    if (len2 === 0) break;
    const t = ((def.pos.x - shooter.pos.x) * dx + (def.pos.y - shooter.pos.y) * dy) / len2;
    if (t <= 0 || t >= 1) continue;
    const perp = dist(def.pos, { x: shooter.pos.x + t * dx, y: shooter.pos.y + t * dy });
    pass *= 1 - BLOCK.PER_DEFENDER * Math.exp(-((perp / BLOCK.SIGMA_FT) ** 2));
  }
  const pBlocked = 1 - pass;
  const pGoalUnblocked = clamp(base.value * shooter.finishingMult * goalie.gaMult * ZONE_FACTOR[zone]
    * SHOT_OPTIONS[option].releaseMult, 0, GOAL_CAP);
  const pOnNet = clamp(shooter.accuracy * ZONE_ACCURACY[zone], 0, 1);
  return ok({ pGoal: (1 - pBlocked) * pGoalUnblocked, pBlocked, pOnNet, distanceFt: d, zone });
}

/** Short UI subtext. Rounds to whole percent; shows "<1%" rather than "0%" and "n/a" for non-numbers. O(1). */
export function pct(p: number): string {
  if (!Number.isFinite(p)) return "n/a";
  const v = Math.round(clamp(p, 0, 1) * 100);
  return v < 1 ? "<1%" : `${v}%`;
}
export const passSubtext = (r: PassLikelihood, to: Skater) => `Pass to ${to.name} · ${pct(r.p)} connects`;
export const skateSubtext = (r: SkateLikelihood) => `Skate to ${r.target.replaceAll("_", " ")} · ${pct(r.p)} keeps puck`;
export const shotSubtext = (r: ShotLikelihood, option: ShotOption) =>
  `${option.replaceAll("_", "-")} · ${r.zone.replaceAll("_", " ")} · ${pct(r.pGoal)} goal · ${pct(r.pBlocked)} blocked`;
