/**
 * Turns the engine's CallOption[] into what the play screens show. Pure; no DOM, no clock, no
 * randomness; every number is copied from an option (the UI computes no probability).
 * Complexity: each function is O(C) or O(C log C) for C options (C is about 80 in a decision).
 */
import { SET_PLAYS, type SetPlayId, type ShotOption, type SpotName } from "@powerplay/engine/constants.ts";
import type { Corner } from "@powerplay/engine/likelihood.ts";
import type { Call, CallOption, EntryLane, EntryMethod, PpFormationName } from "@powerplay/engine/sim-types.ts";
import type { RunSnapshot } from "../contracts.ts";
import type { CopyKey } from "../copy.ts";

export type OptionOf<T extends Call["type"]> = CallOption & { call: Extract<Call, { type: T }> };

export interface GroupedOptions {
  pass: OptionOf<"pass">[];
  skate: OptionOf<"skate">[];
  shoot: OptionOf<"shoot">[];
  setPlay: OptionOf<"set_play">[];
  faceoff: OptionOf<"faceoff">[];
  zoneEntry: OptionOf<"zone_entry">[];
  breakout: OptionOf<"breakout">[];
}

/** Split options by call type, keeping the engine's order. O(C). */
export function groupOptions(options: readonly CallOption[]): GroupedOptions {
  const g: GroupedOptions = { pass: [], skate: [], shoot: [], setPlay: [], faceoff: [], zoneEntry: [], breakout: [] };
  for (const o of options) {
    switch (o.call.type) {
      case "pass": g.pass.push(o as OptionOf<"pass">); break;
      case "skate": g.skate.push(o as OptionOf<"skate">); break;
      case "shoot": g.shoot.push(o as OptionOf<"shoot">); break;
      case "set_play": g.setPlay.push(o as OptionOf<"set_play">); break;
      case "faceoff": g.faceoff.push(o as OptionOf<"faceoff">); break;
      case "zone_entry": g.zoneEntry.push(o as OptionOf<"zone_entry">); break;
      case "breakout": g.breakout.push(o as OptionOf<"breakout">); break;
    }
  }
  return g;
}

/** Highest probability first; ties keep the engine's order (Array.sort is stable). Does not mutate. O(n log n). */
export function sortByChance<T extends { p: number }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.p - a.p);
}

/** How many skate spots show before the "more" expander. */
export const SKATE_VISIBLE_DEFAULT = 6;

/** First `visible` rows unless expanded. Reports how many are hidden. O(visible). */
export function limitRows<T>(rows: readonly T[], expanded: boolean, visible = SKATE_VISIBLE_DEFAULT): { shown: T[]; hidden: number } {
  const cap = Number.isInteger(visible) && visible > 0 ? visible : SKATE_VISIBLE_DEFAULT;
  if (expanded || rows.length <= cap) return { shown: [...rows], hidden: 0 };
  return { shown: rows.slice(0, cap), hidden: rows.length - cap };
}

// ---------------------------------------------------------------------------- busy gating

const CALL_STATES: ReadonlySet<RunSnapshot["machineState"]> = new Set([
  "faceoffCall", "zoneEntryCall", "breakoutCall", "decision",
]);

/** A call can be sent now: the run is paused for one and none is in flight (edge 9). */
export function canSendCall(s: Pick<RunSnapshot, "busy" | "machineState">): boolean {
  return !s.busy && CALL_STATES.has(s.machineState);
}

/**
 * An option's button is disabled only while a call is in flight. Options the clock would cut stay
 * playable (shown with the "not enough time" note): the engine resolves them by running the clock out,
 * and disabling them could leave the player with nothing to tap near the end of a power play.
 */
export function optionDisabled(_o: Pick<CallOption, "cutByClock">, busy: boolean): boolean {
  return busy;
}

// ---------------------------------------------------------------------------- players

export interface PlayerLabel { number: number | null; lastName: string }

/** Jersey number and last name from the scenario; falls back to the engine skater's name, then "#id". O(S). */
export function playerLabel(s: Pick<RunSnapshot, "scenario" | "input">, id: number): PlayerLabel {
  const p = s.scenario.players[id];
  if (p !== undefined) return { number: p.number, lastName: p.last };
  const skater = s.input.pp.skaters.find((k) => k.id === id);
  const words = skater?.name.trim().split(/\s+/) ?? [];
  const last = words[words.length - 1];
  return { number: null, lastName: last !== undefined && last.length > 0 ? last : `#${id}` };
}

/** The PP skater holding the puck in a decision phase, with the spot they stand on. null if not a PP carry. */
export function carrierOf(s: Pick<RunSnapshot, "state">): { id: number; spot: SpotName } | null {
  const c = s.state.carrier;
  if (c.kind !== "pp") return null;
  const spot = s.state.ppSpots.find((x) => x.id === c.id)?.spot;
  return spot === undefined ? null : { id: c.id, spot };
}

// ---------------------------------------------------------------------------- shot picker

