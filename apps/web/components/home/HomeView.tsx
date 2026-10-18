"use client";

import Link from "next/link";
import { useState } from "react";
import { t } from "../../lib/copy.ts";
import { splitWordmark, streakLine, untilNextDaily } from "../../lib/home-logic.ts";
import { playHref } from "../../lib/results-logic.ts";
import { browserStore } from "../../lib/run/browser.ts";
import { readDailyHistory } from "../../lib/run/persistence.ts";
import { dailyStatus } from "../../lib/run/plan.ts";
import type { SeasonRange } from "../../lib/site.ts";
import { Card } from "../ui/Card.tsx";
import { FOCUS_RING } from "../ui/cx.ts";
import { ModeTile } from "../ui/ModeTile.tsx";
import { Skeleton, SkeletonBlock } from "../ui/Skeleton.tsx";
import { StateCard } from "../ui/StateCard.tsx";
import { DailyCard } from "./DailyCard.tsx";
import { MenuSheet } from "./MenuSheet.tsx";
import { useDaily } from "./use-daily.ts";

function DailySkeleton() {
  return (
    <Card radius="home" padded={false} className="overflow-hidden">
      <Skeleton>
        <div className="box-border flex h-12 items-center justify-between border-b border-border bg-surface-sunk px-[18px]">
          <SkeletonBlock width={150} height={12} />
          <SkeletonBlock width={110} height={12} />
        </div>
        <div className="flex flex-col gap-4 p-[18px]">
          <div className="text-sm text-text-muted">{t("home.loading")}</div>
          <div className="flex h-[66px] items-center justify-between">
            <div className="flex w-[90px] justify-center">
              <SkeletonBlock width={62} height={34} radius={8} />
            </div>
            <SkeletonBlock width={112} height={48} radius={10} />
            <div className="flex w-[90px] justify-center">
              <SkeletonBlock width={62} height={34} radius={8} />
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} aria-hidden="true" className="h-16 rounded-sm bg-bg" />
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <SkeletonBlock height={12} className="w-full" />
            <SkeletonBlock height={12} className="w-[70%]" />
          </div>
          <SkeletonBlock height={56} radius={14} className="w-full" />
        </div>
      </Skeleton>
    </Card>
  );
}

/**
 * Home (COPY.md 4.1, v2 canvas). Client component: the Daily comes from getDaily and the played / resume
 * state from localStorage. The tiles stay tappable in every Daily state.
 */
export function HomeView({ seasonRange }: { seasonRange?: SeasonRange }) {
  const [daily, retry] = useDaily();
  // Lazy initialiser: read once on the client, never during render of the server HTML (the Daily card is
  // only drawn after the client load, so there is no hydration mismatch to guard).
  const [now] = useState(() => new Date());
  const [wordA, wordB] = splitWordmark(t("home.wordmark"));
  const store = browserStore();
  const status = daily.status === "ready" ? dailyStatus(store, daily.value.date) : null;
  const history = readDailyHistory(store);
  const streak =
    daily.status === "ready"
      ? streakLine(history.ok ? history.value : [], daily.value.date, status === "done")
      : null;
  const endlessBody =
    seasonRange === undefined
      ? t("home.tile.endless.body.noRange")
      : t("home.tile.endless.body", { firstYear: seasonRange.firstYear, lastYear: seasonRange.lastYear });

  return (
    <main className="mx-auto flex w-full max-w-[390px] flex-1 flex-col gap-5 px-5 pb-6 pt-7">
      <div className="flex items-center justify-between">
        <h1 className="m-0 font-display text-[30px] font-bold uppercase tracking-[0.04em]">
          {wordA}
          <span className="text-accent">{wordB}</span>
        </h1>
        <MenuSheet />
      </div>

      <p className="m-0 text-[15px] leading-[1.45] text-text-muted">{t("home.tagline")}</p>

      {daily.status === "loading" ? <DailySkeleton /> : null}
      {daily.status === "empty" ? (
        <StateCard
          kind="empty"
          size="screen"
          title={t("home.empty.noDaily.title")}
          body={t("home.empty.noDaily.body")}
          action={{ label: t("home.empty.noDaily.cta"), href: playHref("endless") }}
        />
      ) : null}
      {daily.status === "error" ? (
        <StateCard
          kind="error"
          size="screen"
          title={t("home.error.title")}
          body={t("home.error.body")}
          action={{ label: t("home.error.cta"), onClick: retry }}
        />
      ) : null}
      {daily.status === "ready" ? (
        <DailyCard
          daily={daily.value}
          status={status ?? "fresh"}
          next={untilNextDaily(now)}
        />
      ) : null}

      <div className="grid grid-cols-2 gap-3">
        <ModeTile href={playHref("daily")} title={t("home.tile.daily.title")} body={t("home.tile.daily.body")} />
        <ModeTile href={playHref("endless")} title={t("home.tile.endless.title")} body={endlessBody} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-3 text-sm">
        <Link
          href="/how-it-works"
          className={`flex min-h-touch items-center text-pp underline-offset-2 hover:text-white ${FOCUS_RING}`}
        >
          {t("home.howItWorks.link")}
        </Link>
        {daily.status === "ready" ? <div className="text-text-muted">{streak}</div> : null}
      </div>
    </main>
  );
}
