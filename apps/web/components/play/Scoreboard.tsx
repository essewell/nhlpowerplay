import type { ScenarioView } from "../../lib/contracts.ts";
import { periodOrdinal, t } from "../../lib/copy.ts";
import type { ScoreboardModel } from "../../lib/play/scoreboard.ts";

/**
 * Night-game scoreboard: PP team on the left (pp bar), kill on the right (pk-team bar), period and
 * clock left in the middle, "PP m:ss · 5-on-4" in accent. Presentational; all numbers come from
 * scoreboardModel (engine clock). The text stays readable without colour: the bars are decoration.
 */
export function Scoreboard({ teams, model }: { teams: ScenarioView["teams"]; model: ScoreboardModel }) {
  const periodLine = t("pause.scoreboard.period", {
    periodOrdinal: periodOrdinal(model.periodNumber),
    clock: model.periodClock,
  });
  const ppLine =
    model.ppClock === null
      ? null
      : t("pause.scoreboard.pp", { clock: model.ppClock, pp: model.strength.pp, pk: model.strength.pk });

  return (
    <div className="flex items-center justify-between rounded-lg border border-border bg-surface px-3.5 py-2">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="h-7 w-1 rounded-[2px] bg-pp" />
        <span className="font-display text-2xl font-bold">{teams.pp}</span>
        <span className="ml-1.5 font-display text-[30px] font-bold leading-none">{model.score.pp}</span>
      </div>
      <div className="flex flex-col items-center text-center">
        <span className="text-xs uppercase tracking-[0.08em] text-text-muted">{periodLine}</span>
        {ppLine ? <span className="text-[13px] font-semibold text-accent">{ppLine}</span> : null}
      </div>
      <div className="flex items-center gap-2">
        <span className="mr-1.5 font-display text-[30px] font-bold leading-none">{model.score.pk}</span>
        <span className="font-display text-2xl font-bold">{teams.pk}</span>
        <span aria-hidden="true" className="h-7 w-1 rounded-[2px] bg-pk-team" />
      </div>
    </div>
  );
}
