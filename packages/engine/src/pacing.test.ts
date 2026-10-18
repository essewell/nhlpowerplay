/**
 * Pacing harness: how much of a power play is spent on in-zone decisions versus non-decision loops
 * (faceoff, PK possession, regroup, zone entry). SYNTHETIC data only (sim-fixtures.ts).
 * Single-threaded test module; all state is local to each call. Every random choice (fixture seed,
 * policy) comes from modes.ts PRNGs seeded from the run index, so a failure reproduces from the
 * fixture name and run index alone.
 *
 * DESIGN GOALS (pacing targets, not facts about hockey), measured with the greedy policy on a full
 * 2:00 minor (fiveOnFour) and asserted below so a retune that breaks them fails the build:
 *   - >= 60% of PP seconds are in the offensive zone with PP possession (decision steps + set-up)
 *   - >= 6 in-zone decisions per run on average
 *   - shorthanded goals <= 3% of runs
 *   - <= 2 zone-entry attempts per run on average
 * Time is attributed from the run log alone (no sim internals), see classify().
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_CALLS_PER_RUN } from "./constants.ts";
import { fnv1a, mulberry32 } from "./modes.ts";
import type { Result } from "./result.ts";
import { ALL_FIXTURES } from "./sim-fixtures.ts";
import type { Call, CallOption, RunInput, RunState } from "./sim-types.ts";
import { applyCall, initRun, legalCalls, type Policy } from "./sim.ts";

/** Runs per fixture x policy in the asserted configuration; sized to finish in well under 10 s. */
const ASSERT_RUNS = 400;
/** Larger sample for the printed tables (override with PACING_RUNS). */
const REPORT_RUNS = Number(process.env.PACING_RUNS ?? ASSERT_RUNS);
const POLICY_SEED_XOR = 0x9e3779b9;
/** Greedy policy: share of in-zone decisions that pass to the best-odds receiver. */
const GREEDY_PASS_SHARE = 0.6;
/** Greedy policy: shoot instead of skating only if the best shot's goal odds reach this. */
const GREEDY_SHOOT_MIN_P = 0.08;

/** Pacing targets (DESIGN GOALS), greedy policy, fiveOnFour. */
const TARGET = { minInZoneShare: 0.6, minDecisionsPerRun: 6, maxShGoalRate: 0.03, maxEntriesPerRun: 2 } as const;

/** Regression floor for the random policy (not a design goal; it ignores all odds). */
const RANDOM_MIN_IN_ZONE_SHARE = 0.3;

type Bucket = "inzone" | "faceoff" | "entry" | "regroup" | "pk" | "loose";
const BUCKETS: readonly Bucket[] = ["inzone", "faceoff", "entry", "regroup", "pk", "loose"];
type PolicyName = "greedy" | "random";

function val<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(`expected ok, got error: ${r.error}`);
  return r.value;
}

const bestBy = (os: CallOption[], type: Call["type"]): CallOption | undefined =>
  os.filter((o) => o.call.type === type).reduce<CallOption | undefined>((b, o) => (b === undefined || o.p > b.p ? o : b), undefined);

/** Greedy: faceoff/entry take the best odds; in a decision 60% best pass, else best shot if worthwhile, else best skate. O(C). */
function greedyPolicy(rand: () => number): Policy {
  return (options, state) => {
    const pick = (t: Call["type"]): Call | undefined => bestBy(options, t)?.call;
    const k = state.phase.kind;
    if (k === "decision") {
      const pass = pick("pass");
      if (pass !== undefined && rand() < GREEDY_PASS_SHARE) return pass;
      const shot = bestBy(options, "shoot");
      const setPlay = bestBy(options, "set_play");
      const top = setPlay !== undefined && (shot === undefined || setPlay.p > shot.p) ? setPlay : shot;
      if (top !== undefined && top.p >= GREEDY_SHOOT_MIN_P) return top.call;
      return pick("skate") ?? pass ?? shot?.call ?? options[0]?.call ?? fail();
    }
    const best = options.reduce<CallOption | undefined>((b, o) => (b === undefined || o.p > b.p ? o : b), undefined);
    return best?.call ?? fail();
  };
}

