"use client";

/**
 * Non-decision calls: the opening faceoff (taker x target), the zone entry (carry / drop / dump) and the
 * breakout (only when settings.askEveryTouch). Same look as the decision sheet. Every control is
 * disabled while `snapshot.busy` (edge 9). Mount with key={calls.length} to reset the selection.
 * UI thread only.
 */
import { useMemo, useState } from "react";
import { pct } from "@powerplay/engine/likelihood.ts";
import type { Call, EntryLane, PpFormationName } from "@powerplay/engine/sim-types.ts";
import { Button } from "../ui/Button.tsx";
import { OptionRow } from "../ui/OptionRow.tsx";
import { StateCard } from "../ui/StateCard.tsx";
import { cx, FOCUS_RING } from "../ui/cx.ts";
import type { RunSnapshot } from "../../lib/contracts.ts";
import { t, type CopyKey } from "../../lib/copy.ts";
import {
  bestLaneChance, currentSetup, defaultEntryLane, ENTRY_LANES, entryLanes, entryMethods, entryOption,
  FACEOFF_TARGET_COPY, faceoffTakers, findFaceoff, groupOptions, optionDisabled, playerLabel, ppOnIce, sortByChance,
  withFormation,
} from "../../lib/play/options.ts";
import { scoreboardModel } from "../../lib/play/scoreboard.ts";
import { fillCopy, pctLabel, playPctLabel, PLAY_COPY, type PlayCopyKey } from "../../lib/play/strings.ts";
import { FormationPicker } from "./FormationPicker.tsx";
import { Scoreboard } from "./Scoreboard.tsx";

/** Screen-reader name for a call button: "Alpha, 11, 50% wins the draw". Skips empty parts. O(1). */
function callLabel(parts: readonly (string | number | null)[], p: number, word: string): string {
  const named = parts.filter((x): x is string | number => x !== null && x !== "");
  return `${named.join(", ")}, ${pct(p)} ${word}`;
}

interface Props {
  snapshot: RunSnapshot;
  onCall: (call: Call) => void;
  /** Outcome of the last call (OutcomeTicker), shown under the scoreboard. */
  ticker?: React.ReactNode;
}

function Shell({ snapshot, title, body, ticker, children }: { snapshot: RunSnapshot; title: string; body: string; ticker?: React.ReactNode; children: React.ReactNode }) {
  const board = scoreboardModel(snapshot);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col">
      <div className="flex flex-col gap-2.5 px-4 pb-2.5 pt-3.5">
        {board.ok ? <Scoreboard teams={snapshot.scenario.teams} model={board.value} /> : null}
        {ticker}
      </div>
      <section
        aria-busy={snapshot.busy}
        className="mt-3.5 flex flex-1 flex-col gap-3 rounded-t-sheet border-t border-border bg-surface px-4 pb-5 pt-4"
      >
        <div className="flex flex-col gap-1">
          <h1 className="m-0 font-display text-[22px] font-bold uppercase tracking-[0.04em]">{title}</h1>
          <p className="m-0 text-sm leading-[1.45] text-text-soft">{body}</p>
        </div>
        {children}
      </section>
    </div>
  );
}

