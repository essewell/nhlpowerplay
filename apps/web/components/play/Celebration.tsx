"use client";

/**
 * Power-play goal celebration. The scoreboard stays on screen with the new score; the Continue button
 * takes focus so Enter / Space moves on. The glow pulses only when the user has not asked for reduced motion.
 * UI thread only.
 */
import { Button } from "../ui/Button.tsx";
import type { RunSnapshot } from "../../lib/contracts.ts";
import { periodOrdinal, t } from "../../lib/copy.ts";
import { formatClock, scoreboardModel } from "../../lib/play/scoreboard.ts";
import { Scoreboard } from "./Scoreboard.tsx";

export function Celebration({ snapshot, onContinue }: { snapshot: RunSnapshot; onContinue: () => void }) {
  const board = scoreboardModel(snapshot);
  const { clock } = snapshot.state;

  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col gap-4 px-4 pb-6 pt-3.5">
      {board.ok ? <Scoreboard teams={snapshot.scenario.teams} model={board.value} /> : null}
      <section
        role="status"
        className="relative flex flex-1 flex-col items-center justify-center gap-3 overflow-hidden rounded-card border border-border bg-surface px-5 py-10 text-center"
      >
        <div
          aria-hidden="true"
          className="absolute size-64 rounded-full bg-accent-sunk motion-safe:animate-pulse"
        />
        <h1 className="relative m-0 font-display text-[72px] font-bold uppercase leading-none tracking-[0.06em] text-accent">
          {t("celebrate.title")}
        </h1>
        <p className="relative m-0 text-[15px] text-text-soft">
          {t("celebrate.sub", { clock: formatClock(clock.elapsedS), periodOrdinal: periodOrdinal(clock.period) })}
        </p>
      </section>
      <Button autoFocus onClick={onContinue}>
        {t("celebrate.continue")}
      </Button>
    </div>
  );
}
