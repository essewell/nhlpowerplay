"use client";

/**
 * Data hooks for the Results screen. Main thread only; every state change happens in a promise callback.
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { GradeReport, Mode, RunSnapshot } from "../../lib/contracts.ts";
import { pickDaily } from "../../lib/daily.ts";
import { defaultSource } from "../../lib/data.ts";
import { gradeRun } from "../../lib/grader-stub.ts";
import { classifyStored, type StoredAccess } from "../../lib/results-logic.ts";
import { browserStore } from "../../lib/run/browser.ts";
import { readRun } from "../../lib/run/persistence.ts";

const LOADING_REPORT: GradeReport = { status: "loading", grades: null, percentile: null, looksLike: null, approx: false };
const ERROR_REPORT: GradeReport = { status: "error", grades: null, percentile: null, looksLike: null, approx: false };

/** Grade the finished run; `retry` re-runs the grader after an error. */
export function useGrade(run: RunSnapshot): [GradeReport, () => void] {
  const [report, setReport] = useState<GradeReport>(LOADING_REPORT);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    gradeRun(run)
      .then((next) => {
        if (!cancelled) setReport(next);
      })
      .catch((e: unknown) => {
        console.warn(`PowerPlay: grading failed: ${e instanceof Error ? e.message : String(e)}`);
        if (!cancelled) setReport(ERROR_REPORT);
      });
    return () => {
      cancelled = true;
    };
  }, [run, attempt]);

  const retry = (): void => {
    setReport(LOADING_REPORT);
    setAttempt((n) => n + 1);
  };
  return [report, retry];
}

/** The Daily number of `date` (position in the schedule); null for Endless, while loading, or if the data is unreadable. */
export function useDailyNumber(mode: Mode, date: string | null): number | null {
  const [found, setFound] = useState<{ date: string; n: number } | null>(null);

  useEffect(() => {
    if (mode !== "daily" || date === null) return;
    let cancelled = false;
    void defaultSource()
      .bundle()
      .then((b) => {
        if (cancelled) return;
        if (!b.ok) {
          console.warn(`PowerPlay: Daily number unavailable: ${b.error}`);
          return;
        }
        const pick = pickDaily(date, b.value.schedule, b.value.endlessIndex);
        if (pick.ok) setFound({ date, n: pick.value.number });
        else console.warn(`PowerPlay: Daily number unavailable: ${pick.error}`);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, date]);

  return mode === "daily" && found !== null && found.date === date ? found.n : null;
}

export type StoredView = { ready: false } | { ready: true; access: StoredAccess; date: string | null };

const NOT_READY = "pending";
const subscribeStorage = (onChange: () => void): (() => void) => {
  window.addEventListener("storage", onChange);
  return () => window.removeEventListener("storage", onChange);
};

/**
 * What is saved for `mode`, read on the client only (the server render, and the first client render, say
 * "not ready" so the HTML matches). The store value is a string key so the snapshot is stable.
 */
export function useStoredRun(mode: Mode): StoredView {
  const key = useSyncExternalStore(
    subscribeStorage,
    () => {
      const c = classifyStored(readRun(browserStore(), mode));
      return `${c.access}|${c.date ?? ""}`;
    },
    () => NOT_READY,
  );
  if (key === NOT_READY) return { ready: false };
  const [access, date] = key.split("|");
  return { ready: true, access: access as StoredAccess, date: date === undefined || date === "" ? null : date };
}