export function FaceoffSheet({ snapshot, onCall, ticker }: Props) {
  const [takerId, setTakerId] = useState<number | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const setup = currentSetup(snapshot);
  const [formation, setFormation] = useState<PpFormationName>(setup.formation);
  // The setup only matters when the PP wins a draw in the offensive zone; a centre-ice draw starts a fresh entry.
  const offensiveDraw = snapshot.phase.kind === "faceoff" && snapshot.phase.dot !== "centre";
  const faceoff = useMemo(() => groupOptions(snapshot.options).faceoff, [snapshot.options]);
  const takers = sortByChance(faceoffTakers(faceoff));
  const chosen = takerId !== null && target !== null ? findFaceoff(faceoff, takerId, target) : null;
  const canDrop = chosen !== null && !optionDisabled(chosen, snapshot.busy);
  const targets = Object.keys(FACEOFF_TARGET_COPY) as (keyof typeof FACEOFF_TARGET_COPY)[];

  return (
    <Shell snapshot={snapshot} title={t("faceoff.title")} body={t("faceoff.body")} ticker={ticker}>
      {takers.length === 0 ? (
        <StateCard kind="error" title={t("faceoff.error.title")} />
      ) : (
        <>
          <div role="group" aria-label={t("faceoff.taker.label")} className="flex flex-col gap-1.5">
            <h2 className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
              {t("faceoff.taker.label")}
            </h2>
            {takers.map((tk) => {
              const who = playerLabel(snapshot, tk.takerId);
              return (
                <OptionRow
                  key={tk.takerId}
                  badge={who.number ?? who.lastName.slice(0, 1)}
                  name={t("faceoff.row.title", { lastName: who.lastName })}
                  value={tk.p}
                  valueLabel={pctLabel("faceoff.row.pct")}
                  ariaLabel={callLabel([who.lastName, who.number], tk.p, pctLabel("faceoff.row.pct"))}
                  selected={takerId === tk.takerId}
                  disabled={snapshot.busy}
                  onSelect={() => setTakerId(tk.takerId)}
                />
              );
            })}
          </div>
          <div role="group" aria-label={t("faceoff.target.label")} className="flex flex-col gap-1.5">
            <h2 className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
              {t("faceoff.target.label")}
            </h2>
            <div className="grid grid-cols-3 gap-1.5">
              {targets.map((tg) => {
                const option = takerId === null ? null : findFaceoff(faceoff, takerId, tg);
                const name = t(FACEOFF_TARGET_COPY[tg]);
                return (
                <button
                  key={tg}
                  type="button"
                  aria-label={option === null ? name : callLabel([name], option.p, pctLabel("faceoff.target.pct"))}
                  aria-pressed={target === tg}
                  disabled={snapshot.busy}
                  onClick={() => setTarget(tg)}
                  className={cx(
                    "box-border h-touch rounded-sm font-display text-[17px] font-bold uppercase text-white",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    target === tg ? "border-2 border-accent bg-surface-raised" : "border border-border bg-surface-sunk text-text-soft",
                    FOCUS_RING,
                  )}
                >
                  {name}
                </button>
                );
              })}
            </div>
          </div>
          {offensiveDraw ? (
            <FormationPicker
              compact
              value={formation}
              onChange={setFormation}
              skaters={ppOnIce(snapshot)}
              side={setup.side}
              label={fillCopy("formation.faceoff.label")}
              disabled={snapshot.busy}
            />
          ) : null}
          <div className="mt-auto">
            <Button
              disabled={!canDrop}
              onClick={() => {
                if (chosen !== null) onCall(offensiveDraw ? withFormation(chosen.call, formation, setup.formation) : chosen.call);
              }}
            >
              {t("faceoff.cta")}
            </Button>
          </div>
        </>
      )}
    </Shell>
  );
}

interface MethodRow {
  key: string;
  nameKey: CopyKey | PlayCopyKey;
  subKey: CopyKey | PlayCopyKey;
}

const text = (key: CopyKey | PlayCopyKey): string => (key in PLAY_COPY ? fillCopy(key as PlayCopyKey) : t(key as CopyKey));

const ENTRY_ROWS: Record<string, MethodRow> = {
  carry: { key: "carry", nameKey: "entry.carry", subKey: "entry.carry.sub" },
  drop: { key: "drop", nameKey: "entry.drop", subKey: "entry.drop.sub" },
  dump: { key: "dump", nameKey: "entry.dump", subKey: "entry.dump.sub" },
};
const BREAKOUT_ROWS: Record<string, MethodRow> = {
  carry: { key: "carry", nameKey: "breakout.carry", subKey: "breakout.carry.sub" },
  pass: { key: "pass", nameKey: "breakout.pass", subKey: "breakout.pass.sub" },
  rim: { key: "rim", nameKey: "breakout.rim", subKey: "breakout.rim.sub" },
};

const LANE_COPY: Record<EntryLane, PlayCopyKey> = {
  left: "entry.lane.left",
  middle: "entry.lane.middle",
  right: "entry.lane.right",
};

/**
 * Zone entry: pick a lane (when the engine prices lanes), then tap a method. The odds shown are for the selected
 * lane; the formation picker is the setup after a clean entry. One tap on a method sends lane + formation.
 * Without lanes on the options (an engine with one option per method) the lane selector is hidden.
 */
