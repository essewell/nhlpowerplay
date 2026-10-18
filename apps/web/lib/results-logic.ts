/**
 * Pure helpers behind the Results screen (components/results/*). No DOM, no state, no clock reads.
 * Everything shown is derived from the finished run, the scenario's real outcome or the GradeReport;
 * nothing is typed in. Tested in results-logic.test.ts.
 */
import { err, ok, type Result } from "@powerplay/engine/result.ts";
import type { Clock, EndDetail, EndReason, RunEvent } from "@powerplay/engine/sim-types.ts";
import type { GradeReport, Mode, RunSnapshot, ScenarioView } from "./contracts.ts";
import { periodOrdinal, t, type CopyKey } from "./copy.ts";
import { formatMmSs } from "./home-logic.ts";
import type { StoredRun } from "./run/persistence.ts";

export const MODES: readonly Mode[] = ["daily", "endless"];
const PERCENT_MAX = 100;

type Grades = NonNullable<GradeReport["grades"]>;

/** ?mode= value -> Mode, null when missing or unknown. O(1). */
export function parseMode(raw: string | null | undefined): Mode | null {
  return MODES.find((m) => m === raw) ?? null;
}

/** Where a mode's play screen lives. */
export const playHref = (mode: Mode): string => `/play/${mode}`;
export const resultsHref = (mode: Mode): string => `/results?mode=${mode}`;

export type StoredAccess = "none" | "in_progress" | "ended";

/**
 * What is saved for the mode, as far as Results is concerned. An unreadable save counts as "none":
 * Results only reads, the play screen is the one place that discards a corrupt save. O(1).
 */
export function classifyStored(read: Result<StoredRun | null>): { access: StoredAccess; date: string | null } {
  if (!read.ok || read.value === null) return { access: "none", date: null };
  return { access: read.value.ended ? "ended" : "in_progress", date: read.value.date };
}

export interface RunSummary {
  ended: boolean;
  /** PP goals scored in this run (final PP score minus the scenario's starting PP score). */
  ppGoals: number;
  /** Clock of the last PP goal; null when the event log has none (a trimmed or replayed log). */
  lastPpGoal: Clock | null;
  reason: EndReason | null;
  detail: EndDetail;
}

const isPpGoal = (e: RunEvent): boolean => e.kind === "goal" && e.detail?.side === "pp";

/** Reduce a run snapshot to what the banner and the match word need. O(log length). */
export function summarizeRun(run: Pick<RunSnapshot, "state"> & { scenario: Pick<ScenarioView, "score"> }): RunSummary {
  const { state } = run;
  const ppGoals = Math.max(0, state.score.pp - run.scenario.score.pp);
  const lastGoal = [...state.log].reverse().find(isPpGoal);
  const ph = state.phase;
  return {
    ended: ph.kind === "ended",
    ppGoals,
    lastPpGoal: lastGoal === undefined ? null : lastGoal.clock,
    reason: ph.kind === "ended" ? ph.reason : null,
    detail: ph.kind === "ended" ? ph.detail : null,
  };
}

/** Elapsed-time clock of a goal ("11:23" = 11 min 23 s into the period, as NHL play-by-play lists it). */
export function elapsedClockText(elapsedS: number): string | null {
  return formatMmSs(elapsedS);
}

export type BannerTone = "scored" | "held" | "shorthanded";
export interface BannerView { tone: BannerTone; title: string; sub: string }

function goalSub(s: RunSummary): string {
  const clock = s.lastPpGoal === null ? null : elapsedClockText(s.lastPpGoal.elapsedS);
  if (s.lastPpGoal === null || clock === null) return t("results.banner.goal.subNoClock");
  const vars = { clock, periodOrdinal: periodOrdinal(s.lastPpGoal.period) };
  return s.ppGoals > 1 ? t("results.banner.goal.sub.multi", { n: s.ppGoals, ...vars }) : t("results.banner.goal.sub", vars);
}

function heldSub(s: RunSummary): string {
  if (s.reason === "pp_expired") return t("pause.end.expired");
  if (s.reason === "cleared_out") return t("pause.end.cleared");
  return s.detail === "empty_net" ? t("end.emptyNet") : t("end.gameEnd");
}

/**
 * Banner for a finished run, in this order:
 *  1. ended by a shorthanded goal -> shorthanded (even if the PP scored earlier: that is how it ended);
 *  2. the PP scored at least once -> scored (one goal or several; also OT winners and goals before the
 *     game ended or the penalty ran out);
 *  3. otherwise held, with the reason: penalty expired, cleared out, or the game ended. O(1).
 */
export function selectBanner(s: RunSummary): BannerView {
  if (s.reason === "sh_goal") {
    return { tone: "shorthanded", title: t("results.banner.shortie"), sub: t("pause.end.shortie") };
  }
  if (s.ppGoals > 0) return { tone: "scored", title: t("results.banner.goal"), sub: goalSub(s) };
  return { tone: "held", title: t("results.banner.noGoal"), sub: heldSub(s) };
}

