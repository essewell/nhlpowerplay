import type { DailyInfo } from "../../lib/contracts.ts";
import { periodOrdinal, t } from "../../lib/copy.ts";
import { clockLeftText, stageLine, strengthText, type DailyStatus } from "../../lib/home-logic.ts";
import { playHref, resultsHref } from "../../lib/results-logic.ts";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { StatTile } from "../ui/StatTile.tsx";

const TEAM_CODE = "font-display text-[34px] font-bold leading-none";

/**
 * Today's Daily card (v2 Home). Pure view: the Daily, whether it is fresh / resumable / played, and the
 * time until the next one (used by the played message).
 */
export function DailyCard({ daily, status, next }: { daily: DailyInfo; status: DailyStatus; next: { h: number; m: number } }) {
  const sc = daily.scenario;
  const stage = stageLine(sc.stageText, sc.gameNumber);
  const clock = clockLeftText(sc.period, sc.clockElapsedS, sc.gameType);
  return (
    <Card radius="home" padded={false} className="flex flex-col overflow-hidden">
      <div className="flex items-center justify-between gap-3 border-b border-border bg-surface-sunk px-[18px] py-3.5">
        <h2 className="m-0 text-[13px] font-semibold uppercase tracking-[0.08em] text-accent">
          {t("home.daily.eyebrow", { n: daily.number })}
        </h2>
        <div className="text-[13px] text-text-muted">{t("home.daily.badge")}</div>
      </div>
      <div className="flex flex-col gap-4 p-[18px]">
        {stage !== null ? <div className="text-sm text-text-muted">{stage}</div> : null}
        <div className="flex items-center justify-between">
          <div className="flex w-[90px] flex-col items-center gap-1">
            <div className={TEAM_CODE}>{sc.teams.pp}</div>
            <div className="whitespace-nowrap rounded-chip bg-pp px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.04em] text-bg">
              {t("home.daily.yourBench")}
            </div>
          </div>
          <div className="font-display text-[56px] font-bold leading-none tracking-[0.02em]">
            {t("home.daily.score", { pp: sc.score.pp, pk: sc.score.pk })}
          </div>
          <div className="flex w-[90px] flex-col items-center gap-1">
            <div className={TEAM_CODE}>{sc.teams.pk}</div>
            <div className="px-2 py-0.5 text-xs text-text-muted">{t("home.daily.killing")}</div>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <StatTile label={t("home.daily.label.period")} value={periodOrdinal(sc.period)} />
          <StatTile label={t("home.daily.label.clock")} value={clock ?? t("common.dash")} />
          <StatTile label={t("home.daily.label.strength")} value={strengthText(sc.strength)} />
        </div>
        {status === "done" ? (
          <>
            <p className="m-0 text-sm leading-[1.45] text-text-soft">{t("home.daily.played", next)}</p>
            <Button href={resultsHref("daily")}>{t("home.daily.played.cta")}</Button>
          </>
        ) : (
          <>
            {sc.stakes !== null ? (
              <p className="m-0 text-sm leading-[1.45] text-text-soft">
                {sc.stakes} {t("home.daily.challenge")}
              </p>
            ) : null}
            <Button href={playHref("daily")}>
              {status === "resume" ? t("home.daily.cta.resume") : t("home.daily.cta")}
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}
