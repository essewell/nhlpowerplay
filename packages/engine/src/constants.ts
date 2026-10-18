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

// ---------------------------------------------------------------------------------------------
// Game rules used by the run simulation (clock.ts, sim.ts). These are rules, not stats.

/** Regulation period length (s). Source: NHL rulebook; matches pipeline/config.py PERIOD_LENGTH_S. */
export const PERIOD_LENGTH_S = 1200;
/** Regular-season overtime: 5 minutes of 3-on-3, then a shootout. Source: NHL rulebook (since 2015-16). */
export const REG_OT_LENGTH_S = 300;
/** Playoff overtime periods are full 20-minute 5-on-5 periods. Source: NHL rulebook. */
export const PLAYOFF_OT_LENGTH_S = 1200;
/** Regulation periods before overtime. Source: NHL rulebook. */
export const REGULATION_PERIODS = 3;
/** Penalty lengths (s). Source: NHL rulebook; MINOR matches pipeline/config.py MINOR_S. */
export const PENALTY_S = { minor: 120, double_minor: 240, major: 300 } as const;
/** A team never drops below 3 skaters; extra penalties queue. Source: NHL rulebook. */
export const MIN_SKATERS = 3;
export const BASE_SKATERS = 5;          // regulation and playoff OT, per side (NHL rulebook)
export const REG_OT_BASE_SKATERS = 3;   // regular-season 3-on-3 OT (NHL rulebook)
export const MAX_ACTIVE_PENALTIES_PER_SIDE = BASE_SKATERS - MIN_SKATERS;

/** Named set plays: a pass to a spot, then a shot from there. Odds = pass p x shot pGoal.
 * Spots, shot types and aim points are ASSUMPTION — tune in playtesting. */
export const SET_PLAYS = {
  point_one_timer: { label: "Point one-timer", toSpot: "point_middle", option: "one_timer", corner: "bottom_right" },
  cross_seam_one_timer: { label: "Cross-seam one-timer", toSpot: "circle_top_right", option: "one_timer", corner: "top_left" },
  bumper_one_timer: { label: "Bumper one-timer", toSpot: "bumper_slot", option: "one_timer", corner: "top_right" },
  net_front_tip: { label: "Net-front tip", toSpot: "net_front", option: "tip", corner: "bottom_left" },
} as const satisfies Record<string, { label: string; toSpot: SpotName; option: ShotOption;
  corner: "top_left" | "top_right" | "bottom_left" | "bottom_right" | "five_hole" }>;
export type SetPlayId = keyof typeof SET_PLAYS;

// ---------------------------------------------------------------------------------------------
// Discrete-event power-play simulation tunables (formation.ts, sim.ts). All ASSUMPTION — tune in
// playtesting; none of these are historical facts and none may be shown as such in UI copy.

/** PP skater counts the formation tables cover: 4 (reg-season OT 4v3), 5 (normal), 6 (goalie pulled). */
export type PpSkaterCount = 4 | 5 | 6;
type Spots4 = readonly [SpotName, SpotName, SpotName, SpotName];
type Spots5 = readonly [SpotName, SpotName, SpotName, SpotName, SpotName];
type Spots6 = readonly [SpotName, SpotName, SpotName, SpotName, SpotName, SpotName];

/**
 * PP formations as ordered spot lists per skater count; the first spot is the puck carrier's default.
 * ASSUMPTION — tune. umbrella: QB at the top, flanks on the half walls, bumper + net front.
 * one_three_one: QB on the right half wall, one point, bumper, left flank at the circle top, net front.
 */
export const PP_FORMATIONS = {
  umbrella: {
    4: ["point_middle", "half_wall_left", "half_wall_right", "net_front"],
    5: ["point_middle", "half_wall_left", "half_wall_right", "bumper_slot", "net_front"],
    6: ["point_middle", "half_wall_left", "half_wall_right", "bumper_slot", "net_front", "goal_line_left"],
  },
  one_three_one: {
    4: ["half_wall_right", "point_middle", "circle_top_left", "net_front"],
    5: ["half_wall_right", "point_middle", "bumper_slot", "circle_top_left", "net_front"],
    6: ["half_wall_right", "point_middle", "bumper_slot", "circle_top_left", "net_front", "goal_line_left"],
  },
} as const satisfies Record<string, { 4: Spots4; 5: Spots5; 6: Spots6 }>;