/** The six shot types of the design, in display order. wrap_around is an engine option the design hides. */
export const SHOT_TYPES = ["wrist", "snap", "slap", "one_timer", "backhand", "tip"] as const satisfies readonly ShotOption[];
export type ShotType = (typeof SHOT_TYPES)[number];

/** Target order in the net: top row, then low-left, five-hole, low-right. */
export const SHOT_CORNERS = ["top_left", "top_right", "bottom_left", "five_hole", "bottom_right"] as const satisfies readonly Corner[];

export const SHOT_TYPE_COPY: Record<ShotType, CopyKey> = {
  wrist: "shot.type.wrist",
  snap: "shot.type.snap",
  slap: "shot.type.slap",
  one_timer: "shot.type.oneTimer",
  backhand: "shot.type.backhand",
  tip: "shot.type.tip",
};

/**
 * Corner labels for an UNKNOWN catching hand (the export has none): Top left / Top right / Low left /
 * Low right / 5-hole (COPY.md 4.3 goalieHand.unknown). Corners are from the shooter's view.
 */
export const CORNER_COPY: Record<Corner, CopyKey> = {
  top_left: "shot.target.topLeftPlain",
  top_right: "shot.target.topRightPlain",
  bottom_left: "shot.target.lowLeft",
  bottom_right: "shot.target.lowRight",
  five_hole: "shot.target.fiveHole",
};

/** The one-timer chance is modelled from slap and snap rates, so it carries the Estimate tag. */
export const ESTIMATE_SHOT_TYPES: readonly ShotType[] = ["one_timer"];

const isShotType = (o: ShotOption): o is ShotType => (SHOT_TYPES as readonly string[]).includes(o);

/** The priced shot for exactly this type and corner, or null. O(C). */
export function findShot(shoot: readonly OptionOf<"shoot">[], type: ShotOption, corner: Corner): OptionOf<"shoot"> | null {
  return shoot.find((o) => o.call.option === type && o.call.corner === corner) ?? null;
}

function bestOf(rows: readonly OptionOf<"shoot">[]): OptionOf<"shoot"> | null {
  let best: OptionOf<"shoot"> | null = null;
  for (const o of rows) if (best === null || o.p > best.p) best = o;
  return best;
}

/**
 * The option that prices a shot-type tile: the selected corner's, or (no corner chosen) the type's
 * best corner. null if the engine offered nothing for that type. O(C).
 */
export function shotTypeOption(shoot: readonly OptionOf<"shoot">[], type: ShotType, corner: Corner | null): OptionOf<"shoot"> | null {
  if (corner !== null) return findShot(shoot, type, corner);
  return bestOf(shoot.filter((o) => o.call.option === type));
}

/**
 * The option that prices a target tile: the selected type's, or (no type chosen) the best of the six
 * design types for that corner. wrap_around never competes. O(C).
 */
export function shotTargetOption(shoot: readonly OptionOf<"shoot">[], type: ShotType | null, corner: Corner): OptionOf<"shoot"> | null {
  if (type !== null) return findShot(shoot, type, corner);
  return bestOf(shoot.filter((o) => o.call.corner === corner && isShotType(o.call.option)));
}

export interface ShotSummary { goal: number; onNet: number; blocked: number }

/**
 * Goal / On net / Blocked for a chosen shot, straight from the option (p and breakdown). A missing
 * or non-finite breakdown number comes back as NaN, which the engine pct() prints as "n/a".
 */
export function shotSummary(o: OptionOf<"shoot"> | null): ShotSummary | null {
  if (o === null) return null;
  const num = (v: number | undefined): number => (v !== undefined && Number.isFinite(v) ? v : Number.NaN);
  return { goal: num(o.p), onNet: num(o.breakdown["pOnNet"]), blocked: num(o.breakdown["pBlocked"]) };
}

// ---------------------------------------------------------------------------- set plays

export interface SetPlayView { nameKey: CopyKey; subKey: CopyKey; thumbnail: string }

/** Engine set plays -> copy (docs/COPY.md section 5) and thumbnail in public/setplays. */
export const SET_PLAY_VIEW: Record<SetPlayId, SetPlayView> = {
  point_one_timer: { nameKey: "setplay.pointShot.name", subKey: "setplay.pointShot.sub", thumbnail: "/setplays/point-shot.svg" },
  cross_seam_one_timer: { nameKey: "setplay.crossSeam.name", subKey: "setplay.crossSeam.sub", thumbnail: "/setplays/cross-seam.svg" },
  bumper_one_timer: { nameKey: "setplay.bumper.name", subKey: "setplay.bumper.sub", thumbnail: "/setplays/bumper.svg" },
  net_front_tip: { nameKey: "setplay.netFrontTip.name", subKey: "setplay.netFrontTip.sub", thumbnail: "/setplays/net-front-tip.svg" },
};

export const SET_PLAY_IDS = Object.keys(SET_PLAYS) as SetPlayId[];

// ---------------------------------------------------------------------------- faceoff

export const FACEOFF_TARGET_COPY = {
  point: "faceoff.target.point",
  half_wall: "faceoff.target.halfWall",
  back: "faceoff.target.back",
} as const satisfies Record<string, CopyKey>;

