import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { OZ_SPOTS, SET_PLAYS } from "@powerplay/engine/constants.ts";
import { pct } from "@powerplay/engine/likelihood.ts";
import { applyCall, initRun, legalCalls } from "@powerplay/engine/sim.ts";
import { fiveOnFour, fiveSecondsLeft, regOtFourOnThree, sixOnFourGoaliePulled } from "@powerplay/engine/sim-fixtures.ts";
import type { CallOption, RunInput, RunState } from "@powerplay/engine/sim-types.ts";
import type { RunSnapshot } from "../contracts.ts";
import { fromRink, RINK_VIEWBOX, toRink, toRinkPercent } from "./geometry.ts";
import {
  canSendCall, carrierOf, CORNER_COPY, faceoffTakers, findFaceoff, groupOptions, limitRows, optionDisabled,
  playerLabel, SET_PLAY_IDS, SET_PLAY_VIEW, SHOT_CORNERS, SHOT_TYPE_COPY, SHOT_TYPES, shotSummary, shotTargetOption,
  shotTypeOption, sortByChance, type OptionOf,
} from "./options.ts";
import { formatClock, periodClockLeftS, ppRemainingS, scoreboardModel } from "./scoreboard.ts";
import { fillCopy, labelAfterPct, pctLabel, playPctLabel, PLAY_COPY } from "./strings.ts";
import { hasCopy, t } from "../copy.ts";

// ---------------------------------------------------------------- engine helpers (real engine, synthetic input)

function mustState(input: RunInput): RunState {
  const r = initRun(input);
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
}

/** Play the opening faceoff (first legal option) until the run pauses for a decision. */
function decisionState(input: RunInput): { state: RunState; options: CallOption[] } {
  let state = mustState(input);
  for (let i = 0; i < 20; i++) {
    const opts = legalCalls(state, input);
    assert.ok(opts.ok, opts.ok ? "" : opts.error);
    if (state.phase.kind === "decision") return { state, options: opts.value };
    const first = opts.value[0];
    assert.ok(first !== undefined, "no legal calls");
    const next = applyCall(state, input, first.call, state.callCount);
    assert.ok(next.ok, next.ok ? "" : next.error);
    state = next.value;
  }
  assert.fail("never reached a decision");
}

function snapshotOf(input: RunInput, state: RunState, options: CallOption[], over: Partial<RunSnapshot> = {}): RunSnapshot {
  const players: RunSnapshot["scenario"]["players"] = {};
  for (const s of input.pp.skaters) players[s.id] = { number: s.id, first: "Synth", last: `Skater${s.id}`, pos: "C" };
  return {
    mode: "daily", date: null,
    scenario: {
      id: "synthetic", teams: { pp: "AAA", pk: "BBB" }, score: { pp: 0, pk: 0 }, period: 1, clockElapsedS: 0,
      strength: { pp: 5, pk: 4 }, stageText: null, gameNumber: null, stakes: null, players,
    },
    input, state, phase: state.phase, machineState: "decision", options, calls: [], flags: [], error: null, busy: false,
    ...over,
  };
}

const opt = (call: CallOption["call"], p: number, extra: Partial<CallOption> = {}): CallOption => ({
  call, p, breakdown: {}, durationS: 1, cutByClock: false, ...extra,
});

// ---------------------------------------------------------------- geometry

test("toRink: net maps to the top goal line, centre line has x = 0", () => {
  const net = toRink({ x: 89, y: 0 });
  assert.ok(net.ok);
  assert.deepEqual(net.value, { x: 0, y: 11 });
  assert.ok(Object.is(net.value.x, 0), "no negative zero");
});

test("toRink: y > 0 (attacker's left) lands on the LEFT of the screen, y < 0 on the right", () => {
  const left = toRink(OZ_SPOTS.point_left);
  const right = toRink(OZ_SPOTS.point_right);
  assert.ok(left.ok && right.ok);
  assert.ok(left.value.x < 0, "point_left is screen-left");
  assert.ok(right.value.x > 0, "point_right is screen-right");
  assert.equal(left.value.x, -right.value.x);
  assert.equal(left.value.y, right.value.y);
});

test("toRink: blue line is the bottom of the art, deeper spots sit higher", () => {
  const blue = toRink({ x: 25, y: 0 });
  const slot = toRink(OZ_SPOTS.slot);
  const point = toRink(OZ_SPOTS.point_middle);
  assert.ok(blue.ok && slot.ok && point.ok);
  assert.equal(blue.value.y, 75);
  assert.ok(slot.value.y < point.value.y);
});

