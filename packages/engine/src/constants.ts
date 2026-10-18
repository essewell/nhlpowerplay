/**
 * Every tunable used by the likelihood model. Each carries its source or
 * "ASSUMPTION" (tune in playtesting / calibration; never treat as researched).
 * Coordinates: feet, origin centre ice, attacking team always shoots at +x.
 * Immutable module state: safe in Web Workers and on the server.
 */

/** Net centre. Source: hockeyR shot-distance code uses x = +/-89. */
export const NET = { x: 89, y: 0 } as const;

/** Distance bucket edges (ft); must match pipeline/config.py DISTANCE_BUCKETS_FT. */
export const DISTANCE_BUCKETS_FT = [0, 10, 20, 30, 45, 64, 200] as const;

/**
 * Named offensive-zone spots for "skate to" options (feet).
 * Blue line x=25 (config BLUE_LINE_X_FT); end-zone faceoff dots ~20 ft out from the
 * goal line (x~69) and ~22 ft off centre, circles radius 15 ft. ASSUMPTION from standard
 * NHL rink dimensions; verify against the official rulebook rink diagram before release.
 * y > 0 is the attacking team's left as it faces the net (ASSUMPTION; matches normalised API sign).
 */
export const OZ_SPOTS = {
  point_left: { x: 33, y: 22 },
  point_middle: { x: 33, y: 0 },
  point_right: { x: 33, y: -22 },
  half_wall_left: { x: 58, y: 36 },
  half_wall_right: { x: 58, y: -36 },
  circle_top_left: { x: 54, y: 22 },
  circle_top_right: { x: 54, y: -22 },
  hash_left: { x: 69, y: 30 },
  hash_right: { x: 69, y: -30 },
  bumper_slot: { x: 60, y: 0 },
  slot: { x: 75, y: 0 },
  net_front: { x: 84, y: 0 },
  goal_line_left: { x: 89, y: 15 },
  goal_line_right: { x: 89, y: -15 },
} as const;
export type SpotName = keyof typeof OZ_SPOTS;

/** Pass completion: logit = B0 + DIST*d + LANE*laneThreat + PRESSURE*receiverThreat + SKILL*ln(playmakingMult). ASSUMPTION (fit on Big Data Cup). */
export const PASS = {
  B0: 3.2,
  DIST_PER_FT: -0.035,
  LANE: -2.4,
  PRESSURE: -1.1,
  SKILL: 1.0,
  LANE_SIGMA_FT: 4.0,     // width of a defender's stick-reach "shadow"
  PRESSURE_SIGMA_FT: 6.0,
  CAP: 0.98,
  FLOOR: 0.02,
} as const;

/** Skating / carry: P(keeps the puck). ASSUMPTION. */
export const SKATE = {
  B0: 3.0,
  DIST_PER_FT: -0.03,
  THREAT: -2.0,
  SKILL: 1.0,
  SIGMA_FT: 5.0,
  CAP: 0.98,
  FLOOR: 0.05,
} as const;

/** Shot block risk per defender in the shooting lane. ASSUMPTION. */
export const BLOCK = { PER_DEFENDER: 0.45, SIGMA_FT: 2.5 } as const;

/** Net-zone multipliers on P(goal | unblocked shot). ASSUMPTION, seeded so high glove > high blocker
 * (cited goal shares 23.6% vs 18.3%, see data/model_priors.json). Mean over zones = 1. */
export const ZONE_FACTOR = {
  high_glove: 1.3,
  high_blocker: 1.1,
  low_glove: 0.85,
  low_blocker: 0.9,
  five_hole: 0.85,
} as const;
export type NetZone = keyof typeof ZONE_FACTOR;

/** Relative on-net accuracy by zone (corners are harder to hit). ASSUMPTION; display only. */
export const ZONE_ACCURACY = {
  high_glove: 0.8,
  high_blocker: 0.8,
  low_glove: 0.95,
  low_blocker: 0.95,
  five_hole: 1.05,
} as const;

/** Game shot options -> play-by-play shotType keys used for base rates.
 * 'one-timer' is not a PBP shot type; it borrows slap/snap rates with a release bonus. ASSUMPTION. */
export const SHOT_OPTIONS = {
  wrist: { dataKeys: ["wrist"], releaseMult: 1.0 },
  snap: { dataKeys: ["snap"], releaseMult: 1.0 },
  slap: { dataKeys: ["slap"], releaseMult: 1.0 },
  backhand: { dataKeys: ["backhand"], releaseMult: 1.0 },
  one_timer: { dataKeys: ["slap", "snap"], releaseMult: 1.15 },
  tip: { dataKeys: ["tip-in", "deflected"], releaseMult: 1.0 },
  wrap_around: { dataKeys: ["wrap-around"], releaseMult: 1.0 },
} as const;
export type ShotOption = keyof typeof SHOT_OPTIONS;

export const GOAL_CAP = 0.9;           // no shot shown above 90%
export const MIN_BASE_SAMPLE = 50;     // pool across types below this (matches pipeline min_cell)
