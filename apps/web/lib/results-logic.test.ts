import { test } from "node:test";
import assert from "node:assert/strict";
import { err, ok } from "@powerplay/engine/result.ts";
import type { EndDetail, EndReason, RunEvent, RunState } from "@powerplay/engine/sim-types.ts";
import type { ScenarioView } from "./contracts.ts";
import {
  classifyStored, elapsedClockText, eyebrowText, gradeCounts, gradesInOrder, matchKey, matchText, parseMode,
  percentileText, realBenchView, selectBanner, shareText, summarizeRun, type RunSummary,
} from "./results-logic.ts";
import type { StoredRun } from "./run/persistence.ts";

const goalEvent = (side: "pp" | "pk", period: number, elapsedS: number): RunEvent => ({
  i: 0, callIndex: 0, atS: 0, clock: { period, elapsedS }, kind: "goal", detail: { side },
});

function run(opts: {
  startPp?: number; endPp: number; reason?: EndReason; detail?: EndDetail; log?: RunEvent[]; ended?: boolean;
}) {
  const phase: RunState["phase"] = opts.ended === false
    ? { kind: "decision" }
    : { kind: "ended", reason: opts.reason ?? "pp_expired", detail: opts.detail ?? null };
  return {
    scenario: { score: { pp: opts.startPp ?? 1, pk: 1 } },
    state: { score: { pp: opts.endPp, pk: 1 }, phase, log: opts.log ?? [] } as unknown as RunState,
  };
}

const banner = (r: ReturnType<typeof run>) => selectBanner(summarizeRun(r));

test("banner: one PP goal is scored, with the goal clock and period", () => {
  const b = banner(run({ endPp: 2, reason: "pp_expired", log: [goalEvent("pp", 2, 683)] }));
  assert.equal(b.tone, "scored");
  assert.equal(b.title, "You score");
  assert.equal(b.sub, "Power-play goal at 11:23 of the 2nd");
});

test("banner: two goals say how many and when the last one was", () => {
  const b = banner(run({ endPp: 3, log: [goalEvent("pp", 1, 100), goalEvent("pk", 1, 150), goalEvent("pp", 1, 200)] }));
  assert.equal(b.tone, "scored");
  assert.equal(b.sub, "2 power-play goals, the last at 3:20 of the 1st");
});

test("banner edge: goals scored before the penalty expired still read as scored", () => {
  const b = banner(run({ endPp: 2, reason: "pp_expired", log: [goalEvent("pp", 3, 1) ] }));
  assert.equal(b.tone, "scored");
  assert.equal(b.sub, "Power-play goal at 0:01 of the 3rd");
});

test("banner edge: overtime winner ends the game and is a scored banner", () => {
  const b = banner(run({ endPp: 2, reason: "game_end", detail: "ot_goal", log: [goalEvent("pp", 4, 103)] }));
  assert.equal(b.tone, "scored");
  assert.equal(b.sub, "Power-play goal at 1:43 of the OT");
});

test("banner edge: a goal with no log entry still says scored, without inventing a clock", () => {
  const b = banner(run({ endPp: 2, log: [] }));
  assert.equal(b.tone, "scored");
  assert.equal(b.sub, "Power-play goal");
});

test("banner edge: shorthanded goal ends the run -> shorthanded banner, even after a PP goal", () => {
  const plain = banner(run({ endPp: 1, reason: "sh_goal", log: [goalEvent("pk", 2, 30)] }));
  assert.equal(plain.tone, "shorthanded");
  assert.equal(plain.title, "Shorthanded goal");
  const after = banner(run({ endPp: 2, reason: "sh_goal", log: [goalEvent("pp", 2, 10), goalEvent("pk", 2, 30)] }));
  assert.equal(after.tone, "shorthanded");
});

test("banner: penalty expired and cleared out are both 'kill holds' with their own reason", () => {
  const expired = banner(run({ endPp: 1, reason: "pp_expired" }));
  assert.equal(expired.tone, "held");
  assert.equal(expired.title, "Kill holds");
  assert.equal(expired.sub, "Penalty's over. Back to even strength.");
  const cleared = banner(run({ endPp: 1, reason: "cleared_out" }));
  assert.equal(cleared.sub, "Cleared, and not enough time to get back in.");
});

