"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { ReactNode } from "react";
import type { Mode } from "../../lib/contracts.ts";
import { t } from "../../lib/copy.ts";
import { parseMode, playHref } from "../../lib/results-logic.ts";
import { useRun } from "../../lib/run/use-run.ts";
import { Skeleton, SkeletonBlock } from "../ui/Skeleton.tsx";
import { StateCard } from "../ui/StateCard.tsx";
import { FOCUS_RING } from "../ui/cx.ts";
import { useStoredRun } from "./hooks.ts";
import { ResultsBody } from "./ResultsBody.tsx";

function Shell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex w-full max-w-[390px] flex-1 flex-col gap-4 px-4 pb-5 pt-6">
      {children}
      <Link
        href="/"
        className={`mt-auto flex min-h-touch items-center justify-center text-sm text-pp underline-offset-2 hover:text-white ${FOCUS_RING}`}
      >
        {t("a11y.backToHome")}
      </Link>
    </main>
  );
}

function ResultsSkeleton() {
  return (
    <main className="mx-auto flex w-full max-w-[390px] flex-1 flex-col gap-4 px-4 pb-5 pt-6">
      <Skeleton label={t("results.loading.run")} hideLabel className="flex flex-col gap-4">
        <SkeletonBlock height={150} radius={20} className="w-full" />
        <SkeletonBlock height={72} radius={16} className="w-full" />
        <SkeletonBlock height={120} radius={12} className="w-full" />
      </Skeleton>
    </main>
  );
}

function NoRun({ mode, inProgress }: { mode: Mode; inProgress: boolean }) {
  return (
    <Shell>
      <StateCard
        kind="empty"
        size="screen"
        title={t("results.noRun.title")}
        body={inProgress ? t("results.inProgress.body") : t("results.noRun.body")}
        action={{ label: inProgress ? t("home.daily.cta.resume") : t("results.noRun.cta"), href: playHref(mode) }}
      />
    </Shell>
  );
}

/** Mounted only when a finished run is saved, so useRun never plans (and never saves) a fresh run here. */
function EndedRun({ mode, date }: { mode: Mode; date: string | null }) {
  const [state] = useRun(mode, null, date === null ? {} : { date });
  if (state.status === "loading") return <ResultsSkeleton />;
  if (state.status === "error") {
    return (
      <Shell>
        <StateCard
          kind="error"
          size="screen"
          title={t("genericError.title")}
          body={t("genericError.body")}
          action={{ label: t("genericError.cta"), onClick: () => window.location.reload() }}
        />
      </Shell>
    );
  }
  if (state.status === "empty") return <NoRun mode={mode} inProgress={false} />;
  // The save replayed to a run that is not over (for example the data changed): send the player back to it.
  if (state.value.phase.kind !== "ended") return <NoRun mode={mode} inProgress />;
  return <ResultsBody mode={mode} run={state.value} />;
}

/** Results route body. `?mode=daily|endless`; anything else reads as the Daily. */
export function ResultsView() {
  const mode = parseMode(useSearchParams().get("mode")) ?? "daily";
  const stored = useStoredRun(mode);
  if (!stored.ready) return <ResultsSkeleton />;
  if (stored.access === "ended") return <EndedRun key={mode} mode={mode} date={stored.date} />;
  return <NoRun mode={mode} inProgress={stored.access === "in_progress"} />;
}
