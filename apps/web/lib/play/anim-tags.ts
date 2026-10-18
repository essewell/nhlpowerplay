/**
 * Name-tag placement for rink tokens. Pure; pixels, origin top-left of the rink box. O(1).
 * The tag sits under its token, slides sideways to stay inside the box (it stays under the token as far as the
 * box allows) and flips above the token when there is no room below.
 */
import type { Vec2 } from "@powerplay/engine/likelihood.ts";
import { err, ok, type Result } from "@powerplay/engine/result.ts";

export interface Size { w: number; h: number }

export interface TagInput {
  /** Token centre. */
  anchor: Vec2;
  tokenRadius: number;
  tag: Size;
  box: Size;
  /** Space between token edge and tag. */
  gap: number;
  /** Minimum space between tag and box edge. */
  margin: number;
}

export interface TagPlacement {
  /** Top-left of the tag. */
  x: number;
  y: number;
  side: "below" | "above";
  /** False only when the tag is larger than the box allows even after clamping (then it is centred). */
  fits: boolean;
}

const finite = (...n: number[]): boolean => n.every(Number.isFinite);

/** Rough width for the first frame, before the real text has been measured. */
export function estimateTagWidth(text: string, charPx: number, padXPx: number): number {
  return Math.max(0, text.length) * charPx + 2 * padXPx;
}

export function placeTag(i: TagInput): Result<TagPlacement> {
  const { anchor, tokenRadius, tag, box, gap, margin } = i;
  if (!finite(anchor.x, anchor.y, tokenRadius, tag.w, tag.h, box.w, box.h, gap, margin)) {
    return err("non-finite tag placement input");
  }
  if (box.w <= 0 || box.h <= 0 || tag.w <= 0 || tag.h <= 0) return err("tag and box need a positive size");

  const maxX = box.w - tag.w - margin;
  const maxY = box.h - tag.h - margin;
  const fitsX = maxX >= margin;
  const x = fitsX ? Math.min(maxX, Math.max(margin, anchor.x - tag.w / 2)) : (box.w - tag.w) / 2;

  const below = anchor.y + tokenRadius + gap;
  const above = anchor.y - tokenRadius - gap - tag.h;
  const useBelow = below <= maxY || above < margin;
  const yRaw = useBelow ? below : above;
  const fitsY = maxY >= margin;
  const y = fitsY ? Math.min(maxY, Math.max(margin, yRaw)) : (box.h - tag.h) / 2;

  return ok({ x, y, side: useBelow ? "below" : "above", fits: fitsX && fitsY });
}
