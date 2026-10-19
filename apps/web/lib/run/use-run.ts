"use client";

/**
 * useRun(mode, scenarioId, opts) -> [Loadable<RunSnapshot>, RunControls].
 * Thin React wrapper over RunController (controller.ts holds the rules and the tests).
 *  - scenarioId null: "whatever is due" (today's Daily / the next Endless scenario / the saved run).
 *  - opts.date: the Daily date the caller resolved (from getDaily); defaults to today in Vancouver.
 * The controls object is stable across renders; `playAgain` is Endless-only.
 */
import { useEffect, useRef, useState } from "react";
import type { Loadable, Mode, RunSnapshot } from "../contracts.ts";
import { browserDeps } from "./browser.ts";
import { RunController, type ControllerDeps, type RunControlsEx } from "./controller.ts";

export interface UseRunOpts { date?: string }

const LOADING: Loadable<RunSnapshot> = { status: "loading" };

export function useRun(mode: Mode, scenarioId: string | null, opts: UseRunOpts = {}): [Loadable<RunSnapshot>, RunControlsEx] {
  const [state, setState] = useState<Loadable<RunSnapshot>>(LOADING);
  const ctlRef = useRef<RunController | null>(null);
  // Stable controls that always forward to the current controller (none before mount: no-ops).
  const [controls] = useState<RunControlsEx>(() => ({
    start: () => ctlRef.current?.controls.start(),
    call: (c) => ctlRef.current?.controls.call(c),
    continue: () => ctlRef.current?.controls.continue(),
    playAgain: () => ctlRef.current?.controls.playAgain(),
    setFormation: (f) => ctlRef.current?.controls.setFormation(f),
  }));
  const date = opts.date;

  useEffect(() => {
    const deps: ControllerDeps = browserDeps();
    const ctl = new RunController(deps, mode, scenarioId, date === undefined ? {} : { date });
    ctlRef.current = ctl;
    const unsubscribe = ctl.subscribe(setState);
    void ctl.init();
    return () => {
      unsubscribe();
      ctl.dispose();
      if (ctlRef.current === ctl) ctlRef.current = null;
    };
  }, [mode, scenarioId, date]);

  return [state, controls];
}