/** Uniformly random legal option. O(1). */
function randomPolicy(rand: () => number): Policy {
  return (options) => options[Math.floor(rand() * options.length)]?.call ?? fail();
}

function fail(): never { throw new Error("policy had no options"); }

interface RunStats {
  seconds: Record<Bucket, number>;
  totalS: number;
  decisions: number;
  entries: number;
  ppGoals: number;
  shGoals: number;
  endReason: string;
}

/**
 * Attribute every PP second to a bucket from the log. A mode is set by the event that starts a
 * timed step; the interval to the next event belongs to that mode. O(L) for L log events.
 */
function classify(s: RunState): Pick<RunStats, "seconds" | "totalS"> {
  const seconds = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  let mode: Bucket | "pause" = "pause";
  const first = s.log[0];
  let last = first?.atS ?? 0;
  const startS = last;
  for (const e of s.log) {
    if (mode !== "pause") seconds[mode] += e.atS - last;
    last = e.atS;
    const hit = e.detail?.hit === true;
    switch (e.kind) {
      case "call": {
        const t = e.detail?.type;
        mode = t === "faceoff" ? "faceoff" : t === "zone_entry" ? "entry" : t === "breakout" ? "regroup" : "inzone";
        break;
      }
      case "clear": mode = "regroup"; break;
      case "draw:intercept": mode = hit ? "pk" : "loose"; break;
      case "draw:skate": mode = hit ? "pause" : "loose"; break;
      case "draw:loose":
      case "draw:blocked_recover":
      case "draw:rebound":
      case "draw:miss_recover":
      case "draw:faceoff_loss_clear": mode = hit ? "pause" : "pk"; break;
      case "draw:entry": mode = hit ? "inzone" : "pk"; break; // a clean entry is followed by the set-up
      default: mode = "pause";
    }
  }
  return { seconds, totalS: last - startS };
}

/** One full run to its end under `policy`. O(N x applyCall). */
function playRun(input: RunInput, policy: Policy): RunStats {
  let s = val(initRun(input));
  let decisions = 0, entries = 0, n = 0;
  while (s.phase.kind !== "ended") {
    assert.ok(n++ < MAX_CALLS_PER_RUN, "run did not end");
    const opts = val(legalCalls(s, input));
    const call = policy(opts, s);
    if (call.type === "pass" || call.type === "skate" || call.type === "shoot" || call.type === "set_play") decisions++;
    if (call.type === "zone_entry") entries++;
    s = val(applyCall(s, input, call, s.callCount));
  }
  const ph = s.phase;
  const goals = s.log.filter((e) => e.kind === "goal");
  return {
    ...classify(s), decisions, entries,
    ppGoals: goals.filter((e) => e.detail?.side === "pp").length,
    shGoals: goals.filter((e) => e.detail?.side === "pk").length,
    endReason: ph.kind === "ended" ? ph.reason : "?",
  };
}

interface Summary {
  fixture: string; policy: PolicyName; runs: number;
  share: Record<Bucket, number>;
  decisions: number; entries: number; ppGoals: number; shGoalRate: number;
  ends: Record<string, number>;
  /** Seconds before the first in-zone decision (mean). */
  totalS: number;
}

