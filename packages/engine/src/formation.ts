/**
 * Positions for the discrete-event power-play simulation: PP skaters on named OZ spots, PK
 * defenders from templates shifted toward the puck.
 * Stateless and pure: safe in Web Workers and on the server. Fully deterministic, no randomness
 * here (same inputs => same outputs, bit for bit). Expected bad input returns Result, never throws.
 * Coordinates: feet, attacking +x, net at NET, y > 0 = attacking team's left (see constants.ts).
 */
import { NET, OZ_BOUNDS, OZ_SPOTS, PK, PK_TEMPLATES, PP_FORMATIONS } from "./constants.ts";
import type { PkTemplateName, PpSkaterCount, SpotName } from "./constants.ts";
import { dist, validPos } from "./likelihood.ts";
import type { Vec2 } from "./likelihood.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { PpFormationName } from "./sim-types.ts";

export interface PpSpot { id: number; spot: SpotName }

/** Compile-time check that the constants table covers exactly the formation names in sim-types. */
const FORMATIONS: Record<PpFormationName, Record<PpSkaterCount, readonly SpotName[]>> = PP_FORMATIONS;

/** PK skater count -> template. 5 PK only happens against a 6-skater PP (goalie pulled). */
const PK_TEMPLATE_FOR: Record<number, PkTemplateName> = { 3: "triangle", 4: PK.FORMATION_4, 5: "five" };

/** O(1). True for the PP skater counts the formation tables cover. */
export function isSkaterCount(n: number): n is PpSkaterCount {
  return n === 4 || n === 5 || n === 6;
}

function isSpotName(s: string): s is SpotName {
  return Object.hasOwn(OZ_SPOTS, s);
}

/** O(1). Coordinates of a named spot, as a fresh object. */
export function spotPos(spot: SpotName): Vec2 {
  const p = OZ_SPOTS[spot];
  return { x: p.x, y: p.y };
}

/**
 * O(n) for n skaters. Assign the formation's spot list for that skater count: the carrier gets the
 * first (default puck-carrier) spot, the others take the remaining spots in input order.
 */
export function placePp(skaterIds: number[], formation: PpFormationName, carrierId: number): Result<PpSpot[]> {
  if (!Object.hasOwn(FORMATIONS, formation)) return err(`unknown PP formation ${String(formation)}`);
  const n = skaterIds.length;
  if (!isSkaterCount(n)) return err(`PP formation needs 4, 5 or 6 skaters, got ${n}`);
  const seen = new Set<number>();
  for (const id of skaterIds) {
    if (!Number.isInteger(id)) return err(`invalid skater id ${id}`);
    if (seen.has(id)) return err(`duplicate skater id ${id}`);
    seen.add(id);
  }
  if (!seen.has(carrierId)) return err(`carrier ${carrierId} is not among the PP skaters`);
  const spots = FORMATIONS[formation][n];
  const order = [carrierId, ...skaterIds.filter((id) => id !== carrierId)];
  const out: PpSpot[] = [];
  for (let i = 0; i < n; i++) {
    const id = order[i], spot = spots[i];
    if (id === undefined || spot === undefined) return err(`formation ${formation} has no spot ${i} for ${n} skaters`);
    out.push({ id, spot });
  }
  return ok(out);
}

/**
 * O(n). Put the carrier on `spot`. If a teammate already holds it, the teammate swaps to the
 * carrier's old spot. Returns a new array in the same order; the input is not mutated.
 */
export function moveCarrierTo(spots: readonly PpSpot[], carrierId: number, spot: SpotName): Result<PpSpot[]> {
  if (!isSpotName(spot)) return err(`unknown spot ${String(spot)}`);
  const ids = new Set<number>();
  for (const s of spots) {
    if (ids.has(s.id)) return err(`duplicate skater id ${s.id}`);
    ids.add(s.id);
  }
  const carrier = spots.find((s) => s.id === carrierId);
  if (carrier === undefined) return err(`carrier ${carrierId} is not among the PP skaters`);
  const oldSpot = carrier.spot;
  return ok(spots.map((s) => {
    if (s.id === carrierId) return { id: s.id, spot };
    if (s.spot === spot) return { id: s.id, spot: oldSpot };
    return { id: s.id, spot: s.spot };
  }));
}

/** O(n). Id of the PP skater whose spot is nearest `point`; exact ties go to the lowest id. */
export function nearestPp(spots: readonly PpSpot[], point: Vec2): Result<number> {
  if (!validPos(point)) return err("non-finite point");
  let best: { id: number; d: number } | null = null;
  for (const s of spots) {
    if (!isSpotName(s.spot)) return err(`unknown spot ${String(s.spot)}`);
    const d = dist(spotPos(s.spot), point);
    if (best === null || d < best.d || (d === best.d && s.id < best.id)) best = { id: s.id, d };
  }
  if (best === null) return err("no PP skaters");
  return ok(best.id);
}

/** O(1). Clamp a point into the offensive zone rectangle. */
function clampToZone(p: Vec2): Vec2 {
  return {
    x: Math.min(OZ_BOUNDS.X_MAX, Math.max(OZ_BOUNDS.X_MIN, p.x)),
    y: Math.min(OZ_BOUNDS.Y_ABS_MAX, Math.max(-OZ_BOUNDS.Y_ABS_MAX, p.y)),
  };
}

/**
 * O(k) for k defenders. PK positions for a puck location:
 *  1. template (3 -> triangle, 4 -> PK.FORMATION_4, 5 -> "five" = box + one on the anchor) placed at
 *     PK.ANCHOR + offset + PK.SHIFT_K * (puck - PK.ANCHOR);
 *  2. the defender nearest the puck (ties: lowest index) moves to PK.PRESSURE_GAP_FT from the puck
 *     along the puck->NET line (puck exactly on NET: straight out from the net toward the blue line);
 *  3. everything is clamped into the offensive zone (OZ_BOUNDS).
 * Output order is the template order, independent of the puck. Pucks outside the zone are allowed.
 */
export function pkPositions(puck: Vec2, pkCount: number): Result<Vec2[]> {
  if (!validPos(puck)) return err("non-finite puck position");
  const name = PK_TEMPLATE_FOR[pkCount];
  if (name === undefined) return err(`PK needs 3, 4 or 5 skaters, got ${pkCount}`);
  const shiftX = PK.SHIFT_K * (puck.x - PK.ANCHOR.x);
  const shiftY = PK.SHIFT_K * (puck.y - PK.ANCHOR.y);
  const pos: Vec2[] = PK_TEMPLATES[name].map((o) => ({
    x: PK.ANCHOR.x + o.x + shiftX,
    y: PK.ANCHOR.y + o.y + shiftY,
  }));

  let nearest = -1, nearestD = Infinity;
  pos.forEach((p, i) => {
    const d = dist(p, puck);
    if (d < nearestD) { nearest = i; nearestD = d; }
  });
  const toNet = dist(puck, NET);
  // Unit vector puck -> net; on the net itself, face back out toward the blue line (-x).
  const ux = toNet > 0 ? (NET.x - puck.x) / toNet : -1;
  const uy = toNet > 0 ? (NET.y - puck.y) / toNet : 0;
  const pressured = pos.map((p, i) => (i === nearest
    ? { x: puck.x + PK.PRESSURE_GAP_FT * ux, y: puck.y + PK.PRESSURE_GAP_FT * uy }
    : p));
  return ok(pressured.map(clampToZone));
}
