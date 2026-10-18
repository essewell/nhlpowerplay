/**
 * All UI strings. Source of truth: docs/COPY.md (owned by Cowork). Change wording there first.
 *
 * Key scheme: COPY.md section 1 and 10 keys are used as written; section 4.x keys are prefixed
 * (4.1 home., 4.2 pause., 4.3 shot., 4.4 results.) because COPY.md reuses names such as
 * `error.title` per screen. Prose sections (How it works, About, Privacy, Terms) use how./about./
 * privacy./terms. Keys marked "derived" split a compound COPY.md row (tabs, shot types, grade words)
 * into the individual words the UI needs; their text is copied from that row.
 *
 * Variables: `{name}` placeholders. The COPY.md `{m:ss}`, `{L/R}` and `{blocker/glove}` placeholders
 * are renamed `{clock}`, `{hand}` and `{side}` so callers can pass plain identifiers.
 * `{pct}` is a number without the percent sign (COPY.md writes `{pct}%`); use pctValue().
 *
 * Ownership: pure module, no state, no DOM, no clock, no randomness. Safe in a worker or on the server.
 * Complexity: t() is O(length of the template).
 */
import { pct } from "@powerplay/engine/likelihood.ts";
import type { SpotName } from "@powerplay/engine/constants.ts";

export type CopyVars = Record<string, string | number>;

