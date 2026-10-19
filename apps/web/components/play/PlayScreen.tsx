"use client";

/**
 * /play/<mode>: picks the screen from the run's machine state.
 *   loading -> skeleton ("Setting the lines…") | error -> retry | intro -> scenario + start
 *   faceoffCall / zoneEntryCall / breakoutCall / decision -> the call sheets | celebrating -> goal
 *   ended -> /results?mode=<mode>
 * All run logic lives in useRun / RunController (tested); this component only maps state to UI.
 * UI thread only.
 */
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Skeleton, SkeletonBlock, SkeletonRows } from "../ui/Skeleton.tsx";
import { StateCard } from "../ui/StateCard.tsx";
import type { Mode, RunSnapshot } from "../../lib/contracts.ts";
import { hasCopy, t } from "../../lib/copy.ts";
import { useRun } from "../../lib/run/use-run.ts";
import type { RunControlsEx } from "../../lib/run/controller.ts";
import { lastCallIndex, narrate, type Narration } from "../../lib/play/narrate.ts";
import { fillCopy } from "../../lib/play/strings.ts";
import { Celebration } from "./Celebration.tsx";
import { FaceoffSheet, MethodSheet } from "./CallSheet.tsx";
import { DecisionView } from "./DecisionView.tsx";
import { Intro } from "./Intro.tsx";
import { OutcomeTicker } from "./OutcomeTicker.tsx";

/** Marker for "this run was not picked up from a save". */
const NOT_RESUMED = -1;
/** How long a run that just ended keeps its last outcome on screen before Results opens. */
const ENDED_TICKER_MS = 1500;
/** Results (or anything later) can read the last outcome here: JSON of Narration + { callCount }. */
export const LAST_OUTCOME_KEY_PREFIX = "powerplay.lastOutcome.";
const FRAME = "mx-auto flex min-h-dvh w-full max-w-[430px] flex-col gap-4 px-4 pb-6 pt-[18px]";

function LoadingScreen() {
  return (
    <div className={FRAME}>
      <Skeleton label={t("pause.loading.scenario")} className="flex flex-col gap-3.5">
        <SkeletonBlock height={52} radius={14} className="w-full" />
        <SkeletonBlock height={290} radius={24} className="w-full" />
        <SkeletonRows count={4} />
      </Skeleton>
    </div>
  );
}

export function PlayScreen({ mode }: { mode: Mode }) {
  const router = useRouter();
  const [loadable, controls] = useRun(mode, null);
  // Picking up a saved run (the first snapshot is already past the intro) gets the "Picking up…" chip once.
  const [resumedAt, setResumedAt] = useState<number | null>(null);
  const first = loadable.status === "ready" ? loadable.value : null;
  if (resumedAt === null && first !== null) setResumedAt(first.machineState === "intro" ? NOT_RESUMED : first.calls.length);

  const ended = first?.machineState === "ended";
  // Endless arrived on an already-ended stored run (Results' "Play Endless"): start the next power play
  // instead of bouncing back to Results. Daily is one attempt per day, so it always goes to Results.
  const [arrivedEnded, setArrivedEnded] = useState<boolean | null>(null);
  if (arrivedEnded === null && first !== null) setArrivedEnded(ended);
  if (!ended && arrivedEnded === true) setArrivedEnded(false);
  const restarted = useRef(false);
  useEffect(() => {
    if (!ended) {
      restarted.current = false;
      return;
    }
    if (mode === "endless" && arrivedEnded === true) {
      if (!restarted.current) {
        restarted.current = true;
        controls.playAgain();
      }
      return;
    }
    // A run that just ended shows its last outcome for a moment; one that was already over redirects at once.
    const delay = arrivedEnded === false ? ENDED_TICKER_MS : 0;
    const timer = window.setTimeout(() => router.replace(`/results?mode=${mode}`), delay);
    return () => window.clearTimeout(timer);
  }, [ended, arrivedEnded, mode, router, controls]);

  if (loadable.status === "loading") return <LoadingScreen />;

  if (loadable.status === "error") {
    return (
      <div className={FRAME}>
        <StateCard
          kind="error"
          size="screen"
          title={t("pause.error.title")}
          body={t("pause.error.body")}
          action={{ label: t("pause.error.cta"), onClick: () => window.location.reload() }}
        />
      </div>
    );
  }

  if (loadable.status === "empty") {
    return (
      <div className={FRAME}>
        <StateCard
          kind="empty"
          size="screen"
          title={t("home.empty.noDaily.title")}
          body={t("home.empty.noDaily.body")}
          action={{ label: t("home.empty.noDaily.cta"), href: "/play/endless" }}
        />
      </div>
    );
  }

  return (
    <ReadyScreen
      snapshot={loadable.value}
      mode={mode}
      controls={controls}
      resumedAt={resumedAt}
      showEnded={arrivedEnded === false}
    />
  );
}

