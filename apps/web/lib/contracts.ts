/**
 * Step 4 integration contract between the app layers (written first so parallel work agrees).
 * Types only. Implementations:
 *   lib/data.ts, lib/daily.ts, lib/run/*      -> data + run layer
 *   lib/copy.ts                               -> all UI strings (docs/COPY.md; drafts marked pending)
 *   components/ui/*                           -> shared primitives
 *   app/** screens                            -> consume only what is declared here
 *
 * Rules: every number shown comes from the engine (legalCalls / likelihood) or the export; no game
 * facts, years, names or percentages typed into UI code. No analytics. v1 has no backend: runs,
 * streaks and settings live in localStorage (docs/LAUNCH.md).
 */
import type { CallOption, Call, RunState, RunInput, Phase } from "@powerplay/engine/sim-types.ts";
import type { RatingFlag } from "@powerplay/engine/loader.ts";

export type Mode = "daily" | "endless";

/** A scenario as exported (parseScenario output) plus what the UI needs that the engine drops. */
export interface ScenarioView {
  id: string;
  teams: { pp: string; pk: string };                    // abbreviations from the export
  score: { pp: number; pk: number };
  period: number;
  clockElapsedS: number;
  strength: { pp: number; pk: number };
  stageText: string | null;                              // from stage code map; null if unknown
  gameNumber: number | null;                             // derived from the NHL game id
  stakes: string | null;                                 // curated narrative only, else null
  players: Record<number, { number: number | null; first: string; last: string; pos: string }>;
}

export type Loadable<T> =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "empty" }
  | { status: "ready"; value: T };

/** lib/daily.ts */
export interface DailyInfo {
  date: string;              // YYYY-MM-DD in America/Vancouver
  number: number;            // 1-based position in schedule.json; fallback picks get the day offset
  scenario: ScenarioView;
}

/** lib/run: one run, driven in a Web Worker; the hook mirrors its state. */
export interface RunSnapshot {
  mode: Mode;
  date: string | null;       // daily date the run started on (edge 7: finish on that scenario)
  scenario: ScenarioView;
  input: RunInput;
  state: RunState;
  phase: Phase;
  machineState: "intro" | "faceoffCall" | "zoneEntryCall" | "breakoutCall" | "decision"
    | "celebrating" | "ended" | "error";
  options: CallOption[];     // legalCalls for the current pause ([] when not paused)
  calls: Call[];             // applied calls, in order (persisted; replay key with seed)
  flags: RatingFlag[];       // loader fallbacks -> "League average" tags
  error: string | null;
  busy: boolean;             // true while a CALL is in flight (disable buttons: edge 9)
}

export interface RunControls {
  start(): void;
  call(call: Call): void;    // sends CALL with the next callIndex; ignored while busy
  continue(): void;          // after a PP goal celebration
}

/** Step 5 owns grading; Step 4 renders this shape and stubs it. */
export interface GradeReport {
  status: "loading" | "error" | "empty" | "ready";
  grades: { callIndex: number; grade: "best" | "close" | "costly" | "miss" }[] | null;
  percentile: number | null;
  looksLike: string | null;
  approx: boolean;
}

/** lib/copy.ts: `t(key, vars?)`; unknown key -> throws in dev, returns the key in prod builds. */
export type CopyVars = Record<string, string | number>;
