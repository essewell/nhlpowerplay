"use client";

/**
 * Shot picker (docs/DESIGN.md screen 3): shot type (6) x target (5), summary Goal / On net / Blocked,
 * and the SHOOT button. Every percentage is copied from a priced engine option; nothing is computed here.
 * The goalie's catching hand is not in the export, so corner labels use the "unknown hand" wording.
 * Local state: the chosen type and corner. UI thread only.
 */
import { useState } from "react";
import { pct } from "@powerplay/engine/likelihood.ts";
import type { Corner } from "@powerplay/engine/likelihood.ts";
import type { Call } from "@powerplay/engine/sim-types.ts";
import { Button } from "../ui/Button.tsx";
import { BackButton } from "../ui/BackButton.tsx";
import { cx, FOCUS_RING } from "../ui/cx.ts";
import { EstimateTag, InfoTip } from "../ui/Tooltip.tsx";
import { pctValue, t } from "../../lib/copy.ts";
import {
  CORNER_COPY, ESTIMATE_SHOT_TYPES, optionDisabled, SHOT_CORNERS, SHOT_TYPE_COPY, SHOT_TYPES, shotSummary,
  shotTargetOption, shotTypeOption, type OptionOf, type ShotType,
} from "../../lib/play/options.ts";

interface Props {
  shoot: readonly OptionOf<"shoot">[];
  lastName: string;
  spotLabel: string;
  busy: boolean;
  onBack: () => void;
  onShoot: (call: Call) => void;
}

/** Target boxes as [left, top, width, height] in the 358 x 236 design frame; rendered as percentages. */
const NET_FRAME = { w: 358, h: 236 } as const;
const TARGET_BOX: Record<Corner, readonly [number, number, number, number]> = {
  top_left: [44, 32, 120, 72],
  top_right: [194, 32, 120, 72],
  bottom_left: [44, 128, 92, 72],
  five_hole: [143, 140, 72, 60],
  bottom_right: [222, 128, 92, 72],
};
const GOAL_FRAME = { left: 29, top: 18, width: 300, height: 200 } as const;
const GOAL_LINE = { left: 29, top: 216, width: 300, height: 3 } as const;

const pctOf = (v: number, total: number): string => `${(v / total) * 100}%`;

function SectionLabel({ children, aside }: { children: string; aside?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">{children}</h2>
      {aside ? <span className="text-xs text-text-muted">{aside}</span> : null}
    </div>
  );
}