export const COPY = {
  // ---- 1. Global
  "app.name": "PowerPlay",
  "app.tagline": "Call the power play in a real NHL moment. Every touch, you decide.",
  "nav.daily": "Daily",
  "nav.endless": "Endless",
  "nav.howItWorks": "How it works",
  "nav.about": "About",
  "footer.notice": "Not affiliated with the NHL or NHLPA. Game data from public NHL endpoints.",
  "action.retry": "Try again",
  "action.back": "Back",
  "action.close": "Close",
  "offline.banner": "You're offline. Your calls are saved on this device and will be scored when you reconnect.",
  "reconnected.toast": "Back online. Score submitted.",
  "genericError.title": "Something went wrong",
  "genericError.body": "That's on us. Try again, and reload the page if it keeps happening.",
  "genericError.cta": "Reload",
  "daily.next": "Next Daily in {h}h {m}m",

  // ---- 2. How it works
  "how.title": "How it works",
  "how.intro":
    "You're behind the bench for a real NHL power play. Every time the puck lands on one of your skaters' sticks, play pauses and you make the call.",
  "how.step1.title": "Take the bench",
  "how.step1.body":
    "Each scenario starts from a real power play: the real teams, the real score, the real clock and the players who were on the ice.",
  "how.step2.title": "Make the call",
  "how.step2.intro": "When play pauses, choose what your puck carrier does:",
  "how.step2.pass.label": "Pass",
  "how.step2.pass.rest": "to a teammate",
  "how.step2.skate.label": "Skate",
  "how.step2.skate.rest": "to a new spot",
  "how.step2.shoot.label": "Shoot",
  "how.step2.shoot.rest": ", then pick the shot type and where you're aiming",
  "how.step2.setplay.label": "Set play",
  "how.step2.setplay.rest": ", to run a power-play play your team uses",
  "how.step2.outro": "Every option shows its chance of working, so you're always choosing with the odds in front of you.",
  "how.step3.title": "Beat the clock",
  "how.step3.body":
    "The power play ends when you score, when the penalty runs out, or when the kill clears the puck and you don't have time to get back in.",
  "how.step4.title": "See how you coached",
  "how.step4.body":
    "Every call gets a grade (Best, Close, Costly or Big miss), and you'll see what the real bench did with the same power play.",
  "how.numbers.title": "Where the numbers come from",
  "how.numbers":
    "Shooting, goaltending, faceoff and playmaking chances are built from NHL playoff play-by-play, {firstSeason} through {lastSeason}. Public data doesn't track passes or puck carries, so passing and skating chances are our estimates. Every percentage is a chance, not a guarantee.",
  "how.modes.title": "Modes",
  "how.modes.daily.title": "Daily",
  "how.modes.daily.body":
    "One famous power play a day, the same for everyone. One attempt. New Daily at midnight Pacific time.",
  "how.modes.endless.title": "Endless",
  "how.modes.endless.body": "Random real playoff power plays, {firstYear}–{lastYear}, back to back.",
  "how.cta": "Take the bench",

  // ---- 3. About
  "about.title": "About PowerPlay",
  "about.p1":
    "PowerPlay is a fan-made hockey strategy game. Every scenario is a real NHL power play rebuilt from public play-by-play data. You make the calls and see how they stack up against what really happened.",
  "about.p2":
    "The chances on each option come from a model built on that data. Some parts are estimates (passing, skating, and which part of the net a shot beats the goalie), because public data doesn't record them. They're labelled as estimates and are never shown as historical stats.",
  "about.p3":
    "Famous moments are checked twice: every fact comes from a published source, then gets confirmed against the official play-by-play before the moment goes live. Sources are listed with each moment.",
  "about.credits.title": "Data and credits",
  "about.credits.body": "Game data comes from the NHL's public web endpoints. Community documentation:",
  "about.credits.link": "github.com/Zmalski/NHL-API-Reference",
  "about.notice.title": "Notice",
  "about.notice.body":
    "PowerPlay is not affiliated with, endorsed by or sponsored by the National Hockey League (NHL), the NHL Players' Association (NHLPA) or any team. Team and player names are used only to describe real games.",

  // ---- 4.1 Home
  "home.wordmark": "PowerPlay",
  "home.tagline": "Call the power play in a real NHL moment. Every touch, you decide.",
  "home.daily.eyebrow": "Today's Daily · No. {n}",
  "home.daily.badge": "Same for everyone",
  "home.daily.stage": "{stageName} · Game {gameNumber}",
  "home.daily.yourBench": "Your bench",
  "home.daily.killing": "Killing",
  "home.daily.labels": "Period · Clock · Strength",
  "home.daily.label.period": "Period", // derived
  "home.daily.label.clock": "Clock", // derived
  "home.daily.label.strength": "Strength", // derived
  "home.daily.clock": "{clock} left",
  "home.daily.strength": "{pp}-on-{pk}",
  "home.daily.stakes": "{penaltyType} on {pkTeamName}. {stakesLine} Can you out-call the real bench?",
  "home.daily.cta": "Take the bench",
  "home.tile.daily.title": "Daily",
  "home.tile.daily.body": "One famous power play a day.",
  "home.tile.endless.title": "Endless",
  "home.tile.endless.body": "Random real playoff power plays, {firstYear}–{lastYear}.",
  "home.howItWorks.link": "How it works",
  "home.streak": "{n}-day streak",
  "home.streak.none": "Start a streak: play today's Daily.",
  "home.loading": "Loading today's power play…",
  "home.daily.played": "You've coached today's Daily. Next Daily in {h}h {m}m.",
  "home.daily.played.cta": "See your result",
  "home.empty.noDaily.title": "No Daily yet",
  "home.empty.noDaily.body": "Today's power play isn't ready. Try Endless while you wait.",
  "home.empty.noDaily.cta": "Play Endless",
  "home.error.title": "Couldn't load today's power play",
  "home.error.body": "Check your connection and try again.",
  "home.error.cta": "Try again",

  // ---- 4.2 Decision pause
  "pause.scoreboard.period": "{periodOrdinal} · {clock}",
  "pause.scoreboard.pp": "PP {clock} · {pp}-on-{pk}",
  "pause.chip.paused": "Paused · puck on {number}'s stick",
  "pause.chip.speed": "{n}×",
  "pause.sheet.title": "Your call · {lastName}",
  "pause.sheet.spot": "{spotName}",
  "pause.sheet.pkRead": "PK read: {pkRead}",
  "pause.tabs": "Pass · Skate · Shoot · Set play",
  "pause.tab.pass": "Pass", // derived
  "pause.tab.skate": "Skate", // derived
  "pause.tab.shoot": "Shoot", // derived
  "pause.tab.setplay": "Set play", // derived
  "pause.pass.row.title": "{lastName}",
  "pause.pass.row.sub": "{spotName} · {laneDescription}",
  "pause.pass.row.pct": "{pct}% connects",
  "pause.skate.row.title": "{spotName}",
  "pause.skate.row.sub": "{routeDescription}",
  "pause.skate.row.pct": "{pct}% keeps puck",
  "pause.setplay.row.pct": "{pct}% goal",
  "pause.tag.estimate": "Estimate",
  "pause.tag.lowSample": "League average",
  "pause.empty.pass": "No open passing lanes. Skate or shoot.",
  "pause.empty.skate": "No room to skate. Pass or shoot.",
  "pause.empty.setPlay": "No set play fits this spot.",
  "pause.loading.scenario": "Setting the lines…",
  "pause.loading.odds": "Reading the kill…",
  "pause.error.title": "Couldn't work out the chances",
  "pause.error.body": "Something went wrong with this play. Your run is saved.",
  "pause.error.cta": "Try again",
  "pause.end.goal": "Power-play goal",
  "pause.end.expired": "Penalty's over. Back to even strength.",
  "pause.end.cleared": "Cleared, and not enough time to get back in.",
  "pause.end.shortie": "Shorthanded goal against",
  "pause.resume.banner": "Picking up where you left off.",

  // ---- 4.3 Shot picker
  "shot.title": "Shoot · {lastName}",
  "shot.subtitle": "{spotName} · puck arriving from {passerNumber}",
  "shot.section.type": "Shot type",
  "shot.types": "Wrist · Snap · Slap · One-timer · Backhand · Tip",
  "shot.type.wrist": "Wrist", // derived
  "shot.type.snap": "Snap", // derived
  "shot.type.slap": "Slap", // derived
  "shot.type.oneTimer": "One-timer", // derived
  "shot.type.backhand": "Backhand", // derived
  "shot.type.tip": "Tip", // derived
  "shot.type.pct": "{pct}% goal",
  "shot.section.target": "Target",
  "shot.goalieHand": "Goalie catches {hand}",
  "shot.targets": "Top left · {side} · Top right · {side} · Low blocker · 5-hole · Low glove",
  "shot.target.topLeft": "Top left · {side}", // derived
  "shot.target.topRight": "Top right · {side}", // derived
  "shot.target.lowBlocker": "Low blocker", // derived
  "shot.target.lowGlove": "Low glove", // derived
  "shot.target.lowLeft": "Low left", // derived: used when the catching hand is unknown
  "shot.target.lowRight": "Low right", // derived: used when the catching hand is unknown
  "shot.target.fiveHole": "5-hole", // derived
  "shot.target.topLeftPlain": "Top left", // derived: used when the catching hand is unknown
  "shot.target.topRightPlain": "Top right", // derived: used when the catching hand is unknown
  "shot.side.blocker": "blocker", // derived
  "shot.side.glove": "glove", // derived
  "shot.goalieHand.unknown": "Goalie's catching hand unknown",
  "shot.summary.selected": "{shotType} · {targetLabel}",
  "shot.summary.labels": "Goal · On net · Blocked",
  "shot.summary.goal": "Goal", // derived
  "shot.summary.onNet": "On net", // derived
  "shot.summary.blocked": "Blocked", // derived
  "shot.footnote":
    "Built from real {firstYear}–{lastYearShort} playoff power-play shots by type and distance, {lastName}'s finishing and the goalie's record.",
  "shot.footnote.estimate": "Where the shot beats the goalie is an estimate.",
  "shot.cta": "Shoot",
  "shot.cta.disabled": "Pick a shot and a target",
  "shot.loading": "Lining it up…",
  "shot.error.title": "Couldn't load shot chances",
  "shot.error.body": "Try again, or go back and make a different call.",
  "shot.error.cta": "Try again",

  // ---- 4.4 Results
  "results.eyebrow": "Daily No. {n} · {teamA} vs {teamB}",
  "results.eyebrow.endless": "Endless · {teamA} vs {teamB}", // derived from the COPY.md note
  "results.banner.goal": "You score",
  "results.banner.goal.sub": "Power-play goal at {clock} of the {periodOrdinal}",
  "results.banner.noGoal": "Kill holds",
  "results.banner.noGoal.sub": "{reason}",
  "results.banner.shortie": "Shorthanded goal",
  "results.realBench.label": "The real bench",
  "results.realBench.goal": "Scored · {scorerLast} at {clock}",
  "results.realBench.chain": "{a} → {b} → {c}",
  "results.realBench.noGoal": "No goal · kill held",
  "results.match.same": "You matched it",
  "results.match.better": "You out-called it",
  "results.match.worse": "They got this one",
  "results.match.bothMissed": "Nobody scored",
  "results.calls.label": "Your calls",
  "results.legend": "✓ Best call or within {bestThreshold} pts · • Close · ▲ Costly · ✕ Big miss",
  "results.legend.best": "Best call or within {bestThreshold} pts", // derived
  "results.legend.info":
    '"pts" = percentage points of goal chance. A call 0.5 pts behind the best one means, say, 12.0% instead of 12.5%.',
  "results.percentile.label": "Coach percentile",
  "results.percentile.value": "{pct}",
  "results.percentile.sub": "vs simulated NHL benches",
  "results.looksLike.label": "Your PP looks like",
  "results.looksLike.value": "{teamName}",
  "results.looksLike.sub": "by call mix",
  "results.cta.share": "Share result",
  "results.cta.review": "Review my calls",
  "results.cta.endless": "Play Endless",
  "results.share.text":
    "PowerPlay Daily No. {n} · {teamA} vs {teamB} · {resultWord} · {best} best, {close} close, {costly} costly, {miss} big miss · {url}",
  "results.share.copied": "Copied",
  "results.loading": "Grading your calls…",
  "results.loading.approx": "Grading your calls (quick check)…",
  "results.grades.approx": "Approximate grades: your device ran a quicker check.",
  "results.submit.pending": "Score saved. It'll submit when you're back online.",
  "results.submit.provisional": "Provisional score",
  "results.error.title": "Couldn't grade this run",
  "results.error.body": "Your calls are saved. Try again to grade them.",
  "results.error.cta": "Try again",
  "results.empty.noCalls": "No calls to grade: the power play ended before the puck reached your skaters.",
  "results.daily.alreadyPlayed": "You've already played today's Daily. Here's your result.",
  "results.word.scored": "Scored", // derived from the share.text note
  "results.word.killHeld": "Kill held", // derived from the share.text note

  // ---- Grade words (derived from COPY.md section 2 step 4 and the section 4.4 legend)
  "grade.best": "Best",
  "grade.close": "Close",
  "grade.costly": "Costly",
  "grade.miss": "Big miss",

  // ---- 5. Set plays
  "setplay.oneTimer.name": "One-timer",
  "setplay.oneTimer.sub": "Feed across to the shooter in the circle",
  "setplay.crossSeam.name": "Cross-seam",
  "setplay.crossSeam.sub": "Pass through the slot to the far circle",
  "setplay.bumper.name": "Bumper",
  "setplay.bumper.sub": "Hit the middle man in the slot",
  "setplay.pointShot.name": "Point shot",
  "setplay.pointShot.sub": "Shoot from the point with traffic in front",
  "setplay.netFrontTip.name": "Net-front tip",
  "setplay.netFrontTip.sub": "Low shot for the net-front player to redirect",
  "setplay.lowPlay.name": "Low play",
  "setplay.lowPlay.sub": "Work it below the goal line, then into the slot",
  "setplay.overload.name": "Half-wall overload",
  "setplay.overload.sub": "Cycle down the half-wall to pull the box over",
  "setplay.team.oneTimer": "{shooterLast} one-timer",
  "setplay.team.bumper": "{shooterLast} bumper",
  "setplay.team.netFront": "{shooterLast} net-front",
  "setplay.team.sub": "{teammateLast} to {shooterLast} · {spotName}",
  "tag.oneTimer.info":
    "One-timers aren't tracked in public NHL data, so this chance is estimated from real slap and snap shots taken from the same spot.",

  // ---- 8. Privacy
  "privacy.title": "Privacy",
  "privacy.updated": "Last updated: {date}",
  "privacy.intro":
    "PowerPlay is a free fan-made game. We don't ask for your name or email, and you don't need an account.",
  "privacy.device.title": "What stays on your device",
  "privacy.device.body":
    "Your Daily results, streak and settings are saved in your browser's local storage so you can pick up where you left off. They stay on your device. Clearing your browser data deletes them.",
  "privacy.host.title": "What our host sees",
  "privacy.host.body":
    "Like any website, our hosting provider handles standard technical data (such as your IP address and browser type) to deliver the page and keep it secure. We don't use that data to identify you, and we don't sell it.",
  "privacy.never.title": "What we don't do",
  "privacy.never.body": "No ads. No tracking cookies. No selling or sharing of personal data.",
  "privacy.kids.title": "Kids",
  "privacy.kids.body":
    "PowerPlay isn't directed at children under 13 and doesn't knowingly collect their personal information.",
  "privacy.contact.title": "Changes and contact",
  "privacy.contact.body": "If this policy changes, we'll update the date above. Questions: {contactEmail}",

  // ---- 9. Terms
  "terms.title": "Terms of use",
  "terms.updated": "Last updated: {date}",
  "terms.item1.title": "Free fan game.",
  "terms.item1.body":
    "PowerPlay is a free, non-commercial fan project. It is not affiliated with, endorsed by or sponsored by the National Hockey League (NHL), the NHL Players' Association (NHLPA) or any team.",
  "terms.item2.title": "Game data.",
  "terms.item2.body":
    "Scenarios are rebuilt from publicly available NHL game data. Data is provided as-is and may contain errors. Percentages are model estimates, not predictions or historical statistics, except where labelled.",
  "terms.item3.title": "Names and marks.",
  "terms.item3.body":
    "Team and player names are used only to describe real games. All trademarks belong to their owners.",
  "terms.item4.title": "Fair play.",
  "terms.item4.body": "Don't try to break, overload or reverse-engineer the game or its scoring.",
  "terms.item5.title": "No warranty.",
  "terms.item5.body":
    'The game is provided "as is", without warranties of any kind. We aren\'t liable for any loss from using it.',
  "terms.item6.title": "Changes.",
  "terms.item6.body":
    "We may update the game or these terms at any time; continued use means you accept the changes.",
  "terms.item7.title": "Contact:",
  "terms.item7.body": "{contactEmail}",

  // ---- 10. Page metadata
  "meta.title.home": "PowerPlay · Coach a real NHL power play",
  "meta.title.page": "{pageName} · PowerPlay",
  "meta.description":
    "Call the plays on real NHL power plays. Every time the puck hits your skater's stick, you decide: pass, skate, shoot or run a set play. New Daily every day.",
  "og.title.default": "PowerPlay",
  "og.description.default": "Call the power play in a real NHL moment. Every touch, you decide.",
  "og.title.result": "PowerPlay Daily No. {n} · {teamA} vs {teamB}",
  "og.description.result": "{resultWord} · {best} best calls · Can you out-call the real bench?",
  "og.image.alt": "PowerPlay result card: {teamA} vs {teamB}, {resultWord}",
  "twitter.card": "summary_large_image",
  "app.manifest.name": "PowerPlay",
  "app.manifest.short_name": "PowerPlay",
  "app.manifest.description": "Coach real NHL power plays.",
} as const;