/**
 * PK shapes as offsets (ft) from PK.ANCHOR, before the puck-side shift. ASSUMPTION — tune.
 * box: 4 PK (two high, two low); diamond: 4 PK alternative; triangle: 3 PK;
 * five: 5 PK (only vs a 6-skater PP) = box plus one defender on the anchor (the slot).
 */
export const PK_TEMPLATES = {
  box: [{ x: -14, y: 14 }, { x: -14, y: -14 }, { x: 8, y: 8 }, { x: 8, y: -8 }],
  diamond: [{ x: -18, y: 0 }, { x: -4, y: 16 }, { x: -4, y: -16 }, { x: 10, y: 0 }],
  triangle: [{ x: -14, y: 12 }, { x: -14, y: -12 }, { x: 8, y: 0 }],
  five: [{ x: -14, y: 14 }, { x: -14, y: -14 }, { x: 8, y: 8 }, { x: 8, y: -8 }, { x: 0, y: 0 }],
} as const;
export type PkTemplateName = keyof typeof PK_TEMPLATES;

/** Penalty-kill behaviour. All ASSUMPTION — tune. */
export const PK = {
  ANCHOR: { x: 72, y: 0 },   // ASSUMPTION — tune: centre of the PK shape (between the dots and the net)
  SHIFT_K: 0.35,             // ASSUMPTION — tune: fraction of (puck - anchor) the whole shape slides toward the puck
  PRESSURE_GAP_FT: 6,        // ASSUMPTION — tune: the nearest defender sits this far from the puck, on the puck->net line
  FORMATION_4: "box",        // ASSUMPTION — tune: 4-man PK shape
  CLEAR_P: 0.7,              // ASSUMPTION — tune: P(PK clears the zone | PK possession)
  SH_CHANCE_P: 0.05,         // ASSUMPTION — tune: P(PK gets a shorthanded chance | PK possession)
  SH_GOAL_P: 0.2,            // ASSUMPTION — tune: P(goal | shorthanded chance)
  EN_GOAL_P: 0.5,            // ASSUMPTION — tune: P(goal | PK shoots at an empty net)
  EN_CLEAR_GOAL_P: 0.08,     // ASSUMPTION — tune: P(a clear slides into the empty net)
} as const satisfies { FORMATION_4: PkTemplateName } & Record<string, unknown>;

/**
 * Offensive-zone bounds for clamping positions. ASSUMPTION — tune: blue line from BLUE_LINE_X_FT,
 * end boards at x = 100 (200 ft rink), half-width 42.5 ft (85 ft rink); corners are not rounded.
 */
export const OZ_BOUNDS = {
  X_MIN: 25,       // ASSUMPTION — tune: blue line (pipeline/config.py BLUE_LINE_X_FT)
  X_MAX: 100,      // ASSUMPTION — tune: end boards
  Y_ABS_MAX: 42.5, // ASSUMPTION — tune: rink half-width
} as const;

/** Duration of each simulated event (integer s). All ASSUMPTION — tune. */
export const TIME = {
  PASS_S: 1,          // ASSUMPTION — tune: a pass
  SHOT_S: 1,          // ASSUMPTION — tune: a shot to its outcome
  FACEOFF_S: 2,       // ASSUMPTION — tune: a faceoff to possession
  LOOSE_S: 2,         // ASSUMPTION — tune: a loose-puck battle
  PK_POSSESSION_S: 3, // ASSUMPTION — tune: PK holds the puck before clearing / chance
  REGROUP_S: 12,      // ASSUMPTION — tune: PP retrieves a cleared puck and regroups in its own end
  ENTRY_S: 3,         // ASSUMPTION — tune: a zone entry attempt
  SETUP_S: 4,         // ASSUMPTION — tune: set up in formation after a clean entry
  BREAKOUT_S: 4,      // ASSUMPTION — tune: a breakout attempt
} as const;
export const SKATE_SPEED_FPS = 20; // ASSUMPTION — tune: carry speed in ft/s (with the puck, under pressure)
/** Minimum time for the PP to get back in after a clear. Derived from TIME (ASSUMPTION — tune). */
export const CLEAR_REENTRY_MIN_S = TIME.REGROUP_S + TIME.ENTRY_S + TIME.SETUP_S;