/** One row per taker: the chance to win the draw. It depends on the taker, not the target, so any target's option prices it. */
export function faceoffTakers(faceoff: readonly OptionOf<"faceoff">[]): { takerId: number; p: number; cutByClock: boolean }[] {
  const seen = new Map<number, { takerId: number; p: number; cutByClock: boolean }>();
  for (const o of faceoff) {
    if (!seen.has(o.call.takerId)) seen.set(o.call.takerId, { takerId: o.call.takerId, p: o.p, cutByClock: o.cutByClock });
  }
  return [...seen.values()];
}

/** The faceoff call for a taker and target, or null if the engine did not offer it. */
export function findFaceoff(faceoff: readonly OptionOf<"faceoff">[], takerId: number, target: string): OptionOf<"faceoff"> | null {
  return faceoff.find((o) => o.call.takerId === takerId && o.call.target === target) ?? null;
}

// ---------------------------------------------------------------------------- zone entry: lanes and setup

/** Display order of the lane selector, attacker's left first. */
export const ENTRY_LANES = ["left", "middle", "right"] as const satisfies readonly EntryLane[];

/**
 * Lanes the engine priced, in display order. Empty when the options carry no lane (an engine that offers one
 * option per method): the UI then hides the lane selector. O(C).
 */
export function entryLanes(entry: readonly OptionOf<"zone_entry">[]): EntryLane[] {
  return ENTRY_LANES.filter((lane) => entry.some((o) => o.call.lane === lane));
}

/** Methods offered, first-seen order (the engine's order). O(C). */
export function entryMethods(entry: readonly OptionOf<"zone_entry">[]): EntryMethod[] {
  const seen: EntryMethod[] = [];
  for (const o of entry) if (!seen.includes(o.call.method)) seen.push(o.call.method);
  return seen;
}

/**
 * The option for a method in a lane. `lane` null = no lane concept: the method's first option.
 * A lane the engine did not price for that method gives null (the row is skipped, never invented). O(C).
 */
export function entryOption(
  entry: readonly OptionOf<"zone_entry">[], method: EntryMethod, lane: EntryLane | null,
): OptionOf<"zone_entry"> | null {
  return entry.find((o) => o.call.method === method && (lane === null || o.call.lane === lane)) ?? null;
}

/** Highest chance among a lane's options that fit the clock; null when none does (or the lane is absent). O(C). */
export function bestLaneChance(entry: readonly OptionOf<"zone_entry">[], lane: EntryLane): number | null {
  let best: number | null = null;
  for (const o of entry) {
    if (o.call.lane !== lane || o.cutByClock) continue;
    if (best === null || o.p > best) best = o.p;
  }
  return best;
}

/**
 * Lane preselected when the sheet opens: the lane with the best top chance, middle on a tie (and middle when no
 * lane fits the clock), so the likeliest entry is one tap while the other lanes stay a tap away. null = no lanes. O(L x C).
 */
export function defaultEntryLane(entry: readonly OptionOf<"zone_entry">[]): EntryLane | null {
  const lanes = entryLanes(entry);
  if (lanes.length === 0) return null;
  let best: EntryLane | null = null;
  let bestP = Number.NEGATIVE_INFINITY;
  for (const lane of lanes) {
    const p = bestLaneChance(entry, lane);
    if (p === null) continue;
    if (p > bestP || (p === bestP && lane === "middle")) {
      best = lane;
      bestP = p;
    }
  }
  return best ?? (lanes.includes("middle") ? "middle" : (lanes[0] ?? null));
}

/**
 * The call to send for an entry / OZ faceoff option with the player's setup applied. The engine puts the current
 * formation on the option; this only overrides it when the player chose another. An option without the field
 * (older engine) stays untouched while the choice equals the current formation. O(1).
 */
export function withFormation<C extends Extract<Call, { type: "zone_entry" | "faceoff" }>>(
  call: C, chosen: PpFormationName, current: PpFormationName,
): C {
  const unchanged = call.formation === undefined ? chosen === current : call.formation === chosen;
  return unchanged ? call : { ...call, formation: chosen };
}

/** PP skaters on the ice now (picks the 4 / 5 / 6 diagram). Before the first placement, the scenario's strength. O(1). */
export function ppOnIce(s: Pick<RunSnapshot, "state" | "scenario">): number {
  return s.state.ppSpots.length > 0 ? s.state.ppSpots.length : s.scenario.strength.pp;
}

/**
 * The formation on the ice and its strong side. A state without them (an engine that predates formations) reads as
 * the run's starting formation, left. The parameter is deliberately loose so that case type-checks. O(1).
 */
export function currentSetup(
  s: { state: { formation?: PpFormationName; formationSide?: "left" | "right" }; input: { settings: { formation: PpFormationName } } },
): { formation: PpFormationName; side: "left" | "right" } {
  return { formation: s.state.formation ?? s.input.settings.formation, side: s.state.formationSide ?? "left" };
}
