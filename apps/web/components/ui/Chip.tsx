import type { ReactNode } from "react";
import { cx, FOCUS_RING } from "./cx.ts";

const PILL =
  "relative inline-flex items-center rounded-pill border border-border bg-surface px-3 py-1.5 text-[13px] text-text";

// Invisible 44 px tall strip centred on the pill: the visual chip stays small, the tap target does not.
const HIT_AREA = "before:absolute before:inset-x-0 before:top-1/2 before:h-touch before:-translate-y-1/2 before:content-['']";

/**
 * Pill chip. Static by default (a span). With `onClick` it is a button with a 44 px hit area
 * (DESIGN.md: touch targets >= 44 px).
 */
export function Chip({
  children,
  onClick,
  selected,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  selected?: boolean;
  className?: string;
}) {
  if (!onClick) return <span className={cx(PILL, className)}>{children}</span>;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cx(
        PILL,
        "min-w-touch justify-center",
        HIT_AREA,
        selected && "border-accent bg-accent-sunk text-on-accent-sunk",
        FOCUS_RING,
        className,
      )}
    >
      {children}
    </button>
  );
}
