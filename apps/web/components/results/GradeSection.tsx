"use client";

import Image from "next/image";
import type { ReactNode } from "react";
import type { GradeReport } from "../../lib/contracts.ts";
import { t } from "../../lib/copy.ts";
import { gradesInOrder, percentileText } from "../../lib/results-logic.ts";
import { Card } from "../ui/Card.tsx";
import { GradeChip, type Grade } from "../ui/GradeChip.tsx";
import { SkeletonBlock } from "../ui/Skeleton.tsx";
import { StateCard } from "../ui/StateCard.tsx";
import { InfoTip } from "../ui/Tooltip.tsx";

const GRADES: readonly Grade[] = ["best", "close", "costly", "miss"];
const TILE_VALUE = "font-display text-4xl font-bold leading-[1.1]";

function SectionLabel({ children, busy }: { children: ReactNode; busy?: string }) {
  return (
    <div className="flex items-baseline justify-between">
      <h2 className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">{children}</h2>
      {busy ? (
        <div aria-live="polite" className="text-xs text-text-muted">
          {busy}
        </div>
      ) : null}
    </div>
  );
}

function LegendItem({ grade, children }: { grade: Grade; children: ReactNode }) {
  return (
    <div className="flex h-[18px] items-center gap-1.5">
      <Image src={`/grades/grade-${grade}.svg`} alt="" width={16} height={16} unoptimized className="block shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** Four legend items. The "within N pts" phrase and its tooltip need the grader's threshold; without it the first item is just "Best". */
function Legend({ bestThresholdPts }: { bestThresholdPts: number | undefined }) {
  return (
    <div className="grid grid-cols-2 gap-1.5 text-xs text-text-soft">
      {GRADES.map((grade) =>
        grade === "best" && bestThresholdPts !== undefined ? (
          <LegendItem key={grade} grade={grade}>
            {t("results.legend.best", { bestThreshold: bestThresholdPts })}
            <InfoTip
              small
              align="left"
              label={t("a11y.legendInfo")}
              text={t("results.legend.info")}
              className="ml-1 align-middle"
            />
          </LegendItem>
        ) : (
          <LegendItem key={grade} grade={grade}>
            {t(`grade.${grade}`)}
          </LegendItem>
        ),
      )}
    </div>
  );
}

function Tile({ label, sub, children }: { label: string; sub: string; children: ReactNode }) {
  return (
    <Card padded={false} className="flex flex-col gap-1 p-3.5">
      <div className="text-xs text-text-muted">{label}</div>
      {children}
      <div className="text-xs text-text-muted">{sub}</div>
    </Card>
  );
}

function TileSkeleton({ width }: { width: number }) {
  return <SkeletonBlock width={width} height={28} radius={8} className="mb-[9px] mt-1.5" />;
}

function PendingValue() {
  return (
    <div className={TILE_VALUE}>
      <span aria-hidden="true">{t("common.dash")}</span>
      <span className="sr-only">{t("results.tile.pending")}</span>
    </div>
  );
}

type TileMode = "loading" | "ready" | "pending";

function Tiles({ report, mode }: { report: GradeReport; mode: TileMode }) {
  const pct = percentileText(report.percentile);
  const showPct = mode !== "ready" || pct !== null;
  const showLooks = mode !== "ready" || (report.looksLike !== null && report.looksLike.length > 0);
  const single = showPct !== showLooks;
  return (
    <div className="grid grid-cols-2 gap-2.5">
      {showPct ? (
        <div className={single ? "col-span-2" : undefined}>
          <Tile label={t("results.percentile.label")} sub={t("results.percentile.sub")}>
            {mode === "loading" ? <TileSkeleton width={56} /> : mode === "pending" || pct === null ? <PendingValue /> : (
              <div className={TILE_VALUE}>{t("results.percentile.value", { pct })}</div>
            )}
          </Tile>
        </div>
      ) : null}
      {showLooks ? (
        <div className={single ? "col-span-2" : undefined}>
          <Tile label={t("results.looksLike.label")} sub={t("results.looksLike.sub")}>
            {mode === "loading" ? <TileSkeleton width={72} /> : mode === "pending" || report.looksLike === null ? <PendingValue /> : (
              <div className={TILE_VALUE}>{t("results.looksLike.value", { teamName: report.looksLike })}</div>
            )}
          </Tile>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Calls strip, legend and the percentile / "looks like" tiles, from the GradeReport. Step 5 replaces the
 * grader; until then the stub reports "empty", which shows an honest "not available" line (or the
 * "no calls" line when the run really had none). Grades are never invented here.
 */
export function GradeSection({ report, callCount, onRetry }: { report: GradeReport; callCount: number; onRetry: () => void }) {
  if (report.status === "error") {
    return (
      <StateCard
        kind="error"
        title={t("results.error.title")}
        body={t("results.error.body")}
        action={{ label: t("results.error.cta"), onClick: onRetry }}
      />
    );
  }

  if (report.status === "loading") {
    const slots = Math.max(1, callCount);
    return (
      <>
        <div aria-busy="true" className="flex flex-col gap-2.5">
          <SectionLabel busy={t("results.loading")}>{t("results.calls.label")}</SectionLabel>
          <div className="flex flex-wrap gap-2">
            {Array.from({ length: slots }, (_, i) => (
              <SkeletonBlock key={i} width={48} height={48} radius={10} />
            ))}
          </div>
          <Legend bestThresholdPts={undefined} />
        </div>
        <Tiles report={report} mode="loading" />
      </>
    );
  }

  const readyGrades = report.status === "ready" ? (report.grades ?? []) : null;
  if (report.status === "empty" || (readyGrades !== null && readyGrades.length === 0)) {
    const noCalls = callCount === 0 || report.status === "ready";
    return (
      <>
        <div className="flex flex-col gap-2.5">
          <SectionLabel>{t("results.calls.label")}</SectionLabel>
          <div className="rounded-md border border-dashed border-border-strong bg-surface-sunk px-4 py-[18px] text-sm leading-[1.45] text-text-soft">
            {noCalls ? t("results.empty.noCalls") : t("results.grades.pending")}
          </div>
        </div>
        {noCalls ? null : <Tiles report={report} mode="pending" />}
      </>
    );
  }

  const grades = readyGrades === null ? [] : gradesInOrder(readyGrades);
  return (
    <>
      <div className="relative flex flex-col gap-2.5">
        <SectionLabel>{t("results.calls.label")}</SectionLabel>
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
          {grades.map((g) => (
            <li key={g.callIndex}>
              <GradeChip grade={g.grade} size={48} showWord={false} />
            </li>
          ))}
        </ul>
        <Legend bestThresholdPts={report.bestThresholdPts} />
        {report.approx ? <p className="m-0 text-xs text-text-muted">{t("results.grades.approx")}</p> : null}
      </div>
      <Tiles report={report} mode="ready" />
    </>
  );
}
