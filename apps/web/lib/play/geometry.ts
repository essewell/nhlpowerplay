/**
 * Rink coordinate mapping. Pure; no DOM, no clock, no randomness. O(1) per call.
 *
 * Engine feet: x 25..100 (blue line to end boards), net at x = 89, y > 0 is the attacking team's LEFT
 * as it faces the net. The rink art (public/rink/oz-rink.svg, viewBox -42.5 0 85 77, 1 unit = 1 ft) has the
 * net at the TOP, so a viewer looking up the ice sees the attacker's left on screen-left:
 *   svgX = -y,  svgY = X_MAX - x   (net x = 89 -> svgY 11, which is the goal line in the art).
 */
import { OZ_BOUNDS } from "@powerplay/engine/constants.ts";
import type { Vec2 } from "@powerplay/engine/likelihood.ts";
import { err, ok, type Result } from "@powerplay/engine/result.ts";

/** Same numbers as the viewBox of oz-rink.svg. */
export const RINK_VIEWBOX = {
  minX: -OZ_BOUNDS.Y_ABS_MAX,
  minY: 0,
  width: 2 * OZ_BOUNDS.Y_ABS_MAX,
  height: 77,
} as const;

/** Engine feet -> rink art units (feet). Non-finite input is an error. */
export function toRink(p: Vec2): Result<Vec2> {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return err(`non-finite rink position (${p.x}, ${p.y})`);
  // `+ 0` turns -0 into 0 so the centre line is not "-0".
  return ok({ x: -p.y + 0, y: OZ_BOUNDS.X_MAX - p.x });
}

/** Inverse of toRink. */
export function fromRink(p: Vec2): Result<Vec2> {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return err(`non-finite rink art position (${p.x}, ${p.y})`);
  return ok({ x: OZ_BOUNDS.X_MAX - p.y, y: -p.x + 0 });
}

export interface RinkPercent {
  leftPct: number;
  topPct: number;
}

const clampPct = (v: number): number => Math.min(100, Math.max(0, v));

/**
 * Engine feet -> position inside the rink box as percentages (for absolutely positioned tokens).
 * Positions outside the art (a bad PK template) are clamped to the box edge rather than escaping it.
 */
export function toRinkPercent(p: Vec2): Result<RinkPercent> {
  const r = toRink(p);
  if (!r.ok) return r;
  return ok({
    leftPct: clampPct(((r.value.x - RINK_VIEWBOX.minX) / RINK_VIEWBOX.width) * 100),
    topPct: clampPct(((r.value.y - RINK_VIEWBOX.minY) / RINK_VIEWBOX.height) * 100),
  });
}
