/**
 * Pure helpers behind the UI primitives, split out so node:test can cover them without a DOM.
 * No state, no DOM, no clock. Each function is O(1) unless noted.
 */

/** Meter fill width in whole percent (0..100). Non-finite input draws an empty meter. */
export function meterPercent(p: number): number {
  if (!Number.isFinite(p)) return 0;
  return Math.round(Math.min(1, Math.max(0, p)) * 100);
}

export type TabKey = "ArrowLeft" | "ArrowRight" | "Home" | "End";

/**
 * Roving-tabindex target for a tablist key press (WAI-ARIA tabs pattern). Arrow keys wrap.
 * Returns null for keys the tablist does not handle, an empty list, or a bad current index.
 */
export function nextTabIndex(current: number, key: string, count: number): number | null {
  if (!Number.isInteger(count) || count < 1) return null;
  if (!Number.isInteger(current) || current < 0 || current >= count) return null;
  switch (key) {
    case "ArrowRight":
      return (current + 1) % count;
    case "ArrowLeft":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Split a copy template around `{name}` slots so a component can put a node in a slot.
 * "Questions: {contactEmail}" with slot "contactEmail" -> [{text:"Questions: "},{slot:true}].
 * O(length of template).
 */
export type TemplatePart = { text: string } | { slot: string };
export function splitTemplate(template: string, slots: readonly string[]): TemplatePart[] {
  const parts: TemplatePart[] = [];
  const re = /\{([A-Za-z][A-Za-z0-9]*)\}/g;
  let last = 0;
  for (const m of template.matchAll(re)) {
    const name = m[1];
    if (name === undefined || !slots.includes(name)) continue;
    if (m.index > last) parts.push({ text: template.slice(last, m.index) });
    parts.push({ slot: name });
    last = m.index + m[0].length;
  }
  if (last < template.length) parts.push({ text: template.slice(last) });
  return parts;
}