test("banner edge: game ended without a goal -> held; empty net has its own line", () => {
  assert.equal(banner(run({ endPp: 1, reason: "game_end", detail: "regulation_end" })).sub,
    "Time's up. The game ended before the power play did.");
  assert.equal(banner(run({ endPp: 1, reason: "game_end", detail: "shootout" })).tone, "held");
  assert.equal(banner(run({ endPp: 1, reason: "game_end", detail: "empty_net" })).sub,
    "Empty net. The power play is over.");
});

test("summarizeRun edge: a run that has not ended is reported as not ended, no reason", () => {
  const s = summarizeRun(run({ endPp: 1, ended: false }));
  assert.equal(s.ended, false);
  assert.equal(s.reason, null);
});

test("summarizeRun edge: a PP score below the starting score never counts negative goals", () => {
  assert.equal(summarizeRun(run({ startPp: 3, endPp: 1 })).ppGoals, 0);
});

test("summarizeRun: last PP goal ignores later shorthanded goals", () => {
  const s = summarizeRun(run({ endPp: 2, reason: "sh_goal", log: [goalEvent("pp", 1, 50), goalEvent("pk", 1, 90)] }));
  assert.deepEqual(s.lastPpGoal, { period: 1, elapsedS: 50 });
});

const heldSummary: RunSummary = { ended: true, ppGoals: 0, lastPpGoal: null, reason: "pp_expired", detail: null };
test("selectBanner: held summary is held", () => assert.equal(selectBanner(heldSummary).tone, "held"));

const real = (result: "goal" | "no_goal" | "sh_goal_against"): NonNullable<ScenarioView["realOutcome"]> =>
  ({ result, scorerId: null, assistIds: [null, null], endT: 0 });

test("matchKey: all four combinations", () => {
  assert.equal(matchKey(true, real("goal")), "same");
  assert.equal(matchKey(true, real("no_goal")), "better");
  assert.equal(matchKey(false, real("goal")), "worse");
  assert.equal(matchKey(false, real("no_goal")), "bothMissed");
  assert.equal(matchText("same"), "You matched it");
  assert.equal(matchText("better"), "You out-called it");
  assert.equal(matchText("worse"), "They got this one");
  assert.equal(matchText("bothMissed"), "Nobody scored");
});

test("matchKey edge: a real shorthanded goal against is not the real bench scoring", () => {
  assert.equal(matchKey(true, real("sh_goal_against")), "better");
  assert.equal(matchKey(false, real("sh_goal_against")), "bothMissed");
});

test("matchKey edge: no real outcome -> no match line", () => {
  assert.equal(matchKey(true, undefined), null);
  assert.equal(matchKey(false, undefined), null);
});

function view(patch: Partial<ScenarioView> = {}): ScenarioView {
  return {
    id: "x", teams: { pp: "AAA", pk: "BBB" }, score: { pp: 1, pk: 1 }, period: 2, clockElapsedS: 0,
    strength: { pp: 5, pk: 4 }, stageText: null, gameNumber: null, stakes: null,
    players: {
      1: { number: 1, first: "Ann", last: "Alpha", pos: "C" },
      2: { number: 2, first: "Bo", last: "Beta", pos: "D" },
      3: { number: 3, first: "Cy", last: "Gamma", pos: "W" },
    },
    ...patch,
  };
}

test("realBenchView: goal with two assists -> scorer line and a three-name chain", () => {
  const v = view({ realOutcome: { result: "goal", scorerId: 3, assistIds: [2, 1], endT: 683 } });
  assert.deepEqual(realBenchView(v), { line: "Scored · Gamma at 11:23", chain: "Alpha → Beta → Gamma" });
});

test("realBenchView edge: one assist -> two-name chain; unassisted -> no chain", () => {
  const one = realBenchView(view({ realOutcome: { result: "goal", scorerId: 3, assistIds: [2, null], endT: 60 } }));
  assert.equal(one?.chain, "Beta → Gamma");
  const secondaryOnly = realBenchView(view({ realOutcome: { result: "goal", scorerId: 3, assistIds: [null, 1], endT: 60 } }));
  assert.equal(secondaryOnly?.chain, "Alpha → Gamma");
  const none = realBenchView(view({ realOutcome: { result: "goal", scorerId: 3, assistIds: [null, null], endT: 60 } }));
  assert.equal(none?.chain, null);
});

test("realBenchView edge: an assister missing from the rosters drops the chain, not the line", () => {
  const r = realBenchView(view({ realOutcome: { result: "goal", scorerId: 3, assistIds: [2, 999], endT: 600 } }));
  assert.equal(r?.line, "Scored · Gamma at 10:00");
  assert.equal(r?.chain, null);
});

