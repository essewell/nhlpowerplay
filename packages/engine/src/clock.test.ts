/** Run from repo root: node --test packages/engine/src/clock.test.ts. Synthetic data only. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  absS, clockAt, endPeriod, expireUpTo, maxPpStrength, nextBoundaryS, periodLengthS, ppActive, ppEndS, releaseOnGoal,
  strengthOf,
} from "./clock.ts";
import { PENALTY_S, PERIOD_LENGTH_S, PLAYOFF_OT_LENGTH_S, REG_OT_LENGTH_S } from "./constants.ts";
import type { Result } from "./result.ts";
import type { Clock, Penalty, PenaltyKind, Side } from "./sim-types.ts";

const REG = 2 as const;
const PO = 3 as const;
const P = PERIOD_LENGTH_S;

const pen = (id: number, side: Side, kind: PenaltyKind, expiresAtS: number | null,
  durationS: number = PENALTY_S[kind]): Penalty => ({ id, side, kind, expiresAtS, durationS });
const coin = (id: number, side: Side, expiresAtS: number | null, kind: PenaltyKind = "minor"): Penalty =>
  ({ ...pen(id, side, kind, expiresAtS), coincidental: true });

function val<T>(r: Result<T>): T {
  if (!r.ok) assert.fail(`expected ok, got error: ${r.error}`);
  return r.value;
}
function isErr<T>(r: Result<T>): void {
  assert.equal(r.ok, false, `expected error, got ${JSON.stringify(r)}`);
}
const byId = (ps: Penalty[]): Penalty[] => [...ps].sort((a, b) => a.id - b.id);
const freeze = (ps: Penalty[]): Penalty[] => Object.freeze(ps.map((p) => Object.freeze({ ...p }))) as Penalty[];

// --- periodLengthS -----------------------------------------------------------
test("periodLengthS: regulation periods", () => {
  for (const p of [1, 2, 3]) {
    assert.equal(val(periodLengthS(p, REG)), P);
    assert.equal(val(periodLengthS(p, PO)), P);
  }
});
test("periodLengthS: regular-season OT is short", () => assert.equal(val(periodLengthS(4, REG)), REG_OT_LENGTH_S));
test("periodLengthS: playoff OTs are full length", () => {
  for (const p of [4, 5, 9]) assert.equal(val(periodLengthS(p, PO)), PLAYOFF_OT_LENGTH_S);
});
test("periodLengthS: shootout is not a period", () => {
  isErr(periodLengthS(5, REG));
  isErr(periodLengthS(6, REG));
});
test("periodLengthS: invalid periods", () => {
  for (const p of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    isErr(periodLengthS(p, REG));
    isErr(periodLengthS(p, PO));
  }
});

// --- absS -----------------------------------------------------------------------
test("absS: happy path", () => assert.equal(val(absS({ period: 2, elapsedS: 100 }, REG)), P + 100));
test("absS: game start and end of regulation", () => {
  assert.equal(val(absS({ period: 1, elapsedS: 0 }, REG)), 0);
  assert.equal(val(absS({ period: 3, elapsedS: P }, REG)), 3 * P);
});
test("absS: OT offsets", () => {
  assert.equal(val(absS({ period: 4, elapsedS: REG_OT_LENGTH_S }, REG)), 3 * P + REG_OT_LENGTH_S);
  assert.equal(val(absS({ period: 5, elapsedS: 10 }, PO)), 3 * P + PLAYOFF_OT_LENGTH_S + 10);
});
test("absS: elapsed out of range", () => {
  isErr(absS({ period: 1, elapsedS: -1 }, REG));
  isErr(absS({ period: 1, elapsedS: P + 1 }, REG));
  isErr(absS({ period: 4, elapsedS: REG_OT_LENGTH_S + 1 }, REG));
});
test("absS: non-integer elapsed", () => isErr(absS({ period: 1, elapsedS: 0.5 }, REG)));
test("absS: invalid period", () => {
  isErr(absS({ period: 0, elapsedS: 0 }, REG));
  isErr(absS({ period: 5, elapsedS: 0 }, REG));
});

// --- clockAt -------------------------------------------------------------------
test("clockAt: happy path", () => assert.deepEqual(val(clockAt(P + 100, REG)), { period: 2, elapsedS: 100 }));
test("clockAt: game start", () => assert.deepEqual(val(clockAt(0, REG)), { period: 1, elapsedS: 0 }));
test("clockAt: exact boundary is the END of the earlier period", () => {
  assert.deepEqual(val(clockAt(P, REG)), { period: 1, elapsedS: P });
  assert.deepEqual(val(clockAt(3 * P, REG)), { period: 3, elapsedS: P });
  assert.deepEqual(val(clockAt(3 * P + 1, REG)), { period: 4, elapsedS: 1 });
});
test("clockAt: regular season ends after OT", () => {
  assert.deepEqual(val(clockAt(3 * P + REG_OT_LENGTH_S, REG)), { period: 4, elapsedS: REG_OT_LENGTH_S });
  isErr(clockAt(3 * P + REG_OT_LENGTH_S + 1, REG));
});
test("clockAt: playoff multi-OT", () => {
  assert.deepEqual(val(clockAt(5 * P, PO)), { period: 5, elapsedS: P });
  assert.deepEqual(val(clockAt(5 * P + 1, PO)), { period: 6, elapsedS: 1 });
});
test("clockAt: invalid abs", () => {
  isErr(clockAt(-1, REG));
  isErr(clockAt(0.5, REG));
  isErr(clockAt(Number.NaN, PO));
});
test("clockAt is the inverse of absS", () => {
  for (const gt of [REG, PO]) {
    for (let a = 0; a <= 3 * P + REG_OT_LENGTH_S; a += 37) {
      const c = val(clockAt(a, gt));
      assert.equal(val(absS(c, gt)), a);
    }
  }
});

// --- strengthOf ------------------------------------------------------------------
test("strengthOf: even strength", () => assert.deepEqual(val(strengthOf([], false, 1, REG)), { pp: 5, pk: 5 }));
test("strengthOf: 5v4 and 5v3", () => {
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", 200)], false, 1, REG)), { pp: 5, pk: 4 });
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", 200), pen(2, "pk", "minor", 260)], false, 1, REG)),
    { pp: 5, pk: 3 });
});
test("strengthOf: queued penalty does not reduce below 3", () => {
  const ps = [pen(1, "pk", "minor", 200), pen(2, "pk", "minor", 260), pen(3, "pk", "minor", null)];
  assert.deepEqual(val(strengthOf(ps, false, 2, REG)), { pp: 5, pk: 3 });
});
test("strengthOf: 4v4 with one each", () => {
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", 200), pen(2, "pp", "minor", 220)], false, 1, REG)),
    { pp: 4, pk: 4 });
});
test("strengthOf: goalie pulled adds an attacker (6v4, 6v3)", () => {
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", 200)], true, 3, REG)), { pp: 6, pk: 4 });
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", 200), pen(2, "pk", "major", 400)], true, 3, REG)),
    { pp: 6, pk: 3 });
});
test("strengthOf: regular-season OT", () => {
  const t = 3 * P + 100;
  assert.deepEqual(val(strengthOf([], false, 4, REG)), { pp: 3, pk: 3 });
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", t)], false, 4, REG)), { pp: 4, pk: 3 });
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", t), pen(2, "pk", "minor", t + 9)], false, 4, REG)),
    { pp: 5, pk: 3 });
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", t), pen(2, "pp", "minor", t)], false, 4, REG)),
    { pp: 3, pk: 3 });
  assert.deepEqual(val(strengthOf([pen(1, "pp", "minor", t)], false, 4, REG)), { pp: 3, pk: 4 });
});
test("strengthOf: regular-season OT with goalie pulled caps at 6", () => {
  const t = 3 * P + 100;
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", t)], true, 4, REG)), { pp: 5, pk: 3 });
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", t), pen(2, "pk", "minor", t)], true, 4, REG)),
    { pp: 6, pk: 3 });
});
test("strengthOf: playoff OT is 5-on-5 based", () => {
  assert.deepEqual(val(strengthOf([pen(1, "pk", "minor", 5 * P)], false, 5, PO)), { pp: 5, pk: 4 });
});
test("strengthOf: too many active penalties on a side", () => {
  isErr(strengthOf([pen(1, "pk", "minor", 1), pen(2, "pk", "minor", 2), pen(3, "pk", "minor", 3)], false, 1, REG));
  isErr(strengthOf([pen(1, "pp", "minor", 1), pen(2, "pp", "minor", 2), pen(3, "pp", "minor", 3)], false, 1, REG));
});
test("strengthOf: invalid period", () => {
  isErr(strengthOf([], false, 5, REG));
  isErr(strengthOf([], false, 0, PO));
});

// --- ppActive -------------------------------------------------------------------
test("ppActive: one PK penalty", () => assert.equal(ppActive([pen(1, "pk", "minor", 100)]), true));
test("ppActive: edge cases", () => {
  assert.equal(ppActive([]), false);
  assert.equal(ppActive([pen(1, "pk", "minor", 100), pen(2, "pp", "minor", 100)]), false);
  assert.equal(ppActive([pen(1, "pk", "minor", null)]), false); // queued only (malformed but safe)
  assert.equal(ppActive([pen(1, "pp", "minor", 100)]), false);
  assert.equal(ppActive([pen(1, "pk", "minor", 100), pen(2, "pk", "minor", 120), pen(3, "pp", "minor", 90)]), true);
});

// --- expireUpTo -----------------------------------------------------------------
test("expireUpTo: removes expired, keeps the rest", () => {
  const ps = [pen(1, "pk", "minor", 100), pen(2, "pk", "minor", 150)];
  assert.deepEqual(expireUpTo(ps, 120, false), [pen(2, "pk", "minor", 150)]);
});
test("expireUpTo: penalty expiring exactly at t is still active after the non-inclusive call", () => {
  const ps = [pen(1, "pk", "minor", 100)];
  assert.deepEqual(expireUpTo(ps, 100, false), ps);
  assert.equal(ppActive(expireUpTo(ps, 100, false)), true);
  assert.deepEqual(expireUpTo(ps, 100, true), []);
});
test("expireUpTo: queued penalty starts when the first expires", () => {
  const ps = [pen(1, "pk", "minor", 100), pen(2, "pk", "minor", 150), pen(3, "pk", "minor", null)];
  assert.deepEqual(byId(expireUpTo(ps, 120, false)),
    [pen(2, "pk", "minor", 150), pen(3, "pk", "minor", 100 + PENALTY_S.minor)]);
});
test("expireUpTo: several expiries in one call, chronological", () => {
  const ps = [pen(1, "pk", "minor", 100), pen(2, "pk", "minor", 150), pen(3, "pk", "minor", null)];
  assert.deepEqual(expireUpTo(ps, 200, false), [pen(3, "pk", "minor", 220)]);
  assert.deepEqual(expireUpTo(ps, 220, false), [pen(3, "pk", "minor", 220)]);
  assert.deepEqual(expireUpTo(ps, 220, true), []);
});
test("expireUpTo: queued promoted in id order, each into the slot freed first", () => {
  const ps = [pen(1, "pk", "minor", 100), pen(2, "pk", "major", 400),
    pen(6, "pk", "double_minor", null), pen(5, "pk", "minor", null)];
  const out = byId(expireUpTo(ps, 101, false));
  assert.deepEqual(out, [pen(2, "pk", "major", 400), pen(5, "pk", "minor", 220), pen(6, "pk", "double_minor", null)]);
  const later = byId(expireUpTo(ps, 230, false));
  assert.deepEqual(later, [pen(2, "pk", "major", 400), pen(6, "pk", "double_minor", 220 + PENALTY_S.double_minor)]);
});
test("expireUpTo: a PP-side queue does not fill a PK slot", () => {
  const ps = [pen(1, "pk", "minor", 100), pen(2, "pp", "minor", 150), pen(3, "pp", "minor", 160),
    pen(4, "pp", "minor", null)];
  assert.deepEqual(byId(expireUpTo(ps, 120, false)),
    [pen(2, "pp", "minor", 150), pen(3, "pp", "minor", 160), pen(4, "pp", "minor", null)]);
});
test("expireUpTo: empty and nothing-due inputs", () => {
  assert.deepEqual(expireUpTo([], 500, true), []);
  const ps = [pen(1, "pk", "minor", 100)];
  assert.deepEqual(expireUpTo(ps, 50, true), ps);
});
test("expireUpTo: does not mutate its input", () => {
  const ps = freeze([pen(1, "pk", "minor", 100), pen(2, "pk", "minor", 150), pen(3, "pk", "minor", null)]);
  const snapshot = JSON.stringify(ps);
  expireUpTo(ps, 1000, true);
  assert.equal(JSON.stringify(ps), snapshot);
});

// --- releaseOnGoal ---------------------------------------------------------------
test("releaseOnGoal: PP goal ends a single minor", () => {
  assert.deepEqual(releaseOnGoal([pen(1, "pk", "minor", 200)], 150), []);
});
test("releaseOnGoal: goal at 5v3 releases only the earlier minor", () => {
  const ps = [pen(1, "pk", "minor", 260), pen(2, "pk", "minor", 200)];
  assert.deepEqual(releaseOnGoal(ps, 150), [pen(1, "pk", "minor", 260)]);
});
test("releaseOnGoal: double minor with 150 s left drops to one minor; with 90 s left ends", () => {
  const goal = 1000;
  assert.deepEqual(releaseOnGoal([pen(1, "pk", "double_minor", goal + 150)], goal),
    [pen(1, "pk", "double_minor", goal + PENALTY_S.minor)]);
  assert.deepEqual(releaseOnGoal([pen(1, "pk", "double_minor", goal + 90)], goal), []);
  assert.deepEqual(releaseOnGoal([pen(1, "pk", "double_minor", goal + PENALTY_S.minor)], goal), []);
});
test("releaseOnGoal: a major survives a goal", () => {
  const ps = [pen(1, "pk", "major", 500)];
  assert.deepEqual(releaseOnGoal(ps, 100), ps);
});
test("releaseOnGoal: major + later minor -> the minor is released, major stays", () => {
  const ps = [pen(1, "pk", "major", 300), pen(2, "pk", "minor", 400)];
  assert.deepEqual(releaseOnGoal(ps, 100), [pen(1, "pk", "major", 300)]);
});
test("releaseOnGoal: queued PK penalty starts at the goal second", () => {
  const ps = [pen(1, "pk", "minor", 200), pen(2, "pk", "minor", 260), pen(3, "pk", "minor", null)];
  assert.deepEqual(byId(releaseOnGoal(ps, 150)), [pen(2, "pk", "minor", 260), pen(3, "pk", "minor", 270)]);
});
test("releaseOnGoal: no release without a numerical advantage (4v4)", () => {
  const ps = [pen(1, "pk", "minor", 200), pen(2, "pp", "minor", 210)];
  assert.deepEqual(releaseOnGoal(ps, 150), ps);
});
test("releaseOnGoal: ties broken by lowest id; PP penalties untouched", () => {
  const ps = [pen(4, "pk", "minor", 200), pen(3, "pk", "minor", 200), pen(9, "pp", "minor", 180)];
  assert.deepEqual(releaseOnGoal(ps, 150), [pen(4, "pk", "minor", 200), pen(9, "pp", "minor", 180)]);
});
test("releaseOnGoal: goal at the exact expiry second still releases it", () => {
  assert.deepEqual(releaseOnGoal([pen(1, "pk", "minor", 200)], 200), []);
});
test("releaseOnGoal: empty input and no mutation", () => {
  assert.deepEqual(releaseOnGoal([], 10), []);
  const ps = freeze([pen(1, "pk", "double_minor", 400), pen(2, "pk", "minor", null)]);
  const snapshot = JSON.stringify(ps);
  releaseOnGoal(ps, 100);
  assert.equal(JSON.stringify(ps), snapshot);
});

// --- ppEndS ----------------------------------------------------------------------
test("ppEndS: single minor", () => assert.equal(ppEndS([pen(1, "pk", "minor", 500)]), 500));
test("ppEndS: no advantage -> null", () => {
  assert.equal(ppEndS([]), null);
  assert.equal(ppEndS([pen(1, "pk", "minor", 500), pen(2, "pp", "minor", 520)]), null);
});
test("ppEndS: 5v3 lasts until the later expiry", () => {
  assert.equal(ppEndS([pen(1, "pk", "minor", 500), pen(2, "pk", "minor", 560)]), 560);
});
test("ppEndS: accounts for queued promotions", () => {
  const ps = [pen(1, "pk", "minor", 500), pen(2, "pk", "minor", 560), pen(3, "pk", "minor", null)];
  assert.equal(ppEndS(ps), 500 + PENALTY_S.minor);
});
test("ppEndS: ends when a PP penalty outlasts the PK's extra man", () => {
  // 4v3 (pk 2, pp 1): at 500 one PK penalty ends -> 4v4.
  const ps = [pen(1, "pk", "minor", 500), pen(2, "pk", "minor", 600), pen(3, "pp", "minor", 550)];
  assert.equal(ppEndS(ps), 500);
});
test("ppEndS: PP penalty expiring first just widens the advantage (4v3 -> 5v3 -> 5v4)", () => {
  const ps = [pen(1, "pk", "major", 600), pen(2, "pp", "minor", 300), pen(3, "pk", "minor", 400)];
  assert.equal(ppEndS(ps), 600);
});
test("ppEndS: simultaneous expiries end at that second", () => {
  assert.equal(ppEndS([pen(1, "pk", "minor", 500), pen(2, "pk", "minor", 500)]), 500);
});

// --- nextBoundaryS ---------------------------------------------------------------
test("nextBoundaryS: PP ends before the period", () => {
  assert.equal(val(nextBoundaryS([pen(1, "pk", "minor", 300)], { period: 1, elapsedS: 200 }, REG)), 300);
});
test("nextBoundaryS: period ends before the PP (carry-over)", () => {
  assert.equal(val(nextBoundaryS([pen(1, "pk", "minor", P + 60)], { period: 1, elapsedS: 1140 }, REG)), P);
});
test("nextBoundaryS: no PP -> end of period", () => {
  assert.equal(val(nextBoundaryS([], { period: 2, elapsedS: 10 }, REG)), 2 * P);
});
test("nextBoundaryS: regular-season OT and playoff OT ends", () => {
  assert.equal(val(nextBoundaryS([], { period: 4, elapsedS: 0 }, REG)), 3 * P + REG_OT_LENGTH_S);
  assert.equal(val(nextBoundaryS([], { period: 5, elapsedS: 0 }, PO)), 5 * P);
});
test("nextBoundaryS: tie between PP end and period end", () => {
  assert.equal(val(nextBoundaryS([pen(1, "pk", "minor", P)], { period: 1, elapsedS: 1100 }, REG)), P);
});
test("nextBoundaryS: invalid clock", () => {
  isErr(nextBoundaryS([], { period: 5, elapsedS: 0 }, REG));
  isErr(nextBoundaryS([], { period: 1, elapsedS: -5 }, REG));
});

// --- endPeriod -------------------------------------------------------------------
const endOf = (period: number, gt: 2 | 3): Clock => ({ period, elapsedS: val(periodLengthS(period, gt)) });
test("endPeriod: periods 1 and 2 roll over regardless of score", () => {
  assert.deepEqual(val(endPeriod(endOf(1, REG), { pp: 0, pk: 0 }, REG)), { next: { period: 2, elapsedS: 0 } });
  assert.deepEqual(val(endPeriod(endOf(2, PO), { pp: 3, pk: 1 }, PO)), { next: { period: 3, elapsedS: 0 } });
});
test("endPeriod: end of regulation", () => {
  assert.deepEqual(val(endPeriod(endOf(3, REG), { pp: 2, pk: 1 }, REG)), { ended: "regulation_end" });
  assert.deepEqual(val(endPeriod(endOf(3, PO), { pp: 0, pk: 1 }, PO)), { ended: "regulation_end" });
});
test("endPeriod: tied after regulation -> OT", () => {
  assert.deepEqual(val(endPeriod(endOf(3, REG), { pp: 1, pk: 1 }, REG)), { next: { period: 4, elapsedS: 0 } });
  assert.deepEqual(val(endPeriod(endOf(3, PO), { pp: 1, pk: 1 }, PO)), { next: { period: 4, elapsedS: 0 } });
});
test("endPeriod: regular-season OT tied -> shootout", () => {
  assert.deepEqual(val(endPeriod(endOf(4, REG), { pp: 2, pk: 2 }, REG)), { ended: "shootout" });
});
test("endPeriod: playoff OT tied -> next OT", () => {
  assert.deepEqual(val(endPeriod(endOf(4, PO), { pp: 2, pk: 2 }, PO)), { next: { period: 5, elapsedS: 0 } });
  assert.deepEqual(val(endPeriod(endOf(7, PO), { pp: 0, pk: 0 }, PO)), { next: { period: 8, elapsedS: 0 } });
});
test("endPeriod: errors", () => {
  isErr(endPeriod(endOf(4, REG), { pp: 3, pk: 2 }, REG)); // untied OT: goal should have ended it
  isErr(endPeriod(endOf(5, PO), { pp: 1, pk: 2 }, PO));
  isErr(endPeriod({ period: 1, elapsedS: 600 }, { pp: 0, pk: 0 }, REG)); // not at the end
  isErr(endPeriod({ period: 5, elapsedS: 0 }, { pp: 0, pk: 0 }, REG)); // shootout is not a period
  isErr(endPeriod({ period: 0, elapsedS: 0 }, { pp: 0, pk: 0 }, PO));
});

// --- scenarios -------------------------------------------------------------------
test("scenario: 5v3 staggered expiries -> 5v4 -> even", () => {
  let ps = [pen(1, "pk", "minor", 500), pen(2, "pk", "minor", 560)];
  assert.deepEqual(val(strengthOf(ps, false, 1, REG)), { pp: 5, pk: 3 });
  ps = expireUpTo(ps, 500, false);
  assert.deepEqual(val(strengthOf(ps, false, 1, REG)), { pp: 5, pk: 3 });
  ps = expireUpTo(ps, 500, true);
  assert.deepEqual(val(strengthOf(ps, false, 1, REG)), { pp: 5, pk: 4 });
  ps = expireUpTo(ps, 560, true);
  assert.deepEqual(val(strengthOf(ps, false, 1, REG)), { pp: 5, pk: 5 });
  assert.equal(ppActive(ps), false);
});
test("scenario: third penalty queues then starts when the first expires", () => {
  let ps = [pen(1, "pk", "minor", 500), pen(2, "pk", "minor", 560), pen(3, "pk", "minor", null)];
  assert.deepEqual(val(strengthOf(ps, false, 1, REG)), { pp: 5, pk: 3 });
  ps = expireUpTo(ps, 500, true);
  assert.deepEqual(val(strengthOf(ps, false, 1, REG)), { pp: 5, pk: 3 });
  assert.equal(ps.find((p) => p.id === 3)?.expiresAtS, 620);
  ps = expireUpTo(ps, 560, true);
  assert.deepEqual(val(strengthOf(ps, false, 1, REG)), { pp: 5, pk: 4 });
  assert.equal(ppEndS(ps), 620);
});
test("scenario: carry-over from period 1 to 2 via absolute time", () => {
  const called = val(absS({ period: 1, elapsedS: 1140 }, REG));
  const ps = [pen(1, "pk", "minor", called + PENALTY_S.minor)];
  const boundary = val(nextBoundaryS(ps, { period: 1, elapsedS: 1140 }, REG));
  assert.equal(boundary, P);
  const next = val(endPeriod(val(clockAt(boundary, REG)), { pp: 0, pk: 0 }, REG));
  assert.ok("next" in next);
  const after = expireUpTo(ps, boundary, true);
  assert.equal(ppActive(after), true);
  assert.equal(ppEndS(after), P + 60);
  assert.deepEqual(val(clockAt(P + 60, REG)), { period: 2, elapsedS: 60 });
});
test("scenario: regular-season OT 5v4 carry-over yields 4v3", () => {
  const ps = [pen(1, "pk", "minor", 3 * P + 45)];
  assert.deepEqual(val(strengthOf(ps, false, 3, REG)), { pp: 5, pk: 4 });
  assert.deepEqual(val(strengthOf(ps, false, 4, REG)), { pp: 4, pk: 3 });
  assert.equal(val(nextBoundaryS(ps, { period: 4, elapsedS: 0 }, REG)), 3 * P + 45);
});
test("scenario: 6v4 with goalie pulled, goal releases the minor -> 6v5", () => {
  let ps = [pen(1, "pk", "minor", 3400)];
  assert.deepEqual(val(strengthOf(ps, true, 3, REG)), { pp: 6, pk: 4 });
  ps = releaseOnGoal(ps, 3350);
  assert.deepEqual(val(strengthOf(ps, true, 3, REG)), { pp: 6, pk: 5 });
});
test("scenario: playoff 2nd OT", () => {
  const start = val(absS({ period: 5, elapsedS: 0 }, PO));
  assert.equal(start, 4 * P);
  const ps = [pen(1, "pk", "double_minor", start + 100)];
  assert.deepEqual(val(strengthOf(ps, false, 5, PO)), { pp: 5, pk: 4 });
  assert.equal(val(nextBoundaryS(ps, { period: 5, elapsedS: 0 }, PO)), start + 100);
  assert.deepEqual(val(endPeriod({ period: 5, elapsedS: P }, { pp: 1, pk: 1 }, PO)), { next: { period: 6, elapsedS: 0 } });
});
test("determinism: same inputs give identical outputs", () => {
  const ps = [pen(1, "pk", "minor", 500), pen(2, "pk", "double_minor", 560), pen(3, "pk", "minor", null)];
  assert.deepEqual(expireUpTo(ps, 700, true), expireUpTo(ps, 700, true));
  assert.deepEqual(releaseOnGoal(ps, 450), releaseOnGoal(ps, 450));
  assert.equal(ppEndS(ps), ppEndS(ps));
});

// --- maxPpStrength -----------------------------------------------------------
const P2 = (e: number): Clock => ({ period: 2, elapsedS: e });
const abs2 = (e: number) => P + e;
test("maxPpStrength: plain 5v4 stays 5", () => {
  assert.equal(val(maxPpStrength([pen(1, "pk", "minor", abs2(400))], false, P2(300), REG)), 5);
});
test("maxPpStrength: 4v3 whose PP minor ends first reaches 5 (5v3)", () => {
  const ps = [pen(1, "pp", "minor", abs2(330)), pen(2, "pk", "minor", abs2(390)), pen(3, "pk", "minor", abs2(420))];
  assert.equal(val(strengthOf(ps, false, 2, REG)).pp, 4);
  assert.equal(val(maxPpStrength(ps, false, P2(300), REG)), 5);
});
test("maxPpStrength edge: PP minor outlasting the advantage never lifts the PP", () => {
  // 4v3 -> 4v4 at +90: the advantage is over before the PP minor ends at +200.
  const ps = [pen(1, "pp", "minor", abs2(500)), pen(2, "pk", "minor", abs2(390)), pen(3, "pk", "minor", abs2(420))];
  assert.equal(val(maxPpStrength(ps, false, P2(300), REG)), 4);
});
test("maxPpStrength edge: goalie pulled counts the extra attacker", () => {
  assert.equal(val(maxPpStrength([pen(1, "pk", "minor", abs2(400))], true, P2(300), REG)), 6);
  const ps = [pen(1, "pp", "minor", abs2(330)), pen(2, "pk", "minor", abs2(390)), pen(3, "pk", "minor", abs2(420))];
  assert.equal(val(maxPpStrength(ps, true, P2(300), REG)), 6);
});
test("maxPpStrength edge: a queued PP penalty promoted on expiry keeps the PP short-handed", () => {
  // PP minor 1 expires at +30 and the queued PP minor 4 is promoted in its place, so the PP stays at 4.
  const ps = [pen(1, "pp", "minor", abs2(330)), pen(4, "pp", "minor", null),
    pen(2, "pk", "minor", abs2(390)), pen(3, "pk", "minor", abs2(420))];
  assert.equal(val(maxPpStrength(ps, false, P2(300), REG)), 4);
});
test("maxPpStrength edge: crossing from P3 into regular-season OT and past its end does not error", () => {
  const ps = [pen(1, "pk", "minor", 3 * P + 100)];
  assert.equal(val(maxPpStrength(ps, false, { period: 3, elapsedS: P - 10 }, REG)), 5);
  // starts in OT 4v3, penalty outlives the 5-minute OT
  const ot = [pen(1, "pk", "minor", 3 * P + REG_OT_LENGTH_S + 60)];
  assert.equal(val(maxPpStrength(ot, false, { period: 4, elapsedS: REG_OT_LENGTH_S - 10 }, REG)), 4);
});
test("maxPpStrength edge: playoff OT periods carry on", () => {
  const ps = [pen(1, "pk", "minor", 4 * P + 50)];
  assert.equal(val(maxPpStrength(ps, false, { period: 4, elapsedS: P - 5 }, PO)), 5);
});
test("maxPpStrength edge: invalid clock or too many active penalties is an error", () => {
  isErr(maxPpStrength([pen(1, "pk", "minor", 999)], false, { period: 0, elapsedS: 0 }, REG));
  isErr(maxPpStrength([pen(1, "pk", "minor", abs2(400)), pen(2, "pk", "minor", abs2(410)), pen(3, "pk", "minor", abs2(420))],
    false, P2(300), REG));
});
test("maxPpStrength edge: no power play returns the current strength", () => {
  assert.equal(val(maxPpStrength([], false, P2(300), REG)), 5);
  assert.equal(val(maxPpStrength([pen(1, "pp", "minor", abs2(400))], false, P2(300), REG)), 4);
});

// --- coincidental penalties (NHL Rule 19.1 / 16.2) ---------------------------------
test("coincidental: Table 12 G4 shape - goal releases the regular minor, not the coincidental one with less time left", () => {
  const ps = [coin(1, "pk", 160), coin(2, "pp", 160), pen(3, "pk", "minor", 220)];
  assert.equal(ppActive(ps), true);
  assert.deepEqual(byId(releaseOnGoal(ps, 100)), [coin(1, "pk", 160), coin(2, "pp", 160)]);
});
test("coincidental: pair + one PK minor is 4v3, goal returns it to 4v4 (no advantage), pair stays on the clock", () => {
  const ps = [coin(1, "pk", 160), coin(2, "pp", 160), pen(3, "pk", "minor", 220)];
  assert.deepEqual(val(strengthOf(ps, false, 1, REG)), { pp: 4, pk: 3 });
  const after = releaseOnGoal(ps, 100);
  assert.deepEqual(val(strengthOf(after, false, 1, REG)), { pp: 4, pk: 4 });
  assert.equal(ppActive(after), false);
  assert.equal(ppEndS(after), null);
  assert.deepEqual(releaseOnGoal(after, 110), after);
});
test("coincidental: pair alone is not a power play; strength is 4v4", () => {
  const ps = [coin(1, "pk", 160), coin(2, "pp", 160)];
  assert.equal(ppActive(ps), false);
  assert.equal(ppEndS(ps), null);
  assert.deepEqual(val(strengthOf(ps, false, 1, REG)), { pp: 4, pk: 4 });
});
test("coincidental: only coincidental PK seats on a PP -> nothing to release", () => {
  const ps = [coin(1, "pk", 160), coin(3, "pk", 200)];
  assert.equal(ppActive(ps), true);
  assert.deepEqual(releaseOnGoal(ps, 100), ps);
});
test("coincidental: pair + major -> major stays, coincidental stays", () => {
  const ps = [coin(1, "pk", 160), coin(2, "pp", 160), pen(3, "pk", "major", 400)];
  assert.deepEqual(releaseOnGoal(ps, 100), ps);
});
test("coincidental: a queued regular minor is promoted when the regular one is released; ties by lowest id", () => {
  const ps = [coin(1, "pk", 160), coin(2, "pp", 160), pen(3, "pk", "minor", 200), pen(4, "pk", "minor", null)];
  assert.deepEqual(byId(releaseOnGoal(ps, 100)), [coin(1, "pk", 160), coin(2, "pp", 160), pen(4, "pk", "minor", 220)]);
  const tie = [coin(1, "pk", 200), coin(2, "pp", 200), pen(9, "pk", "minor", 200), pen(5, "pk", "minor", 200)];
  assert.deepEqual(byId(releaseOnGoal(tie, 100)).map((p) => p.id), [1, 2, 9]);
});
test("coincidental: a coincidental double minor is not cut by a goal", () => {
  const ps = [coin(1, "pk", 400, "double_minor"), coin(2, "pp", 400, "double_minor"), pen(3, "pk", "minor", 300)];
  assert.deepEqual(byId(releaseOnGoal(ps, 100)), [coin(1, "pk", 400, "double_minor"), coin(2, "pp", 400, "double_minor")]);
});
test("coincidental: seats expire like any penalty; ppEndS and maxPpStrength count them", () => {
  const ps = [coin(1, "pk", 160), coin(2, "pp", 160), pen(3, "pk", "minor", 220)];
  assert.equal(ppEndS(ps), 220);
  assert.equal(val(maxPpStrength(ps, false, { period: 1, elapsedS: 100 }, REG)), 5);
  assert.deepEqual(expireUpTo(ps, 160, true), [pen(3, "pk", "minor", 220)]);
});
test("coincidental: releaseOnGoal does not mutate its input and keeps the flag", () => {
  const ps = freeze([coin(1, "pk", 160), coin(2, "pp", 160), pen(3, "pk", "minor", 220)]);
  const snapshot = JSON.stringify(ps);
  const out = releaseOnGoal(ps, 100);
  assert.equal(JSON.stringify(ps), snapshot);
  assert.equal(out.every((p) => p.coincidental === true), true);
});
