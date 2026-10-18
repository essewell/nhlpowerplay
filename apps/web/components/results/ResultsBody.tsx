"use client";

import Link from "next/link";
import { useState } from "react";
import type { Mode, RunSnapshot } from "../../lib/contracts.ts";
import { t } from "../../lib/copy.ts";
import {
  eyebrowText, matchKey, matchText, playHref, realBenchView, selectBanner, shareText, summarizeRun,
  type BannerTone, type MatchKey,
} from "../../lib/results-logic.ts";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { cx, FOCUS_RING } from "../ui/cx.ts";
import { GradeSection } from "./GradeSection.tsx";
import { useDailyNumber, useGrade } from "./hooks.ts";

const BANNER_SHELL: Record<BannerTone, string> = {
  scored: "border-accent bg-accent text-on-accent",
  held: "border-border bg-surface text-text",
  shorthanded: "border-border bg-surface text-text",
};
const BANNER_EYEBROW: Record<BannerTone, string> = {
  scored: "",
  held: "text-text-muted",
  shorthanded: "text-text-muted",
};
const BANNER_SUB: Record<BannerTone, string> = {
  scored: "",
  held: "text-text-soft",
  shorthanded: "text-text-soft",
};
const MATCH_TONE: Record<MatchKey, string> = {
  same: "text-pp",
  better: "text-accent",
  worse: "text-text",
  bothMissed: "text-text-muted",
};

function ShareButton({ enabledText }: { enabledText: (url: string) => string | null }) {
  const [copied, setCopied] = useState(false);
  const share = (): void => {
    const text = enabledText(window.location.origin);
    if (text === null) return;
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      (e: unknown) => console.warn(`PowerPlay: could not copy the result: ${e instanceof Error ? e.message : String(e)}`),
    );
  };
  return (
    <Button onClick={share} disabled={enabledText("") === null}>
      <span aria-live="polite">{copied ? t("results.share.copied") : t("results.cta.share")}</span>
    </Button>
  );
}

/**
 * The finished-run Results screen (COPY.md 4.4, v2 canvas): banner, real bench, calls and grades, tiles,
 * actions. Reads only the run snapshot, the scenario view and the GradeReport.
 */
export function ResultsBody({ mode, run }: { mode: Mode; run: RunSnapshot }) {
  const summary = summarizeRun(run);
  const banner = selectBanner(summary);
  const scored = summary.ppGoals > 0;
  const bench = realBenchView(run.scenario);
  const match = matchKey(scored, run.scenario.realOutcome);
  const dailyNumber = useDailyNumber(mode, run.date);
  const [report, retry] = useGrade(run);

  const shareFor = (url: string): string | null => {
    if (report.status !== "ready" || report.grades === null) return null;
    const text = shareText({ n: dailyNumber, teams: run.scenario.teams, scored, grades: report.grades, url });
    return text.ok ? text.value : null;
  };

  return (
    <main className="mx-auto flex w-full max-w-[390px] flex-1 flex-col gap-4 px-4 pb-5 pt-6">
      <section className={cx("flex flex-col gap-1 rounded-banner border px-5 py-[21px]", BANNER_SHELL[banner.tone])}>
        <div className={cx("text-[13px] font-semibold uppercase tracking-[0.08em]", BANNER_EYEBROW[banner.tone])}>
          {eyebrowText(mode, dailyNumber, run.scenario.teams)}
        </div>
        <h1 className="m-0 font-display text-[64px] font-bold uppercase leading-[0.95]">{banner.title}</h1>
        <p className={cx("m-0 text-[15px] font-medium", BANNER_SUB[banner.tone])}>{banner.sub}</p>
      </section>

      {bench !== null ? (
        <Card padded={false} className="flex items-center justify-between gap-3 px-4 py-3.5">
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="text-xs text-text-muted">{t("results.realBench.label")}</div>
            <div className="text-[15px] font-semibold">{bench.line}</div>
            {bench.chain !== null ? <div className="text-xs text-text-muted">{bench.chain}</div> : null}
          </div>
          {match !== null ? (
            <div className={cx("text-right font-display text-xl font-bold uppercase", MATCH_TONE[match])}>
              {matchText(match)}
            </div>
          ) : null}
        </Card>
      ) : null}

      <GradeSection report={report} callCount={run.calls.length} onRetry={retry} />

      {/* "Review my calls" is hidden until Step 5 builds the review screen. */}
      <div className="mt-auto flex flex-col gap-2.5">
        <ShareButton enabledText={shareFor} />
        <Button href={playHref("endless")} variant="secondary">
          {t("results.cta.endless")}
        </Button>
        <Link
          href="/"
          className={`flex min-h-touch items-center justify-center text-sm text-pp underline-offset-2 hover:text-white ${FOCUS_RING}`}
        >
          {t("a11y.backToHome")}
        </Link>
      </div>
    </main>
  );
}
