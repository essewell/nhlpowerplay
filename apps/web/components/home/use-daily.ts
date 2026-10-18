"use client";

/**
 * Today's Daily as a Loadable, plus a retry. getDaily never rejects (failures are `error` values), so the
 * only state changes are the async result and the retry reset. Main thread only.
 */
import { useEffect, useState } from "react";
import type { DailyInfo, Loadable } from "../../lib/contracts.ts";
import { getDaily } from "../../lib/daily.ts";

const LOADING: Loadable<DailyInfo> = { status: "loading" };

export function useDaily(): [Loadable<DailyInfo>, () => void] {
  const [state, setState] = useState<Loadable<DailyInfo>>(LOADING);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void getDaily().then((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const retry = (): void => {
    setState(LOADING);
    setAttempt((n) => n + 1);
  };
  return [state, retry];
}
