import Image from "next/image";
import type { ReactNode } from "react";
import { pct } from "@powerplay/engine/likelihood.ts";
import { cx, FOCUS_RING } from "./cx.ts";
import { meterPercent } from "./logic.ts";

type Lead =
  | { badge: string | number; thumbnail?: undefined }
  | { thumbnail: string; badge?: undefined };

type Props = Lead & {
  name: string;
  sub?: string;
  /** Probability 0..1 from the engine. Rendered with the engine pct() formatter, never a hand-typed number. */
  value: number;
  /** Word after the percentage, e.g. "connects", "keeps puck", "goal" (from lib/copy.ts). */
  valueLabel: string;
  /** Static tag beside the name, e.g. <EstimateTag />. Must not be interactive: it sits inside the row button. */
  tag?: ReactNode;
  selected?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  className?: string;
};

/**
 * One option in the decision sheet. Badge row: 52 high, 34 px numbered circle. Thumbnail row: 60 high,
 * 52 x 47 image (set plays). Right side: "NN% label" over a 72 x 5 meter (fill accent, track border).
 * The row is a button when `onSelect` is set.
 */
export function OptionRow({
  badge,
  thumbnail,
  name,
  sub,
  value,
  valueLabel,
  tag,
  selected,
  disabled,
  onSelect,
  className,
}: Props) {
  const isThumb = thumbnail !== undefined;
  const fill = meterPercent(value);

  const body = (
    <>
      {isThumb ? (
        <Image
          src={thumbnail}
          alt=""
          width={52}
          height={47}
          unoptimized
          className="block h-[47px] w-[52px] shrink-0 rounded-thumb"
        />
      ) : (
        <span className="flex size-[34px] shrink-0 items-center justify-center rounded-full border-2 border-pp bg-pp-fill font-display text-[15px] font-bold">
          {badge}
        </span>
      )}
      <span className="flex min-w-0 grow flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="text-[15px] font-semibold">{name}</span>
          {tag}
        </span>
        {sub ? <span className="text-xs leading-[1.35] text-text-muted">{sub}</span> : null}
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-sm font-semibold">
          {pct(value)} <span className="font-normal text-text-muted">{valueLabel}</span>
        </span>
        <span aria-hidden="true" className="block h-[5px] w-[72px] overflow-hidden rounded-[3px] bg-border">
          <span className="block h-full rounded-[3px] bg-accent" style={{ width: `${fill}%` }} />
        </span>
      </span>
    </>
  );

  const frame = cx(
    "flex w-full items-center gap-3 rounded-md border bg-surface-sunk text-left text-text",
    isThumb ? "min-h-[60px] py-1.5 pl-1.5 pr-3" : "min-h-[52px] px-3 py-2",
    selected ? "border-accent bg-accent-sunk" : "border-border",
  );

  const row = onSelect ? (
    <button
      type="button"
      onClick={onSelect}
      disabled={disabled}
      aria-pressed={selected}
      className={cx(frame, "disabled:cursor-not-allowed disabled:opacity-60", FOCUS_RING)}
    >
      {body}
    </button>
  ) : (
    <div className={frame}>{body}</div>
  );

  return <div className={className}>{row}</div>;
}