export type MatchKey = "same" | "better" | "worse" | "bothMissed";
const MATCH_COPY: Record<MatchKey, CopyKey> = {
  same: "results.match.same",
  better: "results.match.better",
  worse: "results.match.worse",
  bothMissed: "results.match.bothMissed",
};

/**
 * Compare your outcome with the real bench's. Only a real PP goal counts as the real bench scoring (a
 * shorthanded goal against them is not a goal for them). null when the scenario has no real outcome. O(1).
 */
export function matchKey(youScored: boolean, real: ScenarioView["realOutcome"]): MatchKey | null {
  if (real === undefined) return null;
  const theyScored = real.result === "goal";
  if (youScored && theyScored) return "same";
  if (youScored) return "better";
  return theyScored ? "worse" : "bothMissed";
}

export const matchText = (key: MatchKey): string => t(MATCH_COPY[key]);

export interface RealBenchView { line: string; chain: string | null }

const lastNameOf = (v: ScenarioView, id: number | null): string | null => {
  if (id === null) return null;
  const p = v.players[id];
  return p === undefined || p.last.length === 0 ? null : p.last;
};

/** Secondary assist, primary assist, scorer (as in the design). Needs every named assister to resolve. */
function chainText(v: ScenarioView, assistIds: [number | null, number | null], scorer: string): string | null {
  const [primary, secondary] = assistIds;
  const named = [secondary, primary].filter((id): id is number => id !== null);
  if (named.length === 0) return null;
  const names = named.map((id) => lastNameOf(v, id));
  const [a, b] = names;
  if (a === null || a === undefined) return null;
  if (names.length === 2) {
    return b === null || b === undefined ? null : t("results.realBench.chain", { a, b, c: scorer });
  }
  return t("results.realBench.chain2", { a, b: scorer });
}

/**
 * The real-bench card. Goal: "Scored · <last name> at m:ss" (name dropped when the id is not on the
 * rosters), plus an assist chain only when every named assister resolves to a player. No goal and
 * shorthanded-goal-against have their own lines. null when the scenario has no real outcome. O(1).
 */
export function realBenchView(v: ScenarioView): RealBenchView | null {
  const real = v.realOutcome;
  if (real === undefined) return null;
  if (real.result === "no_goal") return { line: t("results.realBench.noGoal"), chain: null };
  if (real.result === "sh_goal_against") return { line: t("pause.end.shortie"), chain: null };
  const clock = elapsedClockText(real.endT) ?? t("common.dash");
  const scorer = lastNameOf(v, real.scorerId);
  const line = scorer === null
    ? t("results.realBench.goalNoScorer", { clock })
    : t("results.realBench.goal", { scorerLast: scorer, clock });
  return { line, chain: scorer === null ? null : chainText(v, real.assistIds, scorer) };
}

/** Coach percentile for display: rounded, clamped to 0..100; null when it is not a usable number. O(1). */
export function percentileText(p: number | null): string | null {
  if (p === null || !Number.isFinite(p)) return null;
  return String(Math.round(Math.min(PERCENT_MAX, Math.max(0, p))));
}

/** How many of each grade. O(n). */
export function gradeCounts(grades: Grades): Record<"best" | "close" | "costly" | "miss", number> {
  const counts = { best: 0, close: 0, costly: 0, miss: 0 };
  for (const g of grades) counts[g.grade]++;
  return counts;
}

/** Grades in call order (a copy; the report is not mutated). O(n log n). */
export function gradesInOrder(grades: Grades): Grades {
  return [...grades].sort((a, b) => a.callIndex - b.callIndex);
}

/** Plain-text share line (COPY.md results.share.text). Err for Endless, which has no share line. O(n). */
export function shareText(
  args: { n: number | null; teams: ScenarioView["teams"]; scored: boolean; grades: Grades; url: string },
): Result<string> {
  if (args.n === null) return err("share: only the Daily has a share line");
  const c = gradeCounts(args.grades);
  return ok(t("results.share.text", {
    n: args.n, teamA: args.teams.pp, teamB: args.teams.pk,
    resultWord: t(args.scored ? "results.word.scored" : "results.word.killHeld"),
    best: c.best, close: c.close, costly: c.costly, miss: c.miss, url: args.url,
  }));
}

/** Eyebrow over the banner: Daily No. n, or Endless. Without a Daily number the number is dropped, not guessed. O(1). */
export function eyebrowText(mode: Mode, dailyNumber: number | null, teams: ScenarioView["teams"]): string {
  const vars = { teamA: teams.pp, teamB: teams.pk };
  if (mode === "endless") return t("results.eyebrow.endless", vars);
  return dailyNumber === null ? t("results.eyebrow.daily.noNumber", vars) : t("results.eyebrow", { n: dailyNumber, ...vars });
}
