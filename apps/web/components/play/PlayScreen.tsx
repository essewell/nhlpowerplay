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
import { useEffect, useRef, useState } from "react";
import { Skeleton, SkeletonBlock, SkeletonRows } from "../ui/Skeleton.tsx";
import { StateCard } from "../ui/StateCard.tsx";
import type { Mode } from "../../lib/contracts.ts";
import { t } from "../../lib/copy.ts";
import { useRun } from "../../lib/run/use-run.ts";
import { fillCopy } from "../../lib/play/strings.ts";
import { Celebration } from "./Celebration.tsx";
import { FaceoffSheet, MethodSheet } from "./CallSheet.tsx";
import { DecisionView } from "./DecisionView.tsx";
import { Intro } from "./Intro.tsx";

/** Marker for "this run was not picked up from a save". */
const NOT_RESUMED = -1;
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
    router.replace(`/results?mode=${mode}`);
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

  const snapshot = loadable.value;
  const callKey = snapshot.calls.length;

  switch (snapshot.machineState) {
    case "intro":
      return <Intro snapshot={snapshot} mode={mode} onStart={controls.start} />;
    case "faceoffCall":
      return <FaceoffSheet key={callKey} snapshot={snapshot} onCall={controls.call} />;
    case "zoneEntryCall":
      return <MethodSheet key={callKey} kind="entry" snapshot={snapshot} onCall={controls.call} />;
    case "breakoutCall":
      return <MethodSheet key={callKey} kind="breakout" snapshot={snapshot} onCall={controls.call} />;
    case "decision":
      return <DecisionView key={callKey} snapshot={snapshot} resumed={resumedAt === callKey && callKey > 0} onCall={controls.call} />;
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
}
