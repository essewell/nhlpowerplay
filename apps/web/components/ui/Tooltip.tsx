"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { t } from "../../lib/copy.ts";
import { cx, FOCUS_RING } from "./cx.ts";

/** Tooltip bubble: surface-raised, border-strong, r12, 12 x 14 padding, 13/1.45, shadow-pop. */
export function Tooltip({ id, children, className }: { id: string; children: ReactNode; className?: string }) {
  return (
    <div
      role="tooltip"
      id={id}
      className={cx(
        "z-20 rounded-md border border-border-strong bg-surface-raised px-3.5 py-3 text-[13px] leading-[1.45] text-text shadow-pop",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Info glyph button with a 44 x 44 hit area (glyph 18 px, or 16 px with `small`).
 * Negative margins give the hit area back to the layout so the row height does not grow.
 */
export function InfoButton({
  label,
  expanded,
  describedBy,
  onClick,
  small,
  className,
}: {
  label: string;
  expanded: boolean;
  describedBy: string;
  onClick: () => void;
  small?: boolean;
  className?: string;
}) {
  const size = small ? 16 : 18;
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={expanded}
      aria-describedby={describedBy}
      onClick={onClick}
      className={cx(
        "-my-3 -ml-1.5 -mr-3 flex size-touch shrink-0 items-center justify-center rounded-md text-text-muted",
        FOCUS_RING,
        className,
      )}
    >
      <svg width={size} height={size} viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <circle cx="9" cy="9" r="7.5" />
        <path d="M9 8v4.5" strokeLinecap="round" />
        <circle cx="9" cy="5.4" r="0.6" fill="currentColor" />
      </svg>
    </button>
  );
}

/**
 * Info button that toggles a tooltip. Escape or a press outside closes it. Client component;
 * state is local. The tooltip stays in the DOM only while open so aria-describedby points at it
 * when expanded.
 */
export function InfoTip({
  label,
  text,
  small,
  align = "right",
  className,
}: {
  label: string;
  text: string;
  small?: boolean;
  /** Which edge of the button the bubble lines up with. */
  align?: "left" | "right";
  className?: string;
}) {
  const id = useId();
  const tipId = `${id}-tip`;
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPress = (e: PointerEvent) => {
      if (root.current && e.target instanceof Node && !root.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPress);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPress);
    };
  }, [open]);

  return (
    <span ref={root} className={cx("relative inline-flex", className)}>
      <InfoButton label={label} expanded={open} describedBy={tipId} small={small} onClick={() => setOpen((v) => !v)} />
      {open ? (
        <Tooltip
          id={tipId}
          className={cx("absolute bottom-[calc(100%-4px)] w-[min(280px,calc(100vw-32px))]", align === "right" ? "right-0" : "left-0")}
        >
          {text}
        </Tooltip>
      ) : null}
    </span>
  );
}

/** Small "Estimate" tag (11/600, line 16, r6, border-strong). Static; pair with InfoTip via EstimateInfo. */
export function EstimateTag({ className }: { className?: string }) {
  return (
    <span
      className={cx(
        "inline-block rounded-chip border border-border-strong px-1.5 text-[11px] font-semibold leading-4 text-text-muted",
        className,
      )}
    >
      {t("pause.tag.estimate")}
    </span>
  );
}

/** Estimate tag with its info button. `text` is the explanation (COPY.md tag.oneTimer.info or how.numbers). */
export function EstimateInfo({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5", className)}>
      <EstimateTag />
      <InfoTip label={t("a11y.estimateInfo")} text={text} />
    </span>
  );
}