/** Aggregate `runs` seeded runs of one fixture under one policy. O(runs x playRun). */
export function measure(fixture: string, policy: PolicyName, runs: number): Summary {
  const build = ALL_FIXTURES[fixture];
  if (build === undefined) throw new Error(`no fixture ${fixture}`);
  const sec = Object.fromEntries(BUCKETS.map((b) => [b, 0])) as Record<Bucket, number>;
  const ends: Record<string, number> = {};
  let total = 0, decisions = 0, entries = 0, pp = 0, sh = 0;
  for (let i = 0; i < runs; i++) {
    const seed = fnv1a(`pacing-${fixture}-${i}`);
    const input = build({ seed, askEveryTouch: false, formation: i % 2 === 0 ? "umbrella" : "one_three_one" });
    const rand = mulberry32((seed ^ POLICY_SEED_XOR) >>> 0);
    const r = playRun(input, policy === "greedy" ? greedyPolicy(rand) : randomPolicy(rand));
    for (const b of BUCKETS) sec[b] += r.seconds[b];
    total += r.totalS; decisions += r.decisions; entries += r.entries; pp += r.ppGoals; sh += r.shGoals > 0 ? 1 : 0;
    ends[r.endReason] = (ends[r.endReason] ?? 0) + 1;
  }
  const share = Object.fromEntries(BUCKETS.map((b) => [b, total > 0 ? sec[b] / total : 0])) as Record<Bucket, number>;
  return { fixture, policy, runs, share, decisions: decisions / runs, entries: entries / runs, ppGoals: pp / runs,
    shGoalRate: sh / runs, ends, totalS: total / runs };
}

const pct = (x: number): string => `${(100 * x).toFixed(1)}%`;

function printTable(title: string, rows: Summary[]): void {
  console.log(`\n${title}`);
  console.table(rows.map((r) => ({
    fixture: r.fixture, policy: r.policy, runs: r.runs, "PP s/run": r.totalS.toFixed(1),
    "in-zone PP": pct(r.share.inzone), faceoff: pct(r.share.faceoff), entry: pct(r.share.entry),
    regroup: pct(r.share.regroup), "PK poss": pct(r.share.pk), loose: pct(r.share.loose),
    "decisions/run": r.decisions.toFixed(2), "entries/run": r.entries.toFixed(2),
    "PP goals/run": r.ppGoals.toFixed(3), "SH goal rate": pct(r.shGoalRate),
    ends: Object.entries(r.ends).map(([k, v]) => `${k}:${pct(v / r.runs)}`).join(" "),
  })));
}

test("pacing report: shares of PP time and outcomes per fixture, greedy and random policy", () => {
  const rows: Summary[] = [];
  for (const f of ["fiveOnFour", "doubleMinor", "major", "staggeredFiveOnThree"]) {
    for (const p of ["greedy", "random"] as const) rows.push(measure(f, p, REPORT_RUNS));
  }
  printTable(`Pacing (${REPORT_RUNS} seeded runs per row)`, rows);
});

test("pacing targets (design goals) hold for the greedy policy on a full 2:00 minor", () => {
  const r = measure("fiveOnFour", "greedy", ASSERT_RUNS);
  assert.ok(r.share.inzone >= TARGET.minInZoneShare,
    `in-zone PP share ${pct(r.share.inzone)} < ${pct(TARGET.minInZoneShare)}`);
  assert.ok(r.decisions >= TARGET.minDecisionsPerRun, `${r.decisions.toFixed(2)} decisions/run < ${TARGET.minDecisionsPerRun}`);
  assert.ok(r.shGoalRate <= TARGET.maxShGoalRate, `SH goal rate ${pct(r.shGoalRate)} > ${pct(TARGET.maxShGoalRate)}`);
  assert.ok(r.entries <= TARGET.maxEntriesPerRun, `${r.entries.toFixed(2)} zone entries/run > ${TARGET.maxEntriesPerRun}`);
});

test("pacing: a 5-on-4 minor keeps a floor of in-zone time for the random policy, and time buckets cover the run", () => {
  const r = measure("fiveOnFour", "random", ASSERT_RUNS);
  const covered = BUCKETS.reduce((a, b) => a + r.share[b], 0);
  assert.ok(Math.abs(covered - 1) < 1e-9, `buckets cover ${covered} of PP time`);
  assert.ok(r.share.inzone >= RANDOM_MIN_IN_ZONE_SHARE, `random policy in-zone share ${pct(r.share.inzone)} < ${pct(RANDOM_MIN_IN_ZONE_SHARE)}`);
});
