/** Join class names, skipping falsy values. O(n). */
export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Keyboard focus ring shared by every interactive primitive (pp blue reads on bg, surface and accent). */
export const FOCUS_RING = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-pp";
