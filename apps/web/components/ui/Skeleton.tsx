import type { CSSProperties, ReactNode } from "react";
import { cx } from "./cx.ts";

/**
 * Loading container: aria-busy, polite live region, optional visible or screen-reader label.
 * Children are SkeletonBlock placeholders (decorative, aria-hidden).
 */
export function Skeleton({
  label,
  hideLabel,
  className,
  children,
}: {
  label?: string;
  /** Keep the label for screen readers only. */
  hideLabel?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div aria-busy="true" aria-live="polite" className={className}>
      {label ? <div className={hideLabel ? "sr-only" : "text-[13px] text-text-soft"}>{label}</div> : null}
      {children}
    </div>
  );
}

/** One placeholder bar or box in the skeleton colour. Pulses unless the user prefers reduced motion. */
export function SkeletonBlock({
  width,
  height,
  radius = 6,
  className,
  style,
}: {
  width?: number | string;
  height?: number | string;
  radius?: number | string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      aria-hidden="true"
      className={cx("shrink-0 bg-skeleton motion-safe:animate-pulse", className)}
      style={{ width, height, borderRadius: radius, ...style }}
    />
  );
}

/** Option-row placeholder (52 high, round badge, two lines, meter), as in the v2 loading state. */
export function SkeletonRow() {
  return (
    <div className="box-border flex h-[52px] items-center gap-3 rounded-md border border-border bg-surface-sunk px-3 py-2">
      <SkeletonBlock width={34} height={34} radius="50%" />
      <div className="flex grow flex-col gap-1.5">
        <SkeletonBlock width={90} height={11} />
        <SkeletonBlock width={140} height={9} radius={5} />
      </div>
      <div aria-hidden="true" className="h-[5px] w-[72px] rounded-[3px] bg-border" />
    </div>
  );
}

/** A busy list of SkeletonRow placeholders. */
export function SkeletonRows({ count = 4, label, hideLabel = true }: { count?: number; label?: string; hideLabel?: boolean }) {
  return (
    <Skeleton label={label} hideLabel={hideLabel} className="flex flex-col gap-1.5">
      {Array.from({ length: Math.max(0, count) }, (_, i) => (
        <SkeletonRow key={i} />
      ))}
    </Skeleton>
  );
}