/** Who recovers a contested puck. All ASSUMPTION — tune. */
export const RECOVERY = {
  PASS_INTERCEPT_P: 0.5, // ASSUMPTION — tune: P(PK picks off | failed pass) (else loose)
  LOOSE_PP_P: 0.45,      // ASSUMPTION — tune: P(PP wins a loose puck)
  BLOCKED_PP_P: 0.35,    // ASSUMPTION — tune: P(PP recovers its own blocked shot)
  MISS_PP_P: 0.4,        // ASSUMPTION — tune: P(PP recovers its own missed shot (end-boards rim))
  SAVE_FREEZE_P: 0.5,    // ASSUMPTION — tune: P(goalie freezes a save -> faceoff)
  REBOUND_PP_P: 0.35,    // ASSUMPTION — tune: P(PP recovers a live rebound)
} as const;

/** Faceoffs. */
export const FACEOFF = {
  PRIOR_RATE: 0.5,    // ASSUMPTION — tune: win rate when no rating; source pipeline/config.py FACEOFF_PRIOR_RATE
  LOSS_CLEAR_P: 0.8,  // ASSUMPTION — tune: P(PK clears straight off an OZ faceoff win)
} as const;

/** Zone entries. All ASSUMPTION — tune. */
export const ENTRY = {
  CARRY_P: 0.6,        // ASSUMPTION — tune: P(controlled carry-in succeeds)
  DROP_P: 0.55,        // ASSUMPTION — tune: P(drop-pass entry succeeds)
  DUMP_RECOVER_P: 0.35, // ASSUMPTION — tune: P(PP recovers its dump-in)
} as const;

/** Breakouts after the PK clears (only asked when settings.askEveryTouch). All ASSUMPTION — tune. */
export const BREAKOUT = {
  CARRY_P: 0.8, // ASSUMPTION — tune: P(carry breakout gets through the neutral zone)
  PASS_P: 0.82, // ASSUMPTION — tune: P(breakout pass connects)
  RIM_P: 0.78,  // ASSUMPTION — tune: P(rim breakout reaches a PP stick)
} as const;

/** ASSUMPTION — tune: a set play is offered only when its receiver can reach the play spot within this distance. */
export const SET_PLAY_MAX_SPOT_DIST_FT = 8;
/**
 * Probabilities are compared as integers, Math.round(p * PROB_QUANTUM) vs a uint32 draw scaled to
 * the same range. The PRNG is integer-exact, but probabilities use Math.exp/Math.log, which engines
 * approximate; quantising makes a cross-engine draw flip very unlikely, not impossible. The server
 * replay is authoritative for official scores. ASSUMPTION — tune (resolution only).
 */
export const PROB_QUANTUM = 1_000_000;
export const MAX_CALLS_PER_RUN = 400;      // ASSUMPTION — tune: hard cap on player calls in one run (abuse guard)
export const MAX_AUTO_STEPS_PER_CALL = 50; // ASSUMPTION — tune: base loop guard on auto steps after one call; sim.ts adds one step per remaining PP second
/**
 * Faceoff dots used by the sim (ft). ASSUMPTION — tune: end-zone dots ~20 ft out from the goal line
 * and ~22 ft off centre (same rink assumption as OZ_SPOTS); centre ice is the coordinate origin.
 */
export const FACEOFF_DOTS = {
  oz_left: { x: 69, y: 22 },   // ASSUMPTION — tune
  oz_right: { x: 69, y: -22 }, // ASSUMPTION — tune
  centre: { x: 0, y: 0 },      // origin by definition
} as const;
export const OPENING_FACEOFF_LEFT_P = 0.5; // ASSUMPTION — tune: P(a run's opening OZ faceoff is on the left dot)