test("toRink / fromRink round-trip every named spot", () => {
  for (const spot of Object.values(OZ_SPOTS)) {
    const there = toRink(spot);
    assert.ok(there.ok);
    const back = fromRink(there.value);
    assert.ok(back.ok);
    assert.deepEqual(back.value, { x: spot.x, y: spot.y + 0 });
  }
});

test("toRink / fromRink: non-finite input is an error, not NaN", () => {
  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.equal(toRink({ x: bad, y: 0 }).ok, false);
    assert.equal(toRink({ x: 50, y: bad }).ok, false);
    assert.equal(fromRink({ x: bad, y: 0 }).ok, false);
  }
});

test("toRinkPercent: centre line is 50% across, net is 11/77 down, corners clamp inside the box", () => {
  const net = toRinkPercent({ x: 89, y: 0 });
  assert.ok(net.ok);
  assert.equal(net.value.leftPct, 50);
  assert.ok(Math.abs(net.value.topPct - (11 / RINK_VIEWBOX.height) * 100) < 1e-9);
  const off = toRinkPercent({ x: 500, y: -500 });
  assert.ok(off.ok);
  assert.deepEqual(off.value, { leftPct: 100, topPct: 0 });
  const below = toRinkPercent({ x: -50, y: 500 });
  assert.ok(below.ok);
  assert.deepEqual(below.value, { leftPct: 0, topPct: 100 });
});

test("toRinkPercent: left point is left of 50%, and the board edge y = 42.5 is exactly 0%/100%", () => {
  const lp = toRinkPercent(OZ_SPOTS.point_left);
  assert.ok(lp.ok);
  assert.ok(lp.value.leftPct < 50);
  const edge = toRinkPercent({ x: 60, y: 42.5 });
  assert.ok(edge.ok);
  assert.equal(edge.value.leftPct, 0);
  assert.equal(toRinkPercent({ x: Number.NaN, y: 0 }).ok, false);
});

// ---------------------------------------------------------------- clock and scoreboard

test("formatClock: m:ss, pads seconds, floors fractions", () => {
  assert.equal(formatClock(0), "0:00");
  assert.equal(formatClock(59), "0:59");
  assert.equal(formatClock(60), "1:00");
  assert.equal(formatClock(125), "2:05");
  assert.equal(formatClock(1200), "20:00");
  assert.equal(formatClock(61.9), "1:01");
});

test("formatClock: negatives clamp, non-finite gives a visible placeholder", () => {
  assert.equal(formatClock(-5), "0:00");
  assert.equal(formatClock(Number.NaN), "--:--");
  assert.equal(formatClock(Infinity), "--:--");
});

test("scoreboardModel: fresh 5-on-4 shows full period, PP time from the engine and 5-on-4", () => {
  const input = fiveOnFour();
  const state = mustState(input);
  const m = scoreboardModel({ state, input });
  assert.ok(m.ok);
  assert.deepEqual(m.value.strength, { pp: 5, pk: 4 });
  assert.equal(m.value.periodNumber, state.clock.period);
  assert.notEqual(m.value.ppClock, null);
  const left = periodClockLeftS(state.clock, input.gameType);
  assert.ok(left.ok);
  assert.equal(m.value.periodClock, formatClock(left.value));
});

test("scoreboardModel: PP clock never exceeds the penalty length and never goes negative", () => {
  const input = fiveSecondsLeft();
  const state = mustState(input);
  const pp = ppRemainingS(state.penalties, state.clock, input.gameType);
  assert.ok(pp.ok);
  assert.ok(pp.value !== null && pp.value >= 0 && pp.value <= 120);
});

test("scoreboardModel: goalie pulled shows 6-on-4 (extra attacker)", () => {
  const input = sixOnFourGoaliePulled();
  const state = mustState(input);
  const m = scoreboardModel({ state, input });
  assert.ok(m.ok);
  assert.equal(m.value.strength.pp, 6);
});

test("scoreboardModel: regular-season OT counts down a 5-minute period", () => {
  const input = regOtFourOnThree();
  const state = mustState(input);
  const m = scoreboardModel({ state, input });
  assert.ok(m.ok);
  assert.equal(m.value.periodNumber, 4);
  const [mm] = m.value.periodClock.split(":");
  assert.ok(Number(mm) <= 5);
});

test("scoreboardModel: no advantage running gives a null PP clock", () => {
  const input = fiveOnFour();
  const state = { ...mustState(input), penalties: [] };
  const m = scoreboardModel({ state, input });
  assert.ok(m.ok);
  assert.equal(m.value.ppClock, null);
});

