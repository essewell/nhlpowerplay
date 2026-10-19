/**
 * Power-play formations for the UI: which ones the engine can place, their display copy, and the
 * diagram dots for the picker. Pure; no DOM, no clock, no randomness.
 *
 * Positions come from the engine tables (PP_FORMATIONS spot names -> OZ_SPOTS feet) through
 * geometry.toRink, so a diagram always matches what the rink shows. Nothing is typed here.
 * Big-O: every function is O(S) for S <= 6 skaters.
 */
import { OZ_SPOTS, PP_FORMATIONS } from "@powerplay/engine/constants.ts";
import { formationSpots, type FormationSide } from "@powerplay/engine/formation.ts";
import { ok, type Result } from "@powerplay/engine/result.ts";
import type { PpFormationName } from "@powerplay/engine/sim-types.ts";
import { toRink } from "./geometry.ts";
import { fillCopy, type PlayCopyKey } from "./strings.ts";

/** Order shown in the picker. */
export const FORMATION_ORDER = ["umbrella", "one_three_one", "overload", "spread"] as const satisfies readonly PpFormationName[];

export const DEFAULT_FORMATION: PpFormationName = "umbrella";

export type { FormationSide };
export type FormationSkaters = 4 | 5 | 6;

export const isFormationName = (x: unknown): x is PpFormationName =>
  typeof x === "string" && (FORMATION_ORDER as readonly string[]).includes(x);

interface FormationCopy { name: PlayCopyKey; sub: PlayCopyKey }
const FORMATION_COPY: Record<PpFormationName, FormationCopy> = {
  umbrella: { name: "formation.umbrella", sub: "formation.umbrella.sub" },
  one_three_one: { name: "formation.one_three_one", sub: "formation.one_three_one.sub" },
  overload: { name: "formation.overload", sub: "formation.overload.sub" },
  spread: { name: "formation.spread", sub: "formation.spread.sub" },
};

/** Display name; null for a name this UI does not know (an engine addition), so callers can fall back. */
export function formationLabel(name: string): string | null {
  return isFormationName(name) ? fillCopy(FORMATION_COPY[name].name) : null;
}

export function formationSub(name: PpFormationName): string {
  return fillCopy(FORMATION_COPY[name].sub);
}

/** Nearest layout size: 4 or fewer -> 4, 6 or more -> 6. Non-finite counts count as 5 (the usual PP). */
export function clampSkaters(n: number): FormationSkaters {
  if (!Number.isFinite(n)) return 5;
  if (n <= 4) return 4;
  if (n >= 6) return 6;
  return 5;
}

/** Formations the engine can place, in picker order. Never empty: umbrella is the fallback. */
export function availableFormations(table: object = PP_FORMATIONS): PpFormationName[] {
  const found = FORMATION_ORDER.filter((f) => Object.hasOwn(table, f));
  return found.length > 0 ? found : [DEFAULT_FORMATION];
}

export interface DiagramDot { id: string; x: number; y: number }

/**
 * Dots for a formation in rink-art units (feet; net at the top, attacker's left on screen-left), for `skaters`
 * players. Spots come from the engine's formationSpots (overload is mirrored there for the right side).
 * Err when the engine has no layout.
 */
export function formationDiagram(name: PpFormationName, skaters: number, side: FormationSide): Result<DiagramDot[]> {
  const spots = formationSpots(name, clampSkaters(skaters), side);
  if (!spots.ok) return spots;
  const dots: DiagramDot[] = [];
  for (const spot of spots.value) {
    const r = toRink(OZ_SPOTS[spot]);
    if (!r.ok) return r;
    dots.push({ id: spot, x: r.value.x, y: r.value.y });
  }
  return ok(dots);
}

/** Chip text for the decision screen: "Umbrella", or "Overload · left" (the side only matters for overload). */
export function formationChipText(name: string, side: string | undefined): string {
  const label = formationLabel(name) ?? name.replaceAll("_", " ");
  if (name === "overload" && (side === "left" || side === "right")) {
    return fillCopy("formation.chip.side", { formation: label, side: fillCopy(side === "left" ? "formation.side.left" : "formation.side.right") });
  }
  return label;
}