function EntrySheet({ snapshot, onCall, ticker }: Props) {
  const entry = useMemo(() => groupOptions(snapshot.options).zoneEntry, [snapshot.options]);
  const lanes = useMemo(() => entryLanes(entry), [entry]);
  const methods = useMemo(() => entryMethods(entry), [entry]);
  const [laneChoice, setLaneChoice] = useState<EntryLane | null>(() => defaultEntryLane(entry));
  const lane = laneChoice !== null && lanes.includes(laneChoice) ? laneChoice : defaultEntryLane(entry);
  const setup = currentSetup(snapshot);
  const [formation, setFormation] = useState<PpFormationName>(setup.formation);
  const pctWord = pctLabel("entry.pct");
  const bestWord = playPctLabel("entry.lane.best");

  return (
    <Shell snapshot={snapshot} title={t("entry.title")} body={t("entry.body")} ticker={ticker}>
      {lane === null ? null : (
        <div role="group" aria-label={fillCopy("entry.lane.label")} className="flex flex-col gap-1.5">
          <h2 className="m-0 text-xs font-semibold uppercase tracking-[0.08em] text-text-muted">
            {fillCopy("entry.lane.label")}
          </h2>
          <div className="grid grid-cols-3 gap-1.5">
            {ENTRY_LANES.filter((l) => lanes.includes(l)).map((l) => {
              const best = bestLaneChance(entry, l);
              const name = fillCopy(LANE_COPY[l]);
              return (
                <button
                  key={l}
                  type="button"
                  aria-pressed={lane === l}
                  aria-label={best === null ? name : callLabel([name], best, bestWord)}
                  disabled={snapshot.busy}
                  onClick={() => setLaneChoice(l)}
                  className={cx(
                    "box-border flex min-h-touch flex-col items-center justify-center rounded-sm text-white",
                    "disabled:cursor-not-allowed disabled:opacity-60",
                    lane === l ? "border-2 border-accent bg-surface-raised" : "border border-border bg-surface-sunk text-text-soft",
                    FOCUS_RING,
                  )}
                >
                  <span className="font-display text-[17px] font-bold uppercase leading-tight">{name}</span>
                  {best === null ? null : (
                    <span className="text-[11px] leading-tight text-text-muted">{pct(best)} {bestWord}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div role="group" aria-label={fillCopy("entry.methods.label")} className="flex flex-col gap-1.5">
        {methods.map((method, i) => {
          const row = ENTRY_ROWS[method];
          const o = entryOption(entry, method, lane);
          if (row === undefined || o === null) return null;
          return (
            <OptionRow
              key={method}
              badge={i + 1}
              name={text(row.nameKey)}
              sub={o.cutByClock ? fillCopy("play.cut") : text(row.subKey)}
              value={o.p}
              valueLabel={pctWord}
              ariaLabel={callLabel([text(row.nameKey), lane === null ? null : fillCopy(LANE_COPY[lane])], o.p, pctWord)}
              disabled={optionDisabled(o, snapshot.busy)}
              onSelect={() => onCall(withFormation(o.call, formation, setup.formation))}
            />
          );
        })}
      </div>

      <FormationPicker
        compact
        value={formation}
        onChange={setFormation}
        skaters={ppOnIce(snapshot)}
        side={setup.side}
        label={fillCopy("formation.entry.label")}
        disabled={snapshot.busy}
      />
    </Shell>
  );
}

/** Zone entry (kind "entry") or breakout (kind "breakout"): one tap sends the call. */
export function MethodSheet({ snapshot, onCall, kind, ticker }: Props & { kind: "entry" | "breakout" }) {
  if (kind === "entry") return <EntrySheet snapshot={snapshot} onCall={onCall} ticker={ticker} />;
  return <BreakoutSheet snapshot={snapshot} onCall={onCall} ticker={ticker} />;
}

function BreakoutSheet({ snapshot, onCall, ticker }: Props) {
  const options = useMemo(() => groupOptions(snapshot.options).breakout, [snapshot.options]);
  const pctWord = playPctLabel("breakout.pct");

  return (
    <Shell snapshot={snapshot} title={fillCopy("breakout.title")} body={fillCopy("breakout.body")} ticker={ticker}>
      <div className="flex flex-col gap-1.5">
        {options.map((o, i) => {
          const method = o.call.method;
          const row = BREAKOUT_ROWS[method];
          if (row === undefined) return null;
          return (
            <OptionRow
              key={method}
              badge={i + 1}
              name={text(row.nameKey)}
              sub={o.cutByClock ? fillCopy("play.cut") : text(row.subKey)}
              value={o.p}
              valueLabel={pctWord}
              ariaLabel={callLabel([text(row.nameKey)], o.p, pctWord)}
              disabled={optionDisabled(o, snapshot.busy)}
              onSelect={() => onCall(o.call)}
            />
          );
        })}
      </div>
    </Shell>
  );
}
