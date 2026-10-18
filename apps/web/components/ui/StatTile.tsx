import { cx } from "./cx.ts";

/** Label over value tile (Home: Period, Clock, Strength). Ground fill, r10, 10 px padding. */
export function StatTile({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-0.5 rounded-sm bg-bg p-2.5", className)}>
      <div className="text-xs text-text-muted">{label}</div>
      <div className="text-base font-semibold text-text">{value}</div>
    </div>
  );
}