test("periodClockLeftS: out-of-range elapsed time is an error", () => {
  assert.equal(periodClockLeftS({ period: 1, elapsedS: 1201 }, 2).ok, false);
  assert.equal(periodClockLeftS({ period: 1, elapsedS: -1 }, 2).ok, false);
  assert.equal(periodClockLeftS({ period: 9, elapsedS: 0 }, 2).ok, false);
  const r = periodClockLeftS({ period: 1, elapsedS: 0 }, 2);
  assert.ok(r.ok);
  assert.equal(r.value, 1200);
});

// ---------------------------------------------------------------- option grouping (real engine)

test("groupOptions: a real decision yields pass, skate, shoot and set-play groups and nothing else", () => {
  const { options, state } = decisionState(fiveOnFour());
  const g = groupOptions(options);
  assert.equal(state.phase.kind, "decision");
  assert.ok(g.pass.length >= 1);
  assert.ok(g.skate.length >= 1);
  assert.ok(g.shoot.length >= SHOT_TYPES.length * SHOT_CORNERS.length);
  assert.ok(g.setPlay.length <= Object.keys(SET_PLAYS).length);
  assert.equal(g.faceoff.length + g.zoneEntry.length + g.breakout.length, 0);
  assert.equal(g.pass.length + g.skate.length + g.shoot.length + g.setPlay.length, options.length);
});

test("groupOptions: a faceoff pause groups only faceoff options; empty input gives empty groups", () => {
  const input = fiveOnFour();
  const state = mustState(input);
  const opts = legalCalls(state, input);
  assert.ok(opts.ok);
  const g = groupOptions(opts.value);
  assert.equal(g.faceoff.length, opts.value.length);
  assert.equal(g.pass.length, 0);
  const empty = groupOptions([]);
  assert.equal(Object.values(empty).flat().length, 0);
});

test("faceoffTakers: one row per taker with the engine's chance; findFaceoff needs the exact pair", () => {
  const input = fiveOnFour();
  const state = mustState(input);
  const opts = legalCalls(state, input);
  assert.ok(opts.ok);
  const g = groupOptions(opts.value);
  const takers = faceoffTakers(g.faceoff);
  assert.equal(takers.length, state.ppSpots.length);
  assert.equal(new Set(takers.map((x) => x.takerId)).size, takers.length);
  const first = takers[0];
  assert.ok(first !== undefined);
  assert.equal(findFaceoff(g.faceoff, first.takerId, "point")?.p, first.p);
  assert.equal(findFaceoff(g.faceoff, first.takerId, "nowhere"), null);
  assert.equal(findFaceoff(g.faceoff, -1, "point"), null);
  assert.deepEqual(faceoffTakers([]), []);
});

test("sortByChance: highest first, stable on ties, does not mutate", () => {
  const rows = [{ p: 0.2, k: "a" }, { p: 0.5, k: "b" }, { p: 0.2, k: "c" }, { p: 0.9, k: "d" }];
  const before = rows.map((r) => r.k).join("");
  assert.deepEqual(sortByChance(rows).map((r) => r.k), ["d", "b", "a", "c"]);
  assert.equal(rows.map((r) => r.k).join(""), before);
  assert.deepEqual(sortByChance([]), []);
});

test("limitRows: top six then the rest behind the expander", () => {
  const rows = [1, 2, 3, 4, 5, 6, 7, 8, 9];
  assert.deepEqual(limitRows(rows, false), { shown: [1, 2, 3, 4, 5, 6], hidden: 3 });
  assert.deepEqual(limitRows(rows, true), { shown: rows, hidden: 0 });
  assert.deepEqual(limitRows([1, 2], false), { shown: [1, 2], hidden: 0 });
  assert.deepEqual(limitRows([], false), { shown: [], hidden: 0 });
  assert.deepEqual(limitRows(rows, false, 0).shown.length, 6, "a bad cap falls back to the default");
  assert.deepEqual(limitRows(rows, false, 9), { shown: rows, hidden: 0 });
});

// ---------------------------------------------------------------- shot picker pricing

test("shot picker: every design type x corner is priced, wrap_around is never offered by the picker", () => {
  const { options } = decisionState(fiveOnFour());
  const { shoot } = groupOptions(options);
  for (const type of SHOT_TYPES) {
    for (const corner of SHOT_CORNERS) {
      assert.ok(shotTypeOption(shoot, type, corner) !== null, `${type} ${corner}`);
    }
  }
  assert.ok(shoot.some((o) => o.call.option === "wrap_around"), "engine still offers wrap_around");
  assert.ok(!(SHOT_TYPES as readonly string[]).includes("wrap_around"));
});

