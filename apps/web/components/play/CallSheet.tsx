"use client";

/**
 * Non-decision calls: the opening faceoff (taker x target), the zone entry (carry / drop / dump) and the
 * breakout (only when settings.askEveryTouch). Same look as the decision sheet. Every control is
 * disabled while `snapshot.busy` (edge 9). Mount with key={calls.length} to reset the selection.
 * UI thread only.
 */
import { useMemo, useState } from "react";
import type { Call } from "@powerplay/engine/sim-types.ts";
import { Button } from "../ui/Button.tsx";
import { OptionRow } from "../ui/OptionRow.tsx";
import { StateCard } from "../ui/StateCard.tsx";
import { cx, FOCUS_RING } from "../ui/cx.ts";
import type { RunSnapshot } from "../../lib/contracts.ts";
import { t, type CopyKey } from "../../lib/copy.ts";
import {
  FACEOFF_TARGET_COPY, faceoffTakers, findFaceoff, groupOptions, optionDisabled, playerLabel, sortByChance,
} from "../../lib/play/options.ts";
import { scoreboardModel } from "../../lib/play/scoreboard.ts";
import { fillCopy, pctLabel, playPctLabel, PLAY_COPY, type PlayCopyKey } from "../../lib/play/strings.ts";
import { Scoreboard } from "./Scoreboard.tsx";

interface Props {
  snapshot: RunSnapshot;
  onCall: (call: Call) => void;
}

function Shell({ snapshot, title, body, children }: { snapshot: RunSnapshot; title: string; body: string; children: React.ReactNode }) {
  const board = scoreboardModel(snapshot);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[430px] flex-col">
      <div className="flex flex-col gap-2.5 px-4 pb-2.5 pt-3.5">
        {board.ok ? <Scoreboard teams={snapshot.scenario.teams} model={board.value} /> : null}
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

export function FaceoffSheet({ snapshot, onCall }: Props) {
  const [takerId, setTakerId] = useState<number | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const faceoff = useMemo(() => groupOptions(snapshot.options).faceoff, [snapshot.options]);
  const takers = sortByChance(faceoffTakers(faceoff));
  const chosen = takerId !== null && target !== null ? findFaceoff(faceoff, takerId, target) : null;
  const canDrop = chosen !== null && !optionDisabled(chosen, snapshot.busy);
  const targets = Object.keys(FACEOFF_TARGET_COPY) as (keyof typeof FACEOFF_TARGET_COPY)[];

  return (
    <Shell snapshot={snapshot} title={t("faceoff.title")} body={t("faceoff.body")}>
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
              {targets.map((tg) => (
                <button
                  key={tg}
                  type="button"
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
                  {t(FACEOFF_TARGET_COPY[tg])}
                </button>
              ))}
            </div>
          </div>
          <div className="mt-auto">
            <Button
              disabled={!canDrop}
              onClick={() => {
                if (chosen !== null) onCall(chosen.call);
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

/** Zone entry (kind "entry") or breakout (kind "breakout"): one tap sends the call. */
export function MethodSheet({ snapshot, onCall, kind }: Props & { kind: "entry" | "breakout" }) {
  const grouped = useMemo(() => groupOptions(snapshot.options), [snapshot.options]);
  const rows = kind === "entry" ? ENTRY_ROWS : BREAKOUT_ROWS;
  const options = kind === "entry" ? grouped.zoneEntry : grouped.breakout;
  const pctWord = kind === "entry" ? pctLabel("entry.pct") : playPctLabel("breakout.pct");
  const title = kind === "entry" ? t("entry.title") : fillCopy("breakout.title");
  const body = kind === "entry" ? t("entry.body") : fillCopy("breakout.body");

  return (
    <Shell snapshot={snapshot} title={title} body={body}>
      <div className="flex flex-col gap-1.5">
        {options.map((o, i) => {
          const method = o.call.method;
          const row = rows[method];
          if (row === undefined) return null;
          return (
            <OptionRow
              key={method}
              badge={i + 1}
              name={text(row.nameKey)}
              sub={o.cutByClock ? fillCopy("play.cut") : text(row.subKey)}
              value={o.p}
              valueLabel={pctWord}
              disabled={optionDisabled(o, snapshot.busy)}
              onSelect={() => onCall(o.call)}
            />
          );
        })}
      </div>
    </Shell>
  );
}