/**
 * draft — pending COPY.md, owner Cowork.
 * Strings COPY.md does not have yet. The user approved drafting them. Templates only: no game facts,
 * years, names or percentages. Mirrored in apps/web/lib/PENDING_COPY.md (a test keeps them in sync).
 * When Cowork adds a string to COPY.md, move it up into COPY and delete it here.
 */
export const PENDING_COPY = {
  // Opening faceoff call: choose the taker and where the draw is sent. Each option is priced.
  "faceoff.title": "Opening faceoff",
  "faceoff.body": "Pick who takes the draw and where it goes.",
  "faceoff.taker.label": "Taker",
  "faceoff.target.label": "Send it to",
  "faceoff.target.point": "Point",
  "faceoff.target.halfWall": "Half wall",
  "faceoff.target.back": "Back",
  "faceoff.row.title": "{lastName}",
  "faceoff.row.pct": "{pct}% wins the draw",
  "faceoff.target.pct": "{pct}% gets it there",
  "faceoff.cta": "Drop the puck",
  "faceoff.error.title": "Couldn't price the faceoff",

  // Zone-entry call: carry, drop pass or dump.
  "entry.title": "Zone entry",
  "entry.body": "How do you get over the blue line?",
  "entry.carry": "Carry in",
  "entry.carry.sub": "Skate it over the blue line",
  "entry.drop": "Drop pass",
  "entry.drop.sub": "Leave it for a trailing teammate",
  "entry.dump": "Dump in",
  "entry.dump.sub": "Chip it deep and chase",
  "entry.pct": "{pct}% gains the zone",

  // Post-goal celebration.
  "celebrate.title": "Goal",
  "celebrate.sub": "Power-play goal at {clock} of the {periodOrdinal}",
  "celebrate.continue": "Continue",

  // Skate tab rows, reusing the engine subtext wording (skateSubtext).
  "skate.row.engine": "Skate to {spotName} · {pct}% keeps puck",

  // The 14 offensive-zone spot display names (engine SpotName -> label). Key = spot.<SpotName>.
  "spot.point_left": "Left point",
  "spot.point_middle": "Middle point",
  "spot.point_right": "Right point",
  "spot.half_wall_left": "Left half-wall",
  "spot.half_wall_right": "Right half-wall",
  "spot.circle_top_left": "Left circle",
  "spot.circle_top_right": "Right circle",
  "spot.hash_left": "Left hash",
  "spot.hash_right": "Right hash",
  "spot.bumper_slot": "Bumper slot",
  "spot.slot": "Slot",
  "spot.net_front": "Net-front",
  "spot.goal_line_left": "Left goal line",
  "spot.goal_line_right": "Right goal line",

  // Footer links (How it works and About reuse nav.*).
  "footer.link.privacy": "Privacy",
  "footer.link.terms": "Terms",
  "footer.nav.label": "Site links",

  // End-of-run banners for the end reasons COPY.md does not cover.
  "end.gameEnd": "Time's up. The game ended before the power play did.",
  "end.emptyNet": "Empty net. The power play is over.",

  // Season-range-free variants, used while the export has no season range to show.
  "how.numbers.noRange":
    "Shooting, goaltending, faceoff and playmaking chances are built from NHL playoff play-by-play. Public data doesn't track passes or puck carries, so passing and skating chances are our estimates. Every percentage is a chance, not a guarantee.",
  "how.modes.endless.body.noRange": "Random real playoff power plays, back to back.",
  "home.tile.endless.body.noRange": "Random real playoff power plays.",
  "shot.footnote.noRange":
    "Built from real playoff power-play shots by type and distance, {lastName}'s finishing and the goalie's record.",

  // Legal pages: shown while lib/site.ts has no value for the date or contact email.
  "site.pending.date": "date to be added",
  "site.pending.email": "contact email to be added",

  // Accessible names for icon-only controls.
  "a11y.estimateInfo": "About this estimate",
  "a11y.legendInfo": "About these points",
  "a11y.backToHome": "Back to home",
} as const;