export function ShotPicker({ shoot, lastName, spotLabel, busy, onBack, onShoot }: Props) {
  const [type, setType] = useState<ShotType | null>(null);
  const [corner, setCorner] = useState<Corner | null>(null);

  const chosen = type !== null && corner !== null ? shotTypeOption(shoot, type, corner) : null;
  const summary = shotSummary(chosen);
  const canShoot = chosen !== null && !optionDisabled(chosen, busy);

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col gap-4 px-4 pb-5 pt-[18px]">
      <header className="flex items-center gap-3">
        <BackButton onClick={onBack} label={t("action.back")} />
        <div className="flex flex-col">
          <h1 className="m-0 font-display text-2xl font-bold uppercase tracking-[0.04em]">
            {t("shot.title", { lastName })}
          </h1>
          <span className="text-[13px] text-text-muted">{spotLabel}</span>
        </div>
      </header>

      <section aria-labelledby="shot-type-h" className="flex flex-col gap-2">
        <div id="shot-type-h">
          <SectionLabel>{t("shot.section.type")}</SectionLabel>
        </div>
        <div role="group" aria-label={t("shot.section.type")} className="grid grid-cols-3 gap-2">
          {SHOT_TYPES.map((st) => {
            const o = shotTypeOption(shoot, st, corner);
            const on = type === st;
            return (
              <button
                key={st}
                type="button"
                aria-pressed={on}
                disabled={o === null || busy}
                onClick={() => setType(st)}
                className={cx(
                  "relative box-border flex h-14 flex-col items-center justify-center rounded-md text-text",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  on ? "border-[3px] border-accent bg-accent-sunk" : "border border-border bg-surface",
                  FOCUS_RING,
                )}
              >
                <span className="font-display text-lg font-bold uppercase">{t(SHOT_TYPE_COPY[st])}</span>
                <span className="text-xs text-text-muted">
                  {o === null ? "–" : t("shot.type.pct", { pct: pctValue(o.p) })}
                </span>
                {ESTIMATE_SHOT_TYPES.includes(st) ? (
                  <EstimateTag className="absolute -top-[9px] right-1.5 bg-bg" />
                ) : null}
              </button>
            );
          })}
        </div>
      </section>

      <section aria-labelledby="shot-target-h" className="flex flex-col gap-2">
        <div id="shot-target-h">
          <SectionLabel aside={t("shot.goalieHand.unknown")}>{t("shot.section.target")}</SectionLabel>
        </div>
        <div
          role="group"
          aria-label={t("shot.section.target")}
          className="relative mx-auto w-full max-w-[358px] rounded-xl border border-border bg-surface"
          style={{ aspectRatio: `${NET_FRAME.w} / ${NET_FRAME.h}` }}
        >
          <div
            aria-hidden="true"
            className="absolute box-border rounded-t-[8px] border-[6px] border-b-0 border-rink-red"
            style={{
              left: pctOf(GOAL_FRAME.left, NET_FRAME.w),
              top: pctOf(GOAL_FRAME.top, NET_FRAME.h),
              width: pctOf(GOAL_FRAME.width, NET_FRAME.w),
              height: pctOf(GOAL_FRAME.height, NET_FRAME.h),
              background: "repeating-linear-gradient(90deg, #1A2438 0 10px, transparent 10px 20px)",
            }}
          />
          <div
            aria-hidden="true"
            className="absolute bg-rink-red"
            style={{
              left: pctOf(GOAL_LINE.left, NET_FRAME.w),
              top: pctOf(GOAL_LINE.top, NET_FRAME.h),
              width: pctOf(GOAL_LINE.width, NET_FRAME.w),
              height: pctOf(GOAL_LINE.height, NET_FRAME.h),
            }}
          />
          {SHOT_CORNERS.map((c) => {
            const [l, tp, w, h] = TARGET_BOX[c];
            const o = shotTargetOption(shoot, type, c);
            const on = corner === c;
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                disabled={o === null || busy}
                onClick={() => setCorner(c)}
                className={cx(
                  "absolute box-border flex flex-col items-center justify-center gap-0.5 rounded-md",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  on
                    ? "border-[3px] border-accent bg-accent-sunk text-white"
                    : "border border-border-strong bg-surface-sunk text-text",
                  FOCUS_RING,
                )}
                style={{
                  left: pctOf(l, NET_FRAME.w),
                  top: pctOf(tp, NET_FRAME.h),
                  width: pctOf(w, NET_FRAME.w),
                  height: pctOf(h, NET_FRAME.h),
                }}
              >
                <span className={cx("text-xs", on ? "text-on-accent-sunk" : "text-text-muted")}>
                  {t(CORNER_COPY[c])}
                </span>
                <span className={cx("font-display font-bold", c === "five_hole" ? "text-xl" : "text-[22px]")}>
                  {o === null ? "–" : pct(o.p)}
                </span>
              </button>
            );
          })}
        </div>
        <p className="m-0 text-xs leading-[1.4] text-text-muted">{t("shot.footnote.estimate")}</p>
      </section>

      <section
        aria-live="polite"
        className="relative flex flex-col gap-2.5 rounded-xl border border-border bg-surface px-4 py-3.5"
      >
        {type !== null && corner !== null ? (
          <div className="flex min-h-[22px] items-center gap-2">
            <span className="text-[15px] font-semibold">
              {t("shot.summary.selected", { shotType: t(SHOT_TYPE_COPY[type]), targetLabel: t(CORNER_COPY[corner]).toLowerCase() })}
            </span>
            {ESTIMATE_SHOT_TYPES.includes(type) ? (
              <span className="flex items-center">
                <EstimateTag />
                <InfoTip label={t("a11y.estimateInfo")} text={t("tag.oneTimer.info")} className="ml-1.5" />
              </span>
            ) : null}
          </div>
        ) : (
          <span className="text-[15px] font-semibold text-text-muted">{t("shot.cta.disabled")}</span>
        )}
        <dl className="m-0 grid grid-cols-3 gap-2">
          {(
            [
              ["shot.summary.goal", summary?.goal, true],
              ["shot.summary.onNet", summary?.onNet, false],
              ["shot.summary.blocked", summary?.blocked, false],
            ] as const
          ).map(([key, value, accent]) => (
            <div key={key} className="flex flex-col-reverse gap-0.5">
              <dt className="text-xs text-text-muted">{t(key)}</dt>
              <dd className={cx("m-0 font-display text-[26px] font-bold", accent && summary !== null ? "text-accent" : summary === null && "text-text-muted")}>
                {value === undefined ? "–" : pct(value)}
              </dd>
            </div>
          ))}
        </dl>
        <p className="m-0 text-xs leading-[1.4] text-text-muted">{t("shot.footnote.noRange", { lastName })}</p>
      </section>

      <div className="mt-auto">
        {canShoot ? (
          <Button
            onClick={() => {
              if (chosen !== null) onShoot(chosen.call);
            }}
          >
            {t("shot.cta")}
          </Button>
        ) : (
          <Button disabled>{t("shot.cta.disabled")}</Button>
        )}
      </div>
    </div>
  );
}
