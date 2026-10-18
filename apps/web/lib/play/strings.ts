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
  // Outcome narration (lib/play/narrate.ts). Templates only; names and team codes come from the scenario.
  "narrate.title": "What just happened",
  "narrate.elapsed": "-{clock}",
  "narrate.elapsed.aria": "{clock} off the clock",
  "narrate.tone.good": "Good",
  "narrate.tone.bad": "Setback",
  "narrate.tone.neutral": "Play",
  "narrate.tone.goal": "Goal",
  "narrate.tone.against": "Against",
  "narrate.unknown": "Play continues",
  "narrate.more": "{n} more plays",
  "narrate.pass.ok": "Pass to {name} connects",
  "narrate.pass.ok.set": "Set play: pass to {name} connects",
  "narrate.pass.picked": "Pass picked off",
  "narrate.pass.loose": "Pass off target, puck loose",
  "narrate.skate.ok": "{name} skates to the {spot}",
  "narrate.skate.ok.noName": "Skate to the {spot} works",
  "narrate.skate.stopped": "Skate stopped, puck loose",
  "narrate.faceoff.won": "Faceoff won by {name}",
  "narrate.faceoff.won.noName": "Faceoff won",
  "narrate.faceoff.lost": "Faceoff lost, {team} wins it back",
  "narrate.entry.ok": "Zone entry works, {team} set up",
  "narrate.entry.carry.fail": "Carry-in stopped at the blue line",
  "narrate.entry.drop.fail": "Drop pass stopped at the blue line",
  "narrate.entry.dump.fail": "Dump-in lost to {team}",
  "narrate.breakout.ok": "Breakout works",
  "narrate.breakout.fail": "Breakout stopped",
  "narrate.block": "Shot blocked",
  "narrate.block.keep": "Shot blocked, {name} gets the puck back",
  "narrate.block.keep.noName": "Shot blocked, {team} keep the puck",
  "narrate.block.lose": "Shot blocked, {team} take the puck",
  "narrate.save": "Save",
  "narrate.save.freeze": "Save, whistle for a faceoff",
  "narrate.save.rebound": "Save, rebound to {name}",
  "narrate.save.rebound.noName": "Save, rebound stays with {team}",
  "narrate.save.lost": "Save, {team} gets the rebound",
  "narrate.miss": "Shot misses the net",
  "narrate.miss.keep": "Shot misses the net, {team} keep it",
  "narrate.miss.lose": "Shot misses the net, {team} get the puck",
  "narrate.goal.pp": "GOAL! {name} scores",
  "narrate.goal.pp.noName": "GOAL! {team} score",
  "narrate.goal.pk": "Shorthanded goal against, {team} score",
  "narrate.loose.won": "{name} picks up the loose puck",
  "narrate.loose.won.noName": "{team} win the loose puck",
  "narrate.loose.lost": "{team} get the loose puck",
  "narrate.pk.regain": "{team} take the puck back",
  "narrate.pk.chance": "{team} get a shorthanded chance",
  "narrate.clear": "{team} clear the zone",
  "narrate.regroup": "Regroup · {clock} off the clock",
  "narrate.cut": "Not enough time left",
  "narrate.period": "End of period {n}",
  "narrate.end.cleared": "Not enough time to re-enter, power play over",
  "narrate.end.expired": "Power play over",
  "narrate.end.game": "Game over",
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