test("shotTypeOption: no corner = the type's best corner; a corner = that corner's price", () => {
  const { options } = decisionState(fiveOnFour());
  const { shoot } = groupOptions(options);
  const best = shotTypeOption(shoot, "wrist", null);
  assert.ok(best !== null);
  const wrist = shoot.filter((o) => o.call.option === "wrist");
  assert.equal(best.p, Math.max(...wrist.map((o) => o.p)));
  const tl = shotTypeOption(shoot, "wrist", "top_left");
  assert.equal(tl?.call.corner, "top_left");
  assert.ok(tl !== null && tl.p <= best.p);
});

test("shotTargetOption: no type = best design type for the corner; a type = that type", () => {
  const { options } = decisionState(fiveOnFour());
  const { shoot } = groupOptions(options);
  const best = shotTargetOption(shoot, null, "five_hole");
  assert.ok(best !== null);
  const designTypes = shoot.filter((o) => o.call.corner === "five_hole" && (SHOT_TYPES as readonly string[]).includes(o.call.option));
  assert.equal(best.p, Math.max(...designTypes.map((o) => o.p)));
  assert.notEqual(best.call.option, "wrap_around");
  assert.equal(shotTargetOption(shoot, "slap", "five_hole")?.call.option, "slap");
});

test("shotTypeOption / shotTargetOption: nothing offered gives null", () => {
  assert.equal(shotTypeOption([], "wrist", null), null);
  assert.equal(shotTypeOption([], "wrist", "top_left"), null);
  assert.equal(shotTargetOption([], null, "top_left"), null);
  assert.equal(shotTargetOption([], "snap", "top_left"), null);
});

test("shotSummary: goal is the option chance, on net and blocked come from the engine breakdown", () => {
  const { options } = decisionState(fiveOnFour());
  const { shoot } = groupOptions(options);
  const o = shoot[0];
  assert.ok(o !== undefined);
  const s = shotSummary(o);
  assert.ok(s !== null);
  assert.equal(s.goal, o.p);
  assert.equal(s.onNet, o.breakdown["pOnNet"]);
  assert.equal(s.blocked, o.breakdown["pBlocked"]);
  assert.ok(s.goal <= s.onNet + 1e-9, "a goal is on net");
});

test("shotSummary: null option gives null; missing breakdown prints as n/a, never a made-up number", () => {
  assert.equal(shotSummary(null), null);
  const bare = opt({ type: "shoot", option: "wrist", corner: "top_left" }, 0.1) as OptionOf<"shoot">;
  const s = shotSummary(bare);
  assert.ok(s !== null);
  assert.equal(s.goal, 0.1);
  assert.equal(pct(s.onNet), "n/a");
  assert.equal(pct(s.blocked), "n/a");
  const inf = opt({ type: "shoot", option: "wrist", corner: "top_left" }, 0.1, { breakdown: { pOnNet: Infinity } }) as OptionOf<"shoot">;
  assert.ok(Number.isNaN(shotSummary(inf)?.onNet));
});

test("shot copy: every type and corner has a real copy key; corner labels never name glove or blocker", () => {
  for (const type of SHOT_TYPES) assert.ok(hasCopy(SHOT_TYPE_COPY[type]), type);
  for (const corner of SHOT_CORNERS) {
    const label = t(CORNER_COPY[corner]);
    assert.ok(label.length > 0);
    assert.doesNotMatch(label, /glove|blocker/i, "catching hand is unknown in the export");
  }
});

// ---------------------------------------------------------------- set plays

test("set plays: every engine set play has copy and a thumbnail file in public/setplays", () => {
  assert.deepEqual([...SET_PLAY_IDS].sort(), Object.keys(SET_PLAYS).sort());
  for (const id of SET_PLAY_IDS) {
    const v = SET_PLAY_VIEW[id];
    assert.ok(hasCopy(v.nameKey) && hasCopy(v.subKey), id);
    const file = path.join(import.meta.dirname, "..", "..", "public", v.thumbnail);
    assert.ok(existsSync(file), `${v.thumbnail} exists`);
  }
});

test("set plays: the thumbnails are distinct per play", () => {
  const thumbs = SET_PLAY_IDS.map((id) => SET_PLAY_VIEW[id].thumbnail);
  assert.equal(new Set(thumbs).size, thumbs.length);
});

