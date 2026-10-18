"use client";

/**
 * The offensive zone. Layers, bottom to top:
 *   1. oz-rink.svg (markings, 1 unit = 1 ft)
 *   2. SVG overlay: dashed lanes from the puck carrier to each pass target
 *   3. Canvas: PK skaters
 *   4. DOM: the puck carrier (accent, 50) and the PP receivers (pp, 44 x 44 buttons that make the pass) with name tags
 *   5. Canvas: the puck (above the tokens so a pass is seen crossing them)
 *   6. DOM: the PK goalie (26, "G"), above the tokens because the net-front skater stands in the crease
 * Receivers are DOM buttons, not canvas hit-tests, so they are focusable, labelled and >= 44 px.
 *
 * Motion: when a state arrives whose log extends the one drawn last (see lib/play/anim.ts), PP tokens (CSS
 * transforms), PK skaters and the puck (canvas) glide from the old engine positions to the new ones in one
 * requestAnimationFrame loop, 400-700 ms. Pass buttons ignore clicks until it ends. prefers-reduced-motion:
 * no motion, nothing locked. Name tags are measured and kept fully inside the box (lib/play/anim-tags.ts).
 * Thread ownership: main thread only; the animation loop is owned by this component and cancelled on unmount.
 * Cost: O(S + D) per frame (S PP skaters, D <= 5 defenders).
 */
import Image from "next/image";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { OZ_SPOTS, NET, type SpotName } from "@powerplay/engine/constants.ts";
import type { Vec2 } from "@powerplay/engine/likelihood.ts";
import type { RunEvent, RunState } from "@powerplay/engine/sim-types.ts";
import { cx, FOCUS_RING } from "../ui/cx.ts";
import { advanceRink } from "../../lib/play/anim-memory.ts";
import { estimateTagWidth, placeTag, type Size } from "../../lib/play/anim-tags.ts";
import { clamp01, easeInOutCubic, lerp, pkAt, puckAt, type MotionPlan } from "../../lib/play/anim.ts";
import { RINK_VIEWBOX, toRink, toRinkPercent } from "../../lib/play/geometry.ts";
import type { PlayerLabel } from "../../lib/play/options.ts";
import { fillCopy } from "../../lib/play/strings.ts";
import {
  CARRIER_PX, drawPk, drawPuck, GOALIE_FROM_NET_FT, GOALIE_PX, HELD_PUCK_OFFSET_PX, INK, prepare, toPx,
} from "./rink/draw.ts";

const RECEIVER_PX = 44;
const TAG_GAP_PX = 4;
const TAG_MARGIN_PX = 3;
const TAG_CHAR_PX = 7.4;
const TAG_PAD_X_PX = 7;
const TAG_HEIGHT_PX = 17;
/** Finish the animation even if the browser never delivers a frame (hidden tab). */
const FINISH_SLACK_MS = 250;

export interface RinkPassTarget {
  id: number;
  label: PlayerLabel;
  disabled: boolean;
}

interface Props {
  /** `log` is optional: without it the rink cannot tell what happened and shows the state without motion. */
  state: Pick<RunState, "puck" | "pkPos" | "ppSpots" | "carrier"> & { log?: readonly RunEvent[] };
  carrier: { id: number; label: PlayerLabel } | null;
  targets: readonly RinkPassTarget[];
  onPass: (id: number) => void;
}

const spotVec = (spot: SpotName): Vec2 => OZ_SPOTS[spot];

function place(p: Vec2): { left: string; top: string } | null {
  const r = toRinkPercent(p);
  return r.ok ? { left: `${r.value.leftPct}%`, top: `${r.value.topPct}%` } : null;
}

const prefersReducedMotion = (): boolean =>
  typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

interface Scene { pk: readonly Vec2[]; puck: Vec2; puckOffsetPx: number }

interface Running { logLength: number; raf: number; timer: number }

interface Refs {
  pk: React.RefObject<HTMLCanvasElement | null>;
  puck: React.RefObject<HTMLCanvasElement | null>;
  scene: React.RefObject<Scene | null>;
  running: React.RefObject<Running | null>;
  locked: React.RefObject<boolean>;
}

/** Draw both canvases and remember the scene so a resize can redraw it. */
function paint(r: Refs, scene: Scene): void {
  r.scene.current = scene;
  const lower = r.pk.current === null ? null : prepare(r.pk.current);
  if (lower !== null) drawPk(lower, scene.pk);
  const upper = r.puck.current === null ? null : prepare(r.puck.current);
  if (upper !== null) drawPuck(upper, scene.puck, scene.puckOffsetPx);
}

