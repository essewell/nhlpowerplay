"use client";

/**
 * Scenario header before the first call: who is on the power play, the score, the clock, and the
 * start button. Everything shown comes from the scenario export / engine clock; stakes only when the
 * export has a curated line. UI thread only.
 */
import { Button } from "../ui/Button.tsx";
import { BackButton } from "../ui/BackButton.tsx";
import { Chip } from "../ui/Chip.tsx";
import type { Mode, RunSnapshot } from "../../lib/contracts.ts";
import { t } from "../../lib/copy.ts";
import { scoreboardModel } from "../../lib/play/scoreboard.ts";
import { Scoreboard } from "./Scoreboard.tsx";

export function Intro({ snapshot, mode, onStart }: { snapshot: RunSnapshot; mode: Mode; onStart: () => void }) {
  const { scenario } = snapshot;
  const board = scoreboardModel(snapshot);
  const stage =
    scenario.stageText === null
      ? null
      : scenario.gameNumber === null
        ? scenario.stageText
        : t("home.daily.stage", { stageName: scenario.stageText, gameNumber: scenario.gameNumber });

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col gap-4 px-4 pb-6 pt-[18px]">
      <header className="flex items-center gap-3">
        <BackButton href="/" label={t("a11y.backToHome")} />
        <h1 className="m-0 font-display text-2xl font-bold uppercase tracking-[0.04em]">
          {mode === "daily" ? t("nav.daily") : t("nav.endless")}
        </h1>
      </header>

      <section className="flex flex-col gap-3.5 rounded-card border border-border bg-surface px-[18px] pb-[18px] pt-[22px]">
        {stage ? (
          <div className="flex">
            <Chip>{stage}</Chip>
          </div>
        ) : null}
        {board.ok ? <Scoreboard teams={scenario.teams} model={board.value} /> : null}
        <dl className="m-0 grid grid-cols-2 gap-3 text-sm">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs uppercase tracking-[0.08em] text-text-muted">{t("home.daily.yourBench")}</dt>
            <dd className="m-0 font-display text-2xl font-bold">{scenario.teams.pp}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs uppercase tracking-[0.08em] text-text-muted">{t("home.daily.killing")}</dt>
            <dd className="m-0 font-display text-2xl font-bold">{scenario.teams.pk}</dd>
          </div>
        </dl>
        {scenario.stakes ? <p className="m-0 text-sm leading-[1.45] text-text-soft">{scenario.stakes}</p> : null}
      </section>

      <div className="mt-auto">
        <Button onClick={onStart}>{t("home.daily.cta")}</Button>
      </div>
    </div>
  );
}