test("realBenchView edge: unknown scorer keeps the time and omits the name and chain", () => {
  const r = realBenchView(view({ realOutcome: { result: "goal", scorerId: null, assistIds: [2, 1], endT: 5 } }));
  assert.deepEqual(r, { line: "Scored · 0:05", chain: null });
  const missing = realBenchView(view({ realOutcome: { result: "goal", scorerId: 999, assistIds: [null, null], endT: 5 } }));
  assert.equal(missing?.line, "Scored · 0:05");
});

test("realBenchView: no goal, shorthanded goal against, and no data", () => {
  assert.deepEqual(realBenchView(view({ realOutcome: real("no_goal") })), { line: "No goal · kill held", chain: null });
  assert.deepEqual(realBenchView(view({ realOutcome: real("sh_goal_against") })),
    { line: "Shorthanded goal against", chain: null });
  assert.equal(realBenchView(view()), null);
});

test("elapsedClockText: m:ss, null for non-seconds", () => {
  assert.equal(elapsedClockText(683), "11:23");
  assert.equal(elapsedClockText(-1), null);
});

test("parseMode: daily and endless only", () => {
  assert.equal(parseMode("daily"), "daily");
  assert.equal(parseMode("endless"), "endless");
  for (const bad of [null, undefined, "", "Daily", "weekly", "daily "]) assert.equal(parseMode(bad), null);
});

const stored = (patch: Partial<StoredRun>): StoredRun =>
  ({ v: 1, mode: "daily", date: "2099-01-01", scenarioId: "s", seed: 1, calls: [], ended: false, ...patch });

test("classifyStored: ended, in progress, nothing, unreadable", () => {
  assert.deepEqual(classifyStored(ok(stored({ ended: true }))), { access: "ended", date: "2099-01-01" });
  assert.deepEqual(classifyStored(ok(stored({}))), { access: "in_progress", date: "2099-01-01" });
  assert.deepEqual(classifyStored(ok(null)), { access: "none", date: null });
  assert.deepEqual(classifyStored(err("corrupt")), { access: "none", date: null });
  assert.deepEqual(classifyStored(ok(stored({ mode: "endless", date: null, ended: true }))), { access: "ended", date: null });
});

test("percentileText: rounds, clamps, rejects non-numbers", () => {
  assert.equal(percentileText(72.4), "72");
  assert.equal(percentileText(99.6), "100");
  assert.equal(percentileText(-3), "0");
  assert.equal(percentileText(250), "100");
  assert.equal(percentileText(null), null);
  assert.equal(percentileText(Number.NaN), null);
});

test("grade helpers: counts and call order", () => {
  const grades = [
    { callIndex: 2, grade: "miss" as const }, { callIndex: 0, grade: "best" as const },
    { callIndex: 1, grade: "best" as const },
  ];
  assert.deepEqual(gradeCounts(grades), { best: 2, close: 0, costly: 0, miss: 1 });
  assert.deepEqual(gradesInOrder(grades).map((g) => g.callIndex), [0, 1, 2]);
  assert.equal(grades[0]?.callIndex, 2, "input is not reordered");
  assert.deepEqual(gradeCounts([]), { best: 0, close: 0, costly: 0, miss: 0 });
});

test("shareText: Daily line from counts; Endless has none", () => {
  const grades = [{ callIndex: 0, grade: "best" as const }, { callIndex: 1, grade: "costly" as const }];
  const r = shareText({ n: 7, teams: { pp: "AAA", pk: "BBB" }, scored: true, grades, url: "https://example.test" });
  assert.deepEqual(r, ok("PowerPlay Daily No. 7 · AAA vs BBB · Scored · 1 best, 0 close, 1 costly, 0 big miss · https://example.test"));
  const held = shareText({ n: 7, teams: { pp: "AAA", pk: "BBB" }, scored: false, grades: [], url: "u" });
  assert.equal(held.ok && held.value.includes("Kill held"), true);
  assert.equal(shareText({ n: null, teams: { pp: "A", pk: "B" }, scored: true, grades, url: "u" }).ok, false);
});

test("eyebrowText: Daily with and without a number, Endless", () => {
  const teams = { pp: "AAA", pk: "BBB" };
  assert.equal(eyebrowText("daily", 12, teams), "Daily No. 12 · AAA vs BBB");
  assert.equal(eyebrowText("daily", null, teams), "Daily · AAA vs BBB");
  assert.equal(eyebrowText("endless", 12, teams), "Endless · AAA vs BBB");
});