export type CopyKey = keyof typeof COPY | keyof typeof PENDING_COPY;
export type PendingCopyKey = keyof typeof PENDING_COPY;
export const PENDING_COPY_KEYS = Object.keys(PENDING_COPY) as PendingCopyKey[];

const ALL: Readonly<Record<string, string>> = { ...COPY, ...PENDING_COPY };
const VAR = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

const isProduction = (): boolean => process.env.NODE_ENV === "production";

/** Raw template for a key, `{vars}` untouched. Throws on an unknown key outside production. */
export function rawCopy(key: CopyKey): string {
  const value = ALL[key];
  if (value === undefined) {
    if (isProduction()) return key;
    throw new Error(`copy: unknown key "${key}"`);
  }
  return value;
}

/**
 * Look up a string and fill `{var}` placeholders.
 * Unknown key: throws in dev/test, returns the key in production.
 * Missing variable: throws in dev/test, leaves the `{var}` text in production (never crashes a screen).
 */
export function t(key: CopyKey, vars?: CopyVars): string {
  const value = ALL[key];
  if (value === undefined) {
    if (isProduction()) return key;
    throw new Error(`copy: unknown key "${key}"`);
  }
  return value.replace(VAR, (whole, name: string) => {
    const v = vars?.[name];
    if (v === undefined) {
      if (isProduction()) return whole;
      throw new Error(`copy: key "${key}" needs variable "${name}"`);
    }
    return String(v);
  });
}

/** True when `key` is a known copy key (for guards on data-driven keys). */
export function hasCopy(key: string): key is CopyKey {
  return Object.hasOwn(ALL, key);
}

/**
 * Engine pct() without the percent sign, for COPY.md `{pct}%` templates:
 * 0.123 -> "12", 0.001 -> "<1", NaN -> "n/a". The templates add the "%" themselves.
 */
export function pctValue(p: number): string {
  const s = pct(p);
  return s.endsWith("%") ? s.slice(0, -1) : s;
}

/** Display name of an offensive-zone spot (e.g. point_left -> "Left point"). */
export function spotName(spot: SpotName): string {
  return t(`spot.${spot}`);
}

/** COPY.md scoreboard.period note: 1st, 2nd, 3rd, OT, 2OT, ... Invalid input throws (Result is the engine's job). */
export function periodOrdinal(period: number): string {
  if (!Number.isInteger(period) || period < 1) throw new Error(`copy: invalid period ${period}`);
  if (period === 1) return "1st";
  if (period === 2) return "2nd";
  if (period === 3) return "3rd";
  return period === 4 ? "OT" : `${period - 3}OT`;
}
