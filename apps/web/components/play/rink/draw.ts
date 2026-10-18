/**
 * Canvas drawing for the rink: PK skaters on the lower canvas, the puck on the upper one (so it passes over
 * the DOM tokens). Pure drawing: positions in engine feet in, pixels out. O(D) per frame.
 * Thread ownership: main thread only.
 */
import type { Vec2 } from "@powerplay/engine/likelihood.ts";
import { toRinkPercent } from "../../../lib/play/geometry.ts";

export const CARRIER_PX = 50;
export const PK_PX = 28;
export const PUCK_PX = 10;
/** Design v2: the goalie is 26. */
export const GOALIE_PX = 26;
/** Goalie stands this far in front of the goal line, at the mouth of the crease. */
export const GOALIE_FROM_NET_FT = 1;
/** A held puck sits at the lower right of its carrier. */
export const HELD_PUCK_OFFSET_PX = CARRIER_PX * 0.46;

export const INK = "#0B1220";
export const PK_FILL = "#5E6B7D";
export const WHITE = "#FFFFFF";

export interface Surface { ctx: CanvasRenderingContext2D; w: number; h: number }

/** Size the backing store to the CSS box and clear it. Null while the canvas has no size. */
export function prepare(canvas: HTMLCanvasElement): Surface | null {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (w === 0 || h === 0) return null;
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw) canvas.width = bw;
  if (canvas.height !== bh) canvas.height = bh;
  const ctx = canvas.getContext("2d");
  if (ctx === null) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

export function toPx(p: Vec2, w: number, h: number): Vec2 | null {
  const r = toRinkPercent(p);
  return r.ok ? { x: (r.value.leftPct / 100) * w, y: (r.value.topPct / 100) * h } : null;
}

/** PK skaters: grey disc, white ring (they are never numbered or blue, so colour is not the only cue). */
export function drawPk(s: Surface, positions: readonly Vec2[]): void {
  const { ctx, w, h } = s;
  for (const d of positions) {
    const c = toPx(d, w, h);
    if (c === null) continue;
    ctx.fillStyle = PK_FILL;
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c.x, c.y, PK_PX / 2 - 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
}

export function drawPuck(s: Surface, pos: Vec2, offsetPx: number): void {
  const { ctx, w, h } = s;
  const c = toPx(pos, w, h);
  if (c === null) return;
  ctx.fillStyle = INK;
  ctx.strokeStyle = WHITE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(c.x + offsetPx, c.y + offsetPx, PUCK_PX / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}
