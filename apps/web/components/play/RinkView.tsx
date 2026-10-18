"use client";

/**
 * The offensive zone. Layers, bottom to top:
 *   1. oz-rink.svg (markings, 1 unit = 1 ft)
 *   2. SVG overlay: dashed lanes from the puck carrier to each pass target
 *   3. Canvas: PK skaters, goalie and puck (decoration, redrawn when positions or size change)
 *   4. DOM: the puck carrier (accent, 50) and the PP receivers (pp, 44 x 44 buttons that make the pass)
 * Receivers are DOM buttons, not canvas hit-tests, so they are focusable, labelled and >= 44 px.
 * Thread ownership: main thread only. The canvas has no animation, so prefers-reduced-motion needs no special case.
 * Cost: O(S + D) per draw (S PP skaters, D <= 5 defenders).
 */
import Image from "next/image";
import { useEffect, useMemo, useRef } from "react";
import { NET, OZ_SPOTS, type SpotName } from "@powerplay/engine/constants.ts";
import type { Vec2 } from "@powerplay/engine/likelihood.ts";
import type { RunState } from "@powerplay/engine/sim-types.ts";
import { cx, FOCUS_RING } from "../ui/cx.ts";
import { RINK_VIEWBOX, toRink, toRinkPercent } from "../../lib/play/geometry.ts";
import type { PlayerLabel } from "../../lib/play/options.ts";
import { fillCopy } from "../../lib/play/strings.ts";

const CARRIER_PX = 50;
const RECEIVER_PX = 44;
const PK_PX = 28;
const PUCK_PX = 10;
/** Goalie stands just in front of the goal line, inside the crease. */
const GOALIE_FROM_NET_FT = 2.5;
const INK = "#0B1220";
const PK_FILL = "#5E6B7D";
const WHITE = "#FFFFFF";

export interface RinkPassTarget {
  id: number;
  label: PlayerLabel;
  disabled: boolean;
}

interface Props {
  state: Pick<RunState, "puck" | "pkPos" | "ppSpots" | "carrier">;
  carrier: { id: number; label: PlayerLabel } | null;
  targets: readonly RinkPassTarget[];
  onPass: (id: number) => void;
}

const spotVec = (spot: SpotName): Vec2 => OZ_SPOTS[spot];

/** Name pills hug the token on the side nearest the boards so they never run off the rink. */
const EDGE_ALIGN_PCT = 30;
type LabelAlign = "left" | "centre" | "right";
const LABEL_ALIGN: Record<LabelAlign, string> = {
  left: "left-[-22px]",
  centre: "left-1/2 -translate-x-1/2",
  right: "right-[-22px]",
};

function place(p: Vec2): { left: string; top: string; align: LabelAlign } | null {
  const r = toRinkPercent(p);
  if (!r.ok) return null;
  const { leftPct, topPct } = r.value;
  const align: LabelAlign = leftPct < EDGE_ALIGN_PCT ? "left" : leftPct > 100 - EDGE_ALIGN_PCT ? "right" : "centre";
  return { left: `${leftPct}%`, top: `${topPct}%`, align };
}

