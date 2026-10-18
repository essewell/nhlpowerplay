/**
 * Strings the play screens need that docs/COPY.md and lib/copy.ts do not have yet.
 * draft — pending COPY.md, owner Cowork. Templates only: no game facts, years, names or percentages.
 * When Cowork adds them, move them into lib/copy.ts PENDING_COPY (and lib/PENDING_COPY.md) and delete this file.
 * Pure; no state. fillCopy is O(template length).
 */
import { rawCopy, type CopyKey, type CopyVars } from "../copy.ts";

export const PLAY_COPY = {
  "play.pass.aria": "Pass to {lastName}, {number}",
  "play.pass.aria.noNumber": "Pass to {lastName}",
  "play.carrier.aria": "{lastName}, {number}, has the puck",
  "play.carrier.aria.noNumber": "{lastName} has the puck",
  "play.rink.aria": "Offensive zone. Your skaters are blue, the penalty kill is grey, the net is at the top.",
  "play.skate.more": "Show {n} more spots",
  "play.skate.fewer": "Show fewer spots",
  "play.shoot.open": "Choose shot and target",
  "play.cut": "Not enough time left",
  "play.ended": "Taking you to your result…",
  "play.sheet.aria": "Your call",
  "breakout.title": "Breakout",
  "breakout.body": "How do you get the puck out of your end?",
  "breakout.carry": "Carry out",
  "breakout.carry.sub": "Skate it through the neutral zone",
  "breakout.pass": "Pass out",
  "breakout.pass.sub": "Hit a teammate on the way up",
  "breakout.rim": "Rim it",
  "breakout.rim.sub": "Bank it around the boards",
  "breakout.pct": "{pct}% gets out",
} as const;

export type PlayCopyKey = keyof typeof PLAY_COPY;

/** Fill `{var}` placeholders of one of the PLAY_COPY templates; a missing variable throws (caller bug). */
export function fillCopy(key: PlayCopyKey, vars?: CopyVars): string {
  return PLAY_COPY[key].replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_whole, name: string) => {
    const v = vars?.[name];
    if (v === undefined) throw new Error(`play copy: key "${key}" needs variable "${name}"`);
    return String(v);
  });
}

/**
 * The words after the percentage in a "{pct}% label" template ("{pct}% connects" -> "connects"),
 * for OptionRow's valueLabel. Throws if the template does not start with "{pct}%".
 */
export function labelAfterPct(template: string): string {
  const m = /^\{pct\}%\s*(.+)$/.exec(template);
  if (m === null || m[1] === undefined) throw new Error(`copy: "${template}" is not a "{pct}% label" template`);
  return m[1];
}

/** labelAfterPct for a lib/copy.ts key. */
export function pctLabel(key: CopyKey): string {
  return labelAfterPct(rawCopy(key));
}

/** labelAfterPct for a PLAY_COPY key. */
export function playPctLabel(key: PlayCopyKey): string {
  return labelAfterPct(PLAY_COPY[key]);
}