const PAUSE_STATES: readonly RunSnapshot["machineState"][] = ["faceoffCall", "zoneEntryCall", "breakoutCall", "decision"];

function spotLabel(spot: string): string {
  const key = `spot.${spot}`;
  return hasCopy(key) ? t(key) : spot.replaceAll("_", " ");
}

interface ReadyProps {
  snapshot: RunSnapshot;
  mode: Mode;
  controls: RunControlsEx;
  resumedAt: number | null;
  showEnded: boolean;
}

/**
 * The run is loaded: pick the screen and show what the last call did. The narration is derived from the engine log
 * (events since the latest "call"), so it survives a resumed run and needs no bookkeeping of its own.
 *  - Pause screens get it inline inside the sheet (stays until the next call; no layout shift after mount) plus an
 *    always-mounted sr-only live region that announces it.
 *  - Celebration / ended get the fixed card. After a PP goal the celebration shows it and the faceoff that follows
 *    does not repeat it. UI thread only.
 */
function ReadyScreen({ snapshot, mode, controls, resumedAt, showEnded }: ReadyProps) {
  const { state, scenario, machineState, busy } = snapshot;
  const callCount = snapshot.calls.length;
  const isPause = PAUSE_STATES.includes(machineState);
  const narration = useMemo<Narration | null>(() => {
    if (busy || callCount === 0) return null;
    if (!isPause && machineState !== "celebrating" && !(machineState === "ended" && showEnded)) return null;
    const from = lastCallIndex(state.log);
    if (from < 0) return null;
    const n = narrate(state.log, from, {
      players: scenario.players,
      teams: scenario.teams,
      spotName: spotLabel,
      carrierId: state.carrier.kind === "pp" ? state.carrier.id : null,
    });
    return isPause && n.tone === "goal" ? null : n;
  }, [busy, callCount, isPause, machineState, showEnded, state.log, state.carrier, scenario.players, scenario.teams]);

  const ended = machineState === "ended";
  useEffect(() => {
    if (!ended || narration === null) return;
    try {
      window.sessionStorage.setItem(`${LAST_OUTCOME_KEY_PREFIX}${mode}`, JSON.stringify({ ...narration, callCount }));
    } catch (e) {
      console.warn("PowerPlay: could not store the last outcome", e);
    }
  }, [ended, narration, mode, callCount]);

  const outcomeKey = `${callCount}:${machineState}`;
  const ticker = isPause ? <OutcomeTicker inline narration={narration} outcomeKey={outcomeKey} /> : null;
  const spoken = isPause && narration !== null ? narration.lines.map((l) => l.text).join(". ") : "";
  const callKey = callCount;

  const screen = (() => {
    switch (machineState) {
      case "intro":
        return <Intro snapshot={snapshot} mode={mode} onStart={controls.start} onFormation={controls.setFormation} />;
      case "faceoffCall":
        return <FaceoffSheet key={callKey} snapshot={snapshot} onCall={controls.call} ticker={ticker} />;
      case "zoneEntryCall":
        return <MethodSheet key={callKey} kind="entry" snapshot={snapshot} onCall={controls.call} ticker={ticker} />;
      case "breakoutCall":
        return <MethodSheet key={callKey} kind="breakout" snapshot={snapshot} onCall={controls.call} ticker={ticker} />;
      case "decision":
        return (
          <DecisionView
            key={callKey}
            snapshot={snapshot}
            resumed={resumedAt === callKey && callKey > 0}
            onCall={controls.call}
            ticker={ticker}
          />
        );
      case "celebrating":
        return <Celebration snapshot={snapshot} onContinue={controls.continue} />;
      case "ended":
        return (
          <div className={FRAME}>
            <Skeleton label={fillCopy("play.ended")} className="flex flex-col gap-3.5">
              <SkeletonRows count={3} />
            </Skeleton>
          </div>
        );
      case "error":
        return (
          <div className={FRAME}>
            <StateCard
              kind="error"
              size="screen"
              title={t("pause.error.title")}
              body={t("pause.error.body")}
              action={{ label: t("pause.error.cta"), onClick: () => window.location.reload() }}
            />
          </div>
        );
    }
  })();

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite">
        {spoken}
      </div>
      {isPause ? null : (
        <OutcomeTicker narration={narration} outcomeKey={outcomeKey} persist={machineState === "celebrating" || ended} />
      )}
      {screen}
    </>
  );
}