export function RinkView({ state, carrier, targets, onPass }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const carrierSpot = carrier === null ? null : state.ppSpots.find((x) => x.id === carrier.id)?.spot ?? null;
  const carrierPos = carrierSpot === null ? null : spotVec(carrierSpot);
  const { pkPos, puck } = state;

  // Redraw whenever the engine positions change or the box is resized.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const draw = () => {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      if (w === 0 || h === 0) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      const ctx = canvas.getContext("2d");
      if (ctx === null) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const px = (p: Vec2): { x: number; y: number } | null => {
        const r = toRinkPercent(p);
        return r.ok ? { x: (r.value.leftPct / 100) * w, y: (r.value.topPct / 100) * h } : null;
      };
      // Goalie: grey disc with a "G".
      const g = px({ x: NET.x - GOALIE_FROM_NET_FT, y: NET.y });
      if (g !== null) {
        ctx.fillStyle = PK_FILL;
        ctx.beginPath();
        ctx.arc(g.x, g.y, 13, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = WHITE;
        ctx.font = "600 11px system-ui, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("G", g.x, g.y + 0.5);
      }
      // PK skaters: grey disc, white ring (colour is not the only cue: they are never numbered or blue).
      for (const d of pkPos) {
        const c = px(d);
        if (c === null) continue;
        ctx.fillStyle = PK_FILL;
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(c.x, c.y, PK_PX / 2 - 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      // Puck, tucked to the lower right of whoever holds it.
      const pk = px(puck);
      if (pk !== null) {
        const off = carrierPos === null ? 0 : CARRIER_PX * 0.46;
        ctx.fillStyle = INK;
        ctx.strokeStyle = WHITE;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(pk.x + off, pk.y + off, PUCK_PX / 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };
    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(canvas);
    return () => ro.disconnect();
  }, [pkPos, puck, carrierPos]);

  const lanes = useMemo(() => {
    if (carrierPos === null) return [];
    const from = toRink(carrierPos);
    if (!from.ok) return [];
    const out: { id: number; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const tg of targets) {
      const spot = state.ppSpots.find((x) => x.id === tg.id)?.spot;
      if (spot === undefined) continue;
      const to = toRink(spotVec(spot));
      if (to.ok) out.push({ id: tg.id, x1: from.value.x, y1: from.value.y, x2: to.value.x, y2: to.value.y });
    }
    return out;
  }, [carrierPos, targets, state.ppSpots]);

  const carrierAt = carrierPos === null ? null : place(carrierPos);

  return (
    <div
      role="group"
      aria-label={fillCopy("play.rink.aria")}
      className="relative mx-auto aspect-[85/77] w-full max-w-[420px] overflow-hidden rounded-rink bg-ice"
    >
      <Image src="/rink/oz-rink.svg" alt="" fill unoptimized priority className="pointer-events-none select-none" />
      <svg
        aria-hidden="true"
        viewBox={`${RINK_VIEWBOX.minX} ${RINK_VIEWBOX.minY} ${RINK_VIEWBOX.width} ${RINK_VIEWBOX.height}`}
        className="pointer-events-none absolute inset-0 size-full"
      >
        {lanes.map((l) => (
          <line
            key={l.id}
            x1={l.x1}
            y1={l.y1}
            x2={l.x2}
            y2={l.y2}
            stroke={INK}
            strokeOpacity={0.55}
            strokeWidth={2}
            strokeDasharray="6 5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <canvas ref={canvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />

      {targets.map((tg) => {
        const spot = state.ppSpots.find((x) => x.id === tg.id)?.spot;
        const at = spot === undefined ? null : place(spotVec(spot));
        if (at === null) return null;
        const name =
          tg.label.number === null
            ? fillCopy("play.pass.aria.noNumber", { lastName: tg.label.lastName })
            : fillCopy("play.pass.aria", { lastName: tg.label.lastName, number: tg.label.number });
        return (
          <div key={tg.id} className="absolute" style={{ left: at.left, top: at.top }}>
            <button
              type="button"
              aria-label={name}
              disabled={tg.disabled}
              onClick={() => onPass(tg.id)}
              style={{ width: RECEIVER_PX, height: RECEIVER_PX }}
              className={cx(
                "-translate-x-1/2 -translate-y-1/2 rounded-full border-[3px] border-pp bg-pp-fill p-0",
                "font-display text-lg font-bold text-white disabled:cursor-not-allowed disabled:opacity-60",
                FOCUS_RING,
              )}
            >
              {tg.label.number ?? tg.label.lastName.slice(0, 1)}
            </button>
            <span
              aria-hidden="true"
              className={cx(
                "pointer-events-none absolute top-[26px] whitespace-nowrap rounded-chip bg-bg px-[7px] py-[3px]",
                "text-[11px] font-semibold uppercase leading-none text-white",
                LABEL_ALIGN[at.align],
              )}
            >
              {tg.label.lastName}
            </span>
          </div>
        );
      })}

      {carrier !== null && carrierAt !== null ? (
        <div className="absolute" style={{ left: carrierAt.left, top: carrierAt.top }}>
          <div
            role="img"
            aria-label={
              carrier.label.number === null
                ? fillCopy("play.carrier.aria.noNumber", { lastName: carrier.label.lastName })
                : fillCopy("play.carrier.aria", { lastName: carrier.label.lastName, number: carrier.label.number })
            }
            style={{ width: CARRIER_PX, height: CARRIER_PX }}
            className="-translate-x-1/2 -translate-y-1/2 box-border flex items-center justify-center rounded-full border-[3px] border-white bg-accent font-display text-xl font-bold text-on-accent"
          >
            {carrier.label.number ?? carrier.label.lastName.slice(0, 1)}
          </div>
        </div>
      ) : null}
    </div>
  );
}
