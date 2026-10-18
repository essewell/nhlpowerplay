import type { ReactNode } from "react";
import { rawCopy } from "../../../lib/copy.ts";
import type { CopyKey } from "../../../lib/copy.ts";
import { splitTemplate } from "../logic.ts";

/**
 * Visible stand-in for a launch value that is not set yet (lib/site.ts). Dashed amber outline so it
 * cannot be missed in review; docs/LAUNCH.md go/no-go needs these filled before launch.
 */
export function TodoValue({ children }: { children: ReactNode }) {
  return (
    <mark
      data-todo="launch-value"
      className="rounded-chip border border-dashed border-grade-close bg-transparent px-1.5 text-grade-close"
    >
      {children}
    </mark>
  );
}

/**
 * Render a copy template, putting a node into each named slot, e.g. "Questions: {contactEmail}".
 * Slots missing from `slots` stay as literal text. O(template length).
 */
export function TemplateText({ copyKey, slots }: { copyKey: CopyKey; slots: Record<string, ReactNode> }) {
  const parts = splitTemplate(rawCopy(copyKey), Object.keys(slots));
  return (
    <>
      {parts.map((part, i) => ("slot" in part ? <span key={i}>{slots[part.slot]}</span> : <span key={i}>{part.text}</span>))}
    </>
  );
}
