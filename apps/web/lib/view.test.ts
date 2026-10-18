import { test } from "node:test";
import assert from "node:assert/strict";
import { parseScenario } from "@powerplay/engine/schema.ts";
import { gameNumberFromId, stageText, toScenarioView } from "./view.ts";
import { makeFiles, SCENARIO_A } from "./testing/fixtures.ts";

function scenario(patch: (d: Record<string, any>) => void = () => {}) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const raw = JSON.parse(makeFiles().get(`scenarios/${SCENARIO_A}.json`) as string);
  patch(raw);
  const r = parseScenario(raw);
  if (!r.ok) throw new Error(r.error);
  return r.value;
}

test("view: happy path maps the synthetic scenario", () => {
  const v = toScenarioView(scenario());
  assert.equal(v.id, SCENARIO_A);
  assert.deepEqual(v.teams, { pp: "BBB", pk: "AAA" });
  assert.deepEqual(v.score, { pp: 1, pk: 1 });
  assert.equal(v.period, 2);
  assert.equal(v.clockElapsedS, 600);
  assert.deepEqual(v.strength, { pp: 5, pk: 4 });
  assert.equal(v.stageText, "Playoffs");
  assert.equal(v.gameNumber, 1);
  assert.equal(v.stakes, "Invented demo power play (synthetic, not a real game)");
});

test("view: players include skaters, bench and both goalies", () => {
  const v = toScenarioView(scenario());
  assert.equal(Object.keys(v.players).length, 5 + 1 + 1 + 4 + 1);
  assert.deepEqual(v.players[9900001], { number: 11, first: "Testa", last: "Alpha", pos: "C" });
  assert.equal(v.players[9900007]?.pos, "D", "bench skater present");
  assert.equal(v.players[9900006]?.pos, "G");
  assert.equal(v.players[9900105]?.pos, "G");
});

test("view edge: stage code map, SCF shows as Final, unknown -> null", () => {
  assert.equal(stageText("P"), "Playoffs");
  assert.equal(stageText("R"), "Playoffs");
  assert.equal(stageText("CONF_FINAL"), "Conference Final");
  assert.equal(stageText("SCF"), "Final");
  assert.equal(stageText("???"), null);
  assert.equal(stageText("constructor"), null, "prototype keys are not stage codes");
  assert.equal(toScenarioView(scenario((d) => { d.game.stage = "WHAT"; })).stageText, null);
});

test("view edge: game number from NHL playoff ids (synthetic ids)", () => {
  assert.equal(gameNumberFromId(9999030111, 3), 1);
  assert.equal(gameNumberFromId(9999030117, 3), 7);
  assert.equal(gameNumberFromId(9999030234, 3), 4);
});

test("view edge: game number is null for regular season, bad length, wrong type digits, game 0", () => {
  assert.equal(gameNumberFromId(9999020117, 2), null, "regular season game type");
  assert.equal(gameNumberFromId(9999030117, 2), null, "game_type says regular season");
  assert.equal(gameNumberFromId(9999020117, 3), null, "type digits are 02");
  assert.equal(gameNumberFromId(99990301, 3), null, "too short");
  assert.equal(gameNumberFromId(99990301170, 3), null, "too long");
  assert.equal(gameNumberFromId(9999030110, 3), null, "game digit 0");
  assert.equal(gameNumberFromId(Number.NaN, 3), null);
  assert.equal(gameNumberFromId(-9999030117, 3), null);
});

test("view edge: stakes come from the narrative only; missing narrative -> null", () => {
  const sc = scenario();
  const noNarrative = { ...sc } as Record<string, unknown>;
  delete noNarrative.narrative;
  assert.equal(toScenarioView(noNarrative as unknown as typeof sc).stakes, null);
  assert.equal(toScenarioView({ ...sc, narrative: { title: "", sources: sc.narrative.sources } }).stakes, null);
});

test("view edge: scenario without a bench still builds", () => {
  const v = toScenarioView(scenario((d) => { delete d.pp.bench; }));
  assert.equal(v.players[9900007], undefined);
  assert.equal(Object.keys(v.players).length, 11);
});