// ---------------------------------------------------------------- busy gating (edge 9)

test("canSendCall: only while paused for a call and nothing is in flight", () => {
  for (const machineState of ["faceoffCall", "zoneEntryCall", "breakoutCall", "decision"] as const) {
    assert.equal(canSendCall({ busy: false, machineState }), true, machineState);
    assert.equal(canSendCall({ busy: true, machineState }), false, `${machineState} busy`);
  }
  for (const machineState of ["intro", "celebrating", "ended", "error"] as const) {
    assert.equal(canSendCall({ busy: false, machineState }), false, machineState);
  }
});

test("optionDisabled: only a call in flight disables; clock-cut options stay playable (no dead end)", () => {
  assert.equal(optionDisabled({ cutByClock: false }, false), false);
  assert.equal(optionDisabled({ cutByClock: false }, true), true);
  assert.equal(optionDisabled({ cutByClock: true }, false), false);
  assert.equal(optionDisabled({ cutByClock: true }, true), true);
});

// ---------------------------------------------------------------- players and carrier

test("carrierOf: the PP carrier with its spot; none for a PK or loose puck", () => {
  const { state } = decisionState(fiveOnFour());
  const c = carrierOf({ state });
  assert.ok(c !== null);
  assert.ok(c.spot in OZ_SPOTS);
  assert.equal(carrierOf({ state: { ...state, carrier: { kind: "pk" } } }), null);
  assert.equal(carrierOf({ state: { ...state, carrier: { kind: "loose" } } }), null);
  assert.equal(carrierOf({ state: { ...state, carrier: { kind: "pp", id: -99 } } }), null);
});

test("playerLabel: scenario player first, engine name second, id last", () => {
  const input = fiveOnFour();
  const { state, options } = decisionState(input);
  const snap = snapshotOf(input, state, options);
  const id = input.pp.skaters[0]?.id;
  assert.ok(id !== undefined);
  assert.deepEqual(playerLabel(snap, id), { number: id, lastName: `Skater${id}` });
  const noScenario = { ...snap, scenario: { ...snap.scenario, players: {} } };
  const fromEngine = playerLabel(noScenario, id);
  assert.equal(fromEngine.number, null);
  assert.ok(fromEngine.lastName.length > 0 && !fromEngine.lastName.startsWith("#"));
  assert.deepEqual(playerLabel(noScenario, 424242), { number: null, lastName: "#424242" });
});

test("playerLabel: a null jersey number stays null", () => {
  const input = fiveOnFour();
  const { state, options } = decisionState(input);
  const snap = snapshotOf(input, state, options);
  const id = input.pp.skaters[0]?.id;
  assert.ok(id !== undefined);
  const players = { ...snap.scenario.players, [id]: { number: null, first: "A", last: "Lastname", pos: "C" } };
  assert.deepEqual(playerLabel({ ...snap, scenario: { ...snap.scenario, players } }, id), { number: null, lastName: "Lastname" });
});

// ---------------------------------------------------------------- strings

test("labelAfterPct: strips the percentage from the engine-facing templates", () => {
  assert.equal(labelAfterPct("{pct}% connects"), "connects");
  assert.equal(labelAfterPct("{pct}% keeps puck"), "keeps puck");
  assert.equal(pctLabel("pause.pass.row.pct"), "connects");
  assert.equal(pctLabel("pause.skate.row.pct"), "keeps puck");
  assert.equal(pctLabel("pause.setplay.row.pct"), "goal");
  assert.equal(pctLabel("faceoff.row.pct"), "wins the draw");
  assert.equal(pctLabel("entry.pct"), "gains the zone");
  assert.equal(playPctLabel("breakout.pct"), "gets out");
});

test("labelAfterPct: a template without a leading percentage throws", () => {
  assert.throws(() => labelAfterPct("connects"));
  assert.throws(() => labelAfterPct("{pct}%"));
  assert.throws(() => labelAfterPct(""));
});

test("fillCopy: fills variables, throws on a missing one", () => {
  assert.equal(fillCopy("play.pass.aria", { lastName: "Synth", number: 7 }), "Pass to Synth, 7");
  assert.equal(fillCopy("play.skate.more", { n: 3 }), "Show 3 more spots");
  assert.throws(() => fillCopy("play.skate.more"));
  for (const k of Object.keys(PLAY_COPY)) assert.ok(!hasCopy(k), `${k} is not shadowing lib/copy.ts`);
});
