"use client";

/**
 * Power-play setup picker: one button per formation the engine can place, each with a small diagram drawn from the
 * engine's own spot table (lib/play/formations.ts) for the current skater count. Two sizes:
 *   full    2-column cards with name + one-line description (intro)
 *   compact one row of diagram + name (zone-entry and faceoff sheets)
 * Targets are >= 44 px; the selected one has aria-pressed. The overload diagram follows `side`.
 * Controlled and stateless. UI thread only.
 */
import type { PpFormationName } from "@powerplay/engine/sim-types.ts";
import { cx, FOCUS_RING } from "../ui/cx.ts";
import {
  availableFormations, formationDiagram, formationLabel, formationSub, type FormationSide,
} from "../../lib/play/formations.ts";

/** Same box as the offensive-zone art (public/rink/oz-rink.svg): 85 ft wide, 77 ft deep, net at the top. */
const DIAGRAM_VIEWBOX = "-42.5 0 85 77";
const GOAL_LINE_Y = 11;
const BLUE_LINE_Y = 75;
const HALF_WIDTH_FT = 42.5;
const NET_HALF_WIDTH_FT = 3;
const NET_DEPTH_FT = 4;
const DOT_RADIUS_FT = 5.5;
const LINE_WIDTH_FT = 1.4;

function Diagram({ name, skaters, side, selected }: { name: PpFormationName; skaters: number; side: FormationSide; selected: boolean }) {
  const dots = formationDiagram(name, skaters, side);
  return (
    <svg
      viewBox={DIAGRAM_VIEWBOX}
      aria-hidden="true"
      focusable="false"
      className="block h-auto w-full shrink-0 rounded-[6px]"
      style={{ background: "var(--color-surface)" }}
    >
      <line x1={-HALF_WIDTH_FT} x2={HALF_WIDTH_FT} y1={GOAL_LINE_Y} y2={GOAL_LINE_Y} stroke="var(--color-rink-red)" strokeWidth={LINE_WIDTH_FT} opacity={0.8} />
      <line x1={-HALF_WIDTH_FT} x2={HALF_WIDTH_FT} y1={BLUE_LINE_Y} y2={BLUE_LINE_Y} stroke="var(--color-blue-line)" strokeWidth={LINE_WIDTH_FT * 2} opacity={0.9} />
      <rect
        x={-NET_HALF_WIDTH_FT} y={GOAL_LINE_Y - NET_DEPTH_FT} width={2 * NET_HALF_WIDTH_FT} height={NET_DEPTH_FT}
        fill="none" stroke="var(--color-text-muted)" strokeWidth={LINE_WIDTH_FT}
      />
      {dots.ok
        ? dots.value.map((d) => (
            <circle
              key={d.id} cx={d.x} cy={d.y} r={DOT_RADIUS_FT}
              fill="var(--color-pp-fill)" stroke={selected ? "var(--color-accent)" : "var(--color-pp)"} strokeWidth={LINE_WIDTH_FT * 1.4}
            />
          ))
        : null}
    </svg>
  );
}

interface Props {
  value: PpFormationName;
  onChange: (next: PpFormationName) => void;
  /** PP skaters on the ice (state.ppSpots.length); picks the 4 / 5 / 6 layout. */
  skaters: number;
  /** Strong side drawn for overload. */
  side: FormationSide;
  /** Accessible group name, e.g. "Setup after entry". */
  label: string;
  compact?: boolean;
  disabled?: boolean;
  /** Test seam: restrict the choices (defaults to what the engine table can place). */
  choices?: readonly PpFormationName[];
}

export function FormationPicker({ value, onChange, skaters, side, label, compact = false, disabled = false, choices }: Props) {
  const options = choices ?? availableFormations();
  const cols = compact ? (options.length >= 4 ? "grid-cols-4" : "grid-cols-2") : "grid-cols-2";
  return (
    <div role="group" aria-label={label} className="flex flex-col gap-1.5">
      <h2 className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">{label}</h2>
      <div className={cx("grid gap-1.5", cols)}>
        {options.map((name) => {
          const selected = name === value;
          const title = formationLabel(name) ?? name;
          const sub = formationSub(name);
          return (
            <button
              key={name}
              type="button"
              aria-pressed={selected}
              aria-label={`${title}. ${sub}`}
              disabled={disabled}
              onClick={() => onChange(name)}
              className={cx(
                "box-border flex min-h-touch rounded-md border text-left text-text",
                compact ? "flex-col items-center gap-1 px-1.5 py-1.5" : "items-center gap-3 p-2",
                selected ? "border-2 border-accent bg-accent-sunk" : "border-border bg-surface-sunk",
                "disabled:cursor-not-allowed disabled:opacity-60",
                FOCUS_RING,
              )}
            >
              <span className={compact ? "block w-full max-w-[64px]" : "block w-[72px] shrink-0"}>
                <Diagram name={name} skaters={skaters} side={side} selected={selected} />
              </span>
              <span className={cx("flex min-w-0 flex-col gap-0.5", compact && "items-center text-center")}>
                <span className={cx("font-semibold", compact ? "text-[12px] leading-tight" : "text-[15px]")}>{title}</span>
                {compact ? null : <span className="text-xs leading-[1.35] text-text-muted">{sub}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

