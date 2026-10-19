/**
 * narrate(log, fromIndex, ctx): turns the engine events produced by ONE call (log[fromIndex..], where
 * log[fromIndex] is the "call" event) into 1-4 short plain lines, the time they took, and an overall tone.
 * The draw p/u are never shown; they are not even read. Names come from ctx.players only (never invented).
 * Draw-hit flags and outcome indexes only choose wording.
 *
 * Pure; no state, no DOM, no clock. UI thread or tests.
 * Big-O: O(E) over the E events in the slice (each event is visited once, lookahead is O(1)); the 4-line cap
 * is applied by one O(L) pass over the L <= E lines.
 *
 * Event kinds handled (packages/engine/src/sim.ts): call, draw:{pass,skate,faceoff,faceoff_loss_clear,entry,
 * breakout,intercept,loose,block,blocked_recover,shot,freeze,rebound,miss_recover,pk_possession,en_clear,
 * sh_goal,opening_faceoff}, faceoff_setup, setup, goal, save, miss, sh_chance, clear, cut_by_clock, period_end, end.
 * Entry and OZ-faceoff draws may carry detail `lane` ("left"|"middle"|"right"), `method` and `formation`; each one
 * that is present is worded ("Carry-in on the left · Overload set up"), each one that is absent falls back to the
 * plain line. Anything else becomes one neutral "Play continues" line instead of a crash.
 */
import type { RunEvent } from "@powerplay/engine/sim-types.ts";
import type { ScenarioView } from "../contracts.ts";
import { formationLabel } from "./formations.ts";
import { fillCopy, type PlayCopyKey } from "./strings.ts";

export type NarrationTone = "good" | "bad" | "neutral" | "goal" | "against";

export interface NarrationLine {
  text: string;
  tone: NarrationTone;
}

export interface Narration {
  lines: NarrationLine[];
  /** Game seconds from the call to the next pause. */
  elapsedS: number;
  tone: NarrationTone;
}

export interface NarrateCtx {
  players: ScenarioView["players"];
  teams: ScenarioView["teams"];
  /** Engine spot id -> display name (lib/copy.ts spotName); must not throw for unknown ids. */
  spotName: (spot: string) => string;
  /** PP skater holding the puck at the next pause (snapshot.state.carrier), when known: names recoveries. */
  carrierId?: number | null;
}

/** Longest list the ticker shows; the middle of a longer one collapses into "N more plays". */
export const MAX_NARRATION_LINES = 4;
const KEEP_HEAD = 1;
const KEEP_TAIL = 2;
const SECONDS_PER_MINUTE = 60;

/** O(1). Seconds -> "m:ss"; negative or non-finite clamps to 0:00. */
export function formatOffClock(totalS: number): string {
  const s = Number.isFinite(totalS) ? Math.max(0, Math.floor(totalS)) : 0;
  return `${Math.floor(s / SECONDS_PER_MINUTE)}:${String(s % SECONDS_PER_MINUTE).padStart(2, "0")}`;
}

/** O(1). Index of the engine event that starts the latest call, or -1 before the first call. */
export function lastCallIndex(log: readonly RunEvent[]): number {
  for (let k = log.length - 1; k >= 0; k--) {
    if (log[k]?.kind === "call") return k;
  }
  return -1;
}

const num = (v: string | number | boolean | undefined): number | null => (typeof v === "number" ? v : null);
const str = (v: string | number | boolean | undefined): string | null => (typeof v === "string" ? v : null);

const LANE_KEYS = {
  left: "narrate.entry.lane.left",
  middle: "narrate.entry.lane.middle",
  right: "narrate.entry.lane.right",
} as const satisfies Record<string, PlayCopyKey>;

const ENTRY_IN_KEYS = {
  carry: "narrate.entry.in.carry",
  drop: "narrate.entry.in.drop",
  dump: "narrate.entry.in.dump",
} as const satisfies Record<string, PlayCopyKey>;

const ENTRY_FAIL_KEYS = {
  carry: "narrate.entry.fail.carry",
  drop: "narrate.entry.fail.drop",
  dump: "narrate.entry.fail.dump",
} as const satisfies Record<string, PlayCopyKey>;

const hasKey = <T extends object>(table: T, k: string | null): k is Extract<keyof T, string> =>
  k !== null && Object.hasOwn(table, k);

/** "Overload set up", or null when the log carries no (known) formation. A name this UI does not know is shown prettified. */
function setupPhrase(formation: string | null, side: string | null): string | null {
  if (formation === null || formation.length === 0) return null;
  const name = formationLabel(formation) ?? formation.replaceAll("_", " ");
  if (formation === "overload" && (side === "left" || side === "right")) {
    return fillCopy("narrate.setup.side", { formation: name, side: fillCopy(side === "left" ? "formation.side.left" : "formation.side.right") });
  }
  return fillCopy("narrate.setup", { formation: name });
}