/** Cancel a running glide and give the tokens back to React. */
function stop(r: Refs, tokens: ReadonlyMap<number, HTMLElement>): void {
  const run = r.running.current;
  if (run !== null) {
    cancelAnimationFrame(run.raf);
    window.clearTimeout(run.timer);
  }
  r.running.current = null;
  r.locked.current = false;
  for (const el of tokens.values()) {
    el.style.transform = "";
    el.style.pointerEvents = "";
  }
}

export function RinkView({ state, carrier, targets, onPass }: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const pkCanvasRef = useRef<HTMLCanvasElement>(null);
  const puckCanvasRef = useRef<HTMLCanvasElement>(null);
  const [tokenEls] = useState(() => new Map<number, HTMLElement>());
  const sceneRef = useRef<Scene | null>(null);
  const runningRef = useRef<Running | null>(null);
  const lockedRef = useRef(false);
  const refs: Refs = useMemo(
    () => ({ pk: pkCanvasRef, puck: puckCanvasRef, scene: sceneRef, running: runningRef, locked: lockedRef }),
    [],
  );
  const [box, setBox] = useState<Size | null>(null);
  const [tagSizes, setTagSizes] = useState<Record<number, Size>>({});

  const carrierSpot = carrier === null ? null : state.ppSpots.find((x) => x.id === carrier.id)?.spot ?? null;
  const carrierPos = carrierSpot === null ? null : spotVec(carrierSpot);

  // ---------------------------------------------------------------- measure the box; repaint on resize
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el === null) return;
    const measure = () => {
      const next = { w: el.clientWidth, h: el.clientHeight };
      setBox((prev) => (prev !== null && prev.w === next.w && prev.h === next.h ? prev : next));
      if (sceneRef.current !== null) paint(refs, sceneRef.current);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [refs]);

  // ---------------------------------------------------------------- measure the name tags
  const tagKey = targets.map((x) => `${x.id}:${x.label.lastName}`).join("|");
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (el === null) return;
    const next: Record<number, Size> = {};
    for (const node of el.querySelectorAll<HTMLElement>("[data-tag]")) {
      const id = Number(node.dataset.tag);
      next[id] = { w: node.offsetWidth, h: node.offsetHeight };
    }
    setTagSizes((prev) => {
      const same =
        Object.keys(next).length === Object.keys(prev).length &&
        Object.entries(next).every(([id, s]) => prev[Number(id)]?.w === s.w && prev[Number(id)]?.h === s.h);
      return same ? prev : next;
    });
  }, [tagKey]);

  // ---------------------------------------------------------------- motion on a new state
  const logLength = state.log?.length ?? 0;
  useLayoutEffect(() => {
    const heldNow = state.carrier.kind === "pp";
    const still: Scene = { pk: state.pkPos, puck: state.puck, puckOffsetPx: heldNow ? HELD_PUCK_OFFSET_PX : 0 };
    if (runningRef.current?.logLength === logLength) return; // same state again: let the glide finish

    stop(refs, tokenEls);
    const planned = advanceRink(
      { puck: state.puck, pkPos: state.pkPos, ppSpots: state.ppSpots, carrier: state.carrier, ...(state.log === undefined ? {} : { log: state.log }) },
      performance.now(),
      prefersReducedMotion(),
    );
    if (!planned.ok) console.warn(`rink motion skipped: ${planned.error}`);
    const plan: MotionPlan | null = planned.ok ? planned.value : null;
    const el = boxRef.current;
    if (plan === null || el === null || el.clientWidth === 0) {
      paint(refs, still);
      return;
    }

    const w = el.clientWidth;
    const h = el.clientHeight;
    const deltas = new Map<number, { dx: number; dy: number }>();
    for (const n of state.ppSpots) {
      const before = plan.prevPpSpots.find((p) => p.id === n.id);
      if (before === undefined) continue;
      const a = toPx(spotVec(before.spot), w, h);
      const b = toPx(spotVec(n.spot), w, h);
      if (a !== null && b !== null) deltas.set(n.id, { dx: a.x - b.x, dy: a.y - b.y });
    }

    const frame = (t: number): void => {
      const e = easeInOutCubic(t);
      const puck = puckAt(plan.puckPath, e);
      paint(refs, {
        pk: pkAt(plan.prevPkPos, state.pkPos, e),
        puck: puck.ok ? puck.value : state.puck,
        puckOffsetPx: lerp(plan.prevPuckHeld ? HELD_PUCK_OFFSET_PX : 0, plan.nextPuckHeld ? HELD_PUCK_OFFSET_PX : 0, e),
      });
      for (const [id, d] of deltas) {
        const node = tokenEls.get(id);
        if (node !== undefined) node.style.transform = `translate(${(1 - e) * d.dx}px, ${(1 - e) * d.dy}px)`;
      }
    };
    const finish = (): void => {
      stop(refs, tokenEls);
      paint(refs, still);
    };

    lockedRef.current = true;
    for (const node of tokenEls.values()) node.style.pointerEvents = "none";
    frame(0);
    const startedAt = performance.now();
    const run: Running = { logLength, raf: 0, timer: 0 };
    const tick = (now: number): void => {
      const t = clamp01((now - startedAt) / plan.durationMs);
      frame(t);
      if (t >= 1) finish();
      else run.raf = requestAnimationFrame(tick);
    };
    run.raf = requestAnimationFrame(tick);
    run.timer = window.setTimeout(finish, plan.durationMs + FINISH_SLACK_MS);
    runningRef.current = run;
  }, [state, logLength, refs, tokenEls]);

  useEffect(() => () => stop(refs, tokenEls), [refs, tokenEls]);

  // ---------------------------------------------------------------- lanes
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
  const goalie = place({ x: NET.x - GOALIE_FROM_NET_FT, y: NET.y });
  const setToken = (id: number) => (el: HTMLElement | null) => {
    if (el === null) tokenEls.delete(id);
    else tokenEls.set(id, el);
  };

  /** Offset of the name tag from its token centre, in px, so the whole tag stays inside the box. */
  const tagOffset = (id: number, name: string, spot: SpotName): { left: number; top: number } | null => {
    if (box === null) return null;
    const px = toPx(spotVec(spot), box.w, box.h);
    if (px === null) return null;
    const tag = tagSizes[id] ?? { w: estimateTagWidth(name, TAG_CHAR_PX, TAG_PAD_X_PX), h: TAG_HEIGHT_PX };
    const placed = placeTag({
      anchor: px, tokenRadius: RECEIVER_PX / 2, tag, box, gap: TAG_GAP_PX, margin: TAG_MARGIN_PX,
    });
    return placed.ok ? { left: placed.value.x - px.x, top: placed.value.y - px.y } : null;
  };

  return (
    <div
      ref={boxRef}
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
      <canvas ref={pkCanvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />

      {targets.map((tg) => {
        const spot = state.ppSpots.find((x) => x.id === tg.id)?.spot;
        const at = spot === undefined ? null : place(spotVec(spot));
        if (spot === undefined || at === null) return null;
        const name =
          tg.label.number === null
            ? fillCopy("play.pass.aria.noNumber", { lastName: tg.label.lastName })
            : fillCopy("play.pass.aria", { lastName: tg.label.lastName, number: tg.label.number });
        const off = tagOffset(tg.id, tg.label.lastName, spot);
        return (
          <div key={tg.id} ref={setToken(tg.id)} className="absolute" style={{ left: at.left, top: at.top }}>
            <button
              type="button"
              aria-label={name}
              disabled={tg.disabled}
              onClick={() => {
                if (!lockedRef.current) onPass(tg.id);
              }}
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
              data-tag={tg.id}
              style={off === null ? { left: 0, top: 0 } : { left: off.left, top: off.top }}
              className={cx(
                "pointer-events-none absolute whitespace-nowrap rounded-chip bg-bg px-[7px] py-[3px]",
                "text-[11px] font-semibold uppercase leading-none text-white",
                off === null && "invisible",
              )}
            >
              {tg.label.lastName}
            </span>
          </div>
        );
      })}

      {carrier !== null && carrierAt !== null ? (
        <div ref={setToken(carrier.id)} className="absolute" style={{ left: carrierAt.left, top: carrierAt.top }}>
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

      <canvas ref={puckCanvasRef} aria-hidden="true" className="pointer-events-none absolute inset-0 size-full" />

      {goalie === null ? null : (
        <div className="pointer-events-none absolute" style={{ left: goalie.left, top: goalie.top }}>
          <div
            aria-hidden="true"
            style={{ width: GOALIE_PX, height: GOALIE_PX }}
            className="-translate-x-1/2 -translate-y-1/2 flex items-center justify-center rounded-full bg-pk text-[11px] font-semibold text-white"
          >
            G
          </div>
        </div>
      )}
    </div>
  );
}