const laneText = (v: string | null): string | null => (hasKey(LANE_KEYS, v) ? fillCopy(LANE_KEYS[v]) : null);

/** "Carry-in on the left" for a clean entry whose method and lane are known. */
const entryInText = (method: string | null, lane: string, holder: string | null): string =>
  method === "drop" && holder !== null ? fillCopy("narrate.entry.in.drop.to", { lane, name: holder }) : fillCopy(hasKey(ENTRY_IN_KEYS, method) ? ENTRY_IN_KEYS[method] : "narrate.entry.in.other", { lane });

const joinParts = (first: string, second: string | null): string =>
  second === null ? first : fillCopy("narrate.join", { first, second });

export function narrate(log: readonly RunEvent[], fromIndex: number, ctx: NarrateCtx): Narration {
  const start = Number.isInteger(fromIndex) ? Math.max(0, fromIndex) : 0;
  const slice = log.slice(start);
  const first = slice[0];
  const last = slice[slice.length - 1];
  if (first === undefined || last === undefined) return { lines: [], elapsedS: 0, tone: "neutral" };

  const { pp, pk } = ctx.teams;
  const nameOf = (id: number | null | undefined): string | null => {
    if (id === null || id === undefined) return null;
    const surname = ctx.players[id]?.last;
    return surname !== undefined && surname.length > 0 ? surname : null;
  };
  const holder = nameOf(ctx.carrierId);

  const lines: NarrationLine[] = [];
  const say = (key: PlayCopyKey, tone: NarrationTone, vars?: Record<string, string | number>): void => {
    lines.push({ text: fillCopy(key, vars), tone });
  };
  const rewriteLast = (key: PlayCopyKey, vars?: Record<string, string | number>): void => {
    const prev = lines[lines.length - 1];
    if (prev !== undefined) prev.text = fillCopy(key, vars);
  };

  let shooterId: number | null = null;
  let unknownRun = false;

  for (let k = 0; k < slice.length; k++) {
    const e = slice[k];
    if (e === undefined) continue;
    const d = e.detail ?? {};
    const hit = d["hit"] === true;
    const auto = e.callIndex === null;
    let isUnknown = false;

    switch (e.kind) {
      case "call":
      case "faceoff_setup":
      case "draw:opening_faceoff":
      case "draw:faceoff_loss_clear": // its "clear" event (or the pk_possession draw) carries the wording
      case "draw:shot": // its goal / save / miss event carries the wording
      case "draw:sh_goal":
      case "draw:en_clear":
        if (e.kind === "draw:shot") shooterId = num(d["shooterId"]) ?? shooterId;
        break;
      case "draw:pass": {
        if (!hit) break; // the intercept / loose draw that follows says how it failed
        const name = nameOf(num(d["to"]));
        if (name !== null) say(d["setPlay"] === true ? "narrate.pass.ok.set" : "narrate.pass.ok", "good", { name });
        else say("narrate.unknown", "neutral");
        break;
      }
      case "draw:intercept":
        if (hit) say("narrate.pass.picked", "bad");
        else say("narrate.pass.loose", "bad");
        break;
      case "draw:skate": {
        if (!hit) {
          say("narrate.skate.stopped", "bad");
          break;
        }
        const spot = ctx.spotName(str(d["to"]) ?? "");
        if (holder !== null) say("narrate.skate.ok", "good", { name: holder, spot });
        else say("narrate.skate.ok.noName", "good", { spot });
        break;
      }
      case "draw:faceoff": {
        if (!hit) {
          say("narrate.faceoff.lost", "bad", { team: pk });
          break;
        }
        const taker = nameOf(num(d["takerId"]));
        if (taker !== null) say("narrate.faceoff.won", "good", { name: taker });
        else say("narrate.faceoff.won.noName", "good");
        break;
      }
      case "draw:entry": {
        const method = str(d["method"]);
        const lane = laneText(str(d["lane"]));
        if (hit) {
          // The "setup" event that follows a clean entry rewrites this line with the formation.
          if (lane === null) say("narrate.entry.ok", "good", { team: pp });
          else lines.push({ text: entryInText(method, lane, null), tone: "good" });
          break;
        }
        if (lane !== null) {
          const key = hasKey(ENTRY_FAIL_KEYS, method) ? ENTRY_FAIL_KEYS[method] : "narrate.entry.fail.other";
          say(key, "bad", { lane, team: pk });
        } else if (method === "carry") say("narrate.entry.carry.fail", "bad");
        else if (method === "drop") say("narrate.entry.drop.fail", "bad");
        else say("narrate.entry.dump.fail", "bad", { team: pk });
        break;
      }
      case "setup": {
        // Logged after a clean entry (trigger "entry": method, lane, formation) or an OZ draw won (trigger "faceoff").
        const setup = setupPhrase(str(d["formation"]), str(d["side"]));
        const prev = lines[lines.length - 1];
        if (prev === undefined) break;
        if (str(d["trigger"]) === "entry") {
          const lane = laneText(str(d["lane"]));
          prev.text = joinParts(lane === null ? prev.text : entryInText(str(d["method"]), lane, nameOf(num(d["carrierId"]))), setup);
        } else if (setup !== null) {
          prev.text = joinParts(prev.text, setup);
        }
        break;
      }
      case "draw:breakout":
        // A successful automatic regroup breakout is folded into the "Regroup" line.
        if (hit && !auto) say("narrate.breakout.ok", "good");
        else if (!hit) say("narrate.breakout.fail", "bad");
        break;
      case "draw:loose":
        if (hit) {
          if (holder !== null) say("narrate.loose.won", "good", { name: holder });
          else say("narrate.loose.won.noName", "good", { team: pp });
        } else {
          say("narrate.loose.lost", "bad", { team: pk });
        }
        break;
      case "draw:block":
        shooterId = num(d["shooterId"]) ?? shooterId;
        if (hit) say("narrate.block", "bad");
        break;
      case "draw:blocked_recover":
        if (hit) {
          if (holder !== null) rewriteLast("narrate.block.keep", { name: holder });
          else rewriteLast("narrate.block.keep.noName", { team: pp });
        } else {
          rewriteLast("narrate.block.lose", { team: pk });
        }
        break;
      case "save":
        say("narrate.save", "neutral");
        break;
      case "draw:freeze":
        if (hit) rewriteLast("narrate.save.freeze");
        break;
      case "draw:rebound":
        if (hit) {
          if (holder !== null) rewriteLast("narrate.save.rebound", { name: holder });
          else rewriteLast("narrate.save.rebound.noName", { team: pp });
        } else {
          rewriteLast("narrate.save.lost", { team: pk });
        }
        break;
      case "miss":
        say("narrate.miss", "bad");
        break;
      case "draw:miss_recover":
        if (hit) rewriteLast("narrate.miss.keep", { team: pp });
        else rewriteLast("narrate.miss.lose", { team: pk });
        break;
      case "goal": {
        if (d["side"] === "pk") {
          say("narrate.goal.pk", "against", { team: pk });
          break;
        }
        const scorer = nameOf(shooterId);
        if (scorer !== null) say("narrate.goal.pp", "goal", { name: scorer });
        else say("narrate.goal.pp.noName", "goal", { team: pp });
        break;
      }
      case "draw:pk_possession":
        // Outcomes 0 (clear) and 1 (shorthanded chance) are worded by their own events.
        if (num(d["outcome"]) === 2) say("narrate.pk.regain", "good", { team: pk });
        break;
      case "sh_chance":
        say("narrate.pk.chance", "bad", { team: pk });
        break;
      case "clear": {
        say("narrate.clear", "bad", { team: pk });
        const next = slice[k + 1];
        if (next !== undefined && next.atS > e.atS) {
          say("narrate.regroup", "neutral", { clock: formatOffClock(next.atS - e.atS) });
        }
        break;
      }
      case "cut_by_clock":
        say("narrate.cut", "bad");
        break;
      case "period_end":
        say("narrate.period", "neutral", { n: num(d["period"]) ?? 0 });
        break;
      case "end": {
        const reason = str(d["reason"]);
        if (reason === "cleared_out") say("narrate.end.cleared", "bad");
        else if (reason === "pp_expired") say("narrate.end.expired", "neutral");
        else if (reason === "game_end" && str(d["detail"]) !== "ot_goal") say("narrate.end.game", "neutral");
        break;
      }
      default:
        isUnknown = true;
        // One generic line per run of unknown events, so an engine addition cannot flood the ticker.
        if (!unknownRun) say("narrate.unknown", "neutral");
    }
    unknownRun = isUnknown;
  }

  return {
    lines: capLines(lines),
    elapsedS: Math.max(0, last.atS - first.atS),
    tone: overallTone(lines),
  };
}

/** O(L). Keep the first line and the last two; the rest become one neutral count line. */
function capLines(lines: NarrationLine[]): NarrationLine[] {
  if (lines.length <= MAX_NARRATION_LINES) return lines;
  const hidden = lines.length - KEEP_HEAD - KEEP_TAIL;
  return [
    ...lines.slice(0, KEEP_HEAD),
    { text: fillCopy("narrate.more", { n: hidden }), tone: "neutral" },
    ...lines.slice(lines.length - KEEP_TAIL),
  ];
}

/** O(L). A goal either way wins; otherwise the first line that is not neutral decides. */
function overallTone(lines: readonly NarrationLine[]): NarrationTone {
  const decisive = lines.find((l) => l.tone === "goal" || l.tone === "against");
  if (decisive !== undefined) return decisive.tone;
  return lines.find((l) => l.tone !== "neutral")?.tone ?? "neutral";
}
