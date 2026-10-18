# PowerPlay — UI copy (owned by Cowork)

Source of truth for every user-facing string. Claude Code copies from here; change wording here first.
Voice and layout follow the "PowerPlay — Core Screens" design canvas (claude.ai). Where the canvas
already has a string, this file uses it word for word.

Rules for this file:
- No player stats or game facts are typed here. Moment titles and facts come only from
  `data-pipeline/data/curated_moments.json`; numbers come only from the engine or the export JSON.
- `{braces}` = runtime values filled by the app. `[brackets]` = notes for the developer, not copy.
- Modeled numbers (pass completion, carry retention, net-zone effects) are never described as history.
  Say "chance" or "estimate", never "record" or "stat".
- **No emoji anywhere in the app, share text included.** The grade marks ✓ • ▲ ✕ from docs/DESIGN.md
  are icons drawn as SVG, not emoji characters, and always appear next to a colour and a word.
- Case: the canvas sets headings, tabs and primary buttons in uppercase Barlow Condensed
  (TAKE THE BENCH, PASS, SHARE RESULT). Write them in sentence case here and apply uppercase in CSS
  (`text-transform: uppercase`), so screen readers don't spell them out letter by letter.
- Use a middle dot ( · ) as the separator, as in the canvas. Arrows (→) only in pass chains.

---

## 1. Global

| Key | Copy |
| --- | --- |
| app.name | PowerPlay |
| app.tagline | Call the power play in a real NHL moment. Every touch, you decide. |
| nav.daily | Daily |
| nav.endless | Endless |
| nav.howItWorks | How it works |
| nav.about | About |
| footer.notice | Not affiliated with the NHL or NHLPA. Game data from public NHL endpoints. |
| action.retry | Try again |
| action.back | Back |
| action.close | Close |
| offline.banner | You're offline. Your calls are saved on this device and will be scored when you reconnect. |
| reconnected.toast | Back online. Score submitted. |
| genericError.title | Something went wrong |
| genericError.body | That's on us. Try again, and reload the page if it keeps happening. |
| genericError.cta | Reload |

### Daily reset
- The Daily changes at **midnight Pacific time** (`America/Vancouver`, which switches between PST and PDT).
  [Claude Code: compute the day boundary in that zone, never in the player's local zone or UTC.]
- `daily.next`: Next Daily in {h}h {m}m

---

## 2. How it works

**Title:** How it works

**Intro:** You're behind the bench for a real NHL power play. Every time the puck lands on one of your
skaters' sticks, play pauses and you make the call.

**1. Take the bench**
Each scenario starts from a real power play: the real teams, the real score, the real clock and the
players who were on the ice.

**2. Make the call**
When play pauses, choose what your puck carrier does:
- **Pass** to a teammate
- **Skate** to a new spot
- **Shoot**, then pick the shot type and where you're aiming
- **Set play**, to run a power-play play your team uses

Every option shows its chance of working, so you're always choosing with the odds in front of you.

**3. Beat the clock**
The power play ends when you score, when the penalty runs out, or when the kill clears the puck and you
don't have time to get back in.

**4. See how you coached**
Every call gets a grade (Best, Close, Costly or Big miss), and you'll see what the real bench did with the
same power play.

**Where the numbers come from**
Shooting, goaltending, faceoff and playmaking chances are built from NHL playoff play-by-play, {firstSeason}
through {lastSeason}. [season range comes from the export, never typed] Public data doesn't track passes or puck carries, so passing and skating chances are our
estimates. Every percentage is a chance, not a guarantee.

**Modes**
- **Daily**: one famous power play a day, the same for everyone. One attempt. New Daily at midnight
  Pacific time.
- **Endless**: random real playoff power plays, {firstYear}–{lastYear}, back to back.

**CTA:** Take the bench

---

## 3. About

**Title:** About PowerPlay

PowerPlay is a fan-made hockey strategy game. Every scenario is a real NHL power play rebuilt from public
play-by-play data. You make the calls and see how they stack up against what really happened.

The chances on each option come from a model built on that data. Some parts are estimates (passing,
skating, and which part of the net a shot beats the goalie), because public data doesn't record them.
They're labelled as estimates and are never shown as historical stats.

Famous moments are checked twice: every fact comes from a published source, then gets confirmed against
the official play-by-play before the moment goes live. Sources are listed with each moment.

**Data and credits**
Game data comes from the NHL's public web endpoints. Community documentation: github.com/Zmalski/NHL-API-Reference.

**Notice**
PowerPlay is not affiliated with, endorsed by or sponsored by the National Hockey League (NHL), the NHL
Players' Association (NHLPA) or any team. Team and player names are used only to describe real games.

[Developer note: Emmett should get the notice wording reviewed before any commercial launch; the README
says to review the NHL site terms before commercial use.]

---

## 4. Screens

### 4.1 Home

| Key | Copy |
| --- | --- |
| wordmark | PowerPlay |
| tagline | Call the power play in a real NHL moment. Every touch, you decide. |
| daily.eyebrow | Today's Daily · No. {n} |
| daily.badge | Same for everyone |
| daily.stage | {stageName} · Game {gameNumber} [e.g. "2025 Stanley Cup Final · Game 1", built from scenario fields] |
| daily.yourBench | Your bench |
| daily.killing | Killing |
| daily.labels | Period · Clock · Strength |
| daily.clock | {m:ss} left |
| daily.strength | {pp}-on-{pk} |
| daily.stakes | {penaltyType} on {pkTeamName}. {stakesLine} Can you out-call the real bench? [stakesLine comes only from curated_moments.json or from clock and score rules, e.g. "Next goal wins Game {n}." in OT. If neither applies, drop it] |
| daily.cta | Take the bench |
| tile.daily.title | Daily |
| tile.daily.body | One famous power play a day. [v1 ships without the leaderboard: drop "Global rank." until v1.1] |
| tile.endless.title | Endless |
| tile.endless.body | Random real playoff power plays, {firstYear}–{lastYear}. [years from the export; canvas currently shows 2015–2026] |
| howItWorks.link | How it works |
| streak | {n}-day streak |
| streak.none | Start a streak: play today's Daily. |
| loading | Loading today's power play… [skeleton Daily card; tiles stay tappable] |
| daily.played | You've coached today's Daily. Next Daily in {h}h {m}m. |
| daily.played.cta | See your result |
| empty.noDaily.title | No Daily yet |
| empty.noDaily.body | Today's power play isn't ready. Try Endless while you wait. |
| empty.noDaily.cta | Play Endless |
| error.title | Couldn't load today's power play |
| error.body | Check your connection and try again. |
| error.cta | Try again |

### 4.2 Decision pause

| Key | Copy |
| --- | --- |
| scoreboard.period | {periodOrdinal} · {clock} [1st, 2nd, 3rd, OT, 2OT] |
| scoreboard.pp | PP {m:ss} · {pp}-on-{pk} |
| chip.paused | Paused · puck on {number}'s stick |
| chip.speed | {n}× |
| sheet.title | Your call · {lastName} |
| sheet.spot | {spotName} [e.g. "Left point"] |
| sheet.pkRead | PK read: {pkRead} [only when the engine supplies it; otherwise hide the row] |
| tabs | Pass · Skate · Shoot · Set play |
| pass.row.title | {lastName} |
| pass.row.sub | {spotName} · {laneDescription} [e.g. "Right circle · cross-seam"] |
| pass.row.pct | {pct}% connects |
| skate.row.title | {spotName} |
| skate.row.sub | {routeDescription} |
| skate.row.pct | {pct}% keeps puck |
| setplay.row.pct | {pct}% goal [see §5] |
| tag.estimate | Estimate [small tag on pass, skate and set-play rows; links to "Where the numbers come from"] |
| tag.lowSample | League average [when a rating is missing or flagged low-sample] |
| empty.pass | No open passing lanes. Skate or shoot. |
| empty.skate | No room to skate. Pass or shoot. |
| empty.setPlay | No set play fits this spot. |
| loading.scenario | Setting the lines… |
| loading.odds | Reading the kill… [tabs stay visible; rows show as skeletons] |
| error.title | Couldn't work out the chances |
| error.body | Something went wrong with this play. Your run is saved. |
| error.cta | Try again |
| end.goal | Power-play goal |
| end.expired | Penalty's over. Back to even strength. |
| end.cleared | Cleared, and not enough time to get back in. |
| end.shortie | Shorthanded goal against |
| resume.banner | Picking up where you left off. |

### 4.3 Shot picker

| Key | Copy |
| --- | --- |
| title | Shoot · {lastName} |
| subtitle | {spotName} · puck arriving from {passerNumber} [drop the second part on a carry-in shot] |
| section.type | Shot type |
| types | Wrist · Snap · Slap · One-timer · Backhand · Tip |
| type.pct | {pct}% goal |
| section.target | Target |
| goalieHand | Goalie catches {L/R} |
| targets | Top left · {blocker/glove} · Top right · {blocker/glove} · Low blocker · 5-hole · Low glove [corner labels follow the goalie's catching hand] |
| goalieHand.unknown | Goalie's catching hand unknown [corners then read Top left · Top right · Low left · Low right] |
| summary.selected | {shotType} · {targetLabel} |
| summary.labels | Goal · On net · Blocked |
| footnote | Built from real {firstYear}–{lastYearShort} playoff power-play shots by type and distance, {lastName}'s finishing and the goalie's record. |
| footnote.estimate | Where the shot beats the goalie is an estimate. [shown under the target grid] |
| cta | Shoot |
| cta.disabled | Pick a shot and a target |
| loading | Lining it up… |
| error.title | Couldn't load shot chances |
| error.body | Try again, or go back and make a different call. |
| error.cta | Try again |

### 4.4 Results

| Key | Copy |
| --- | --- |
| eyebrow | Daily No. {n} · {teamA} vs {teamB} [Endless: "Endless · {teamA} vs {teamB}"] |
| banner.goal | You score |
| banner.goal.sub | Power-play goal at {clock} of the {periodOrdinal} |
| banner.noGoal | Kill holds |
| banner.noGoal.sub | {reason} [Penalty expired / Cleared at {clock}] |
| banner.shortie | Shorthanded goal |
| realBench.label | The real bench |
| realBench.goal | Scored · {scorerLast} at {clock} |
| realBench.chain | {a} → {b} → {c} [only when the play-by-play or curated_moments.json names the assists] |
| realBench.noGoal | No goal · kill held |
| match.same | You matched it |
| match.better | You out-called it [you scored, the real bench didn't] |
| match.worse | They got this one [the real bench scored, you didn't] |
| match.bothMissed | Nobody scored |
| calls.label | Your calls |
| legend | ✓ Best call or within {bestThreshold} pts · • Close · ▲ Costly · ✕ Big miss [threshold comes from the grader constant] |
| legend.info | "pts" = percentage points of goal chance. A call 0.5 pts behind the best one means, say, 12.0% instead of 12.5%. [info tooltip on the legend; numbers in this example are illustrative, not data] |
| percentile.label | Coach percentile |
| percentile.value | {pct} |
| percentile.sub | vs simulated NHL benches |
| looksLike.label | Your PP looks like |
| looksLike.value | {teamName} |
| looksLike.sub | by call mix |
| looksLike.unknown | [Hide the card when no team matches closely enough] |
| cta.share | Share result |
| cta.review | Review my calls |
| cta.endless | Play Endless |
| share.text | PowerPlay Daily No. {n} · {teamA} vs {teamB} · {resultWord} · {best} best, {close} close, {costly} costly, {miss} big miss · {url} [plain text, no emoji; resultWord = "Scored" or "Kill held"] |
| share.copied | Copied |
| loading | Grading your calls… |
| loading.approx | Grading your calls (quick check)… |
| grades.approx | Approximate grades: your device ran a quicker check. |
| submit.pending | Score saved. It'll submit when you're back online. |
| submit.provisional | Provisional score |
| error.title | Couldn't grade this run |
| error.body | Your calls are saved. Try again to grade them. |
| error.cta | Try again |
| empty.noCalls | No calls to grade: the power play ended before the puck reached your skaters. |
| daily.alreadyPlayed | You've already played today's Daily. Here's your result. |

---

## 5. Set plays

Set play is a secondary control: the Set play tab sits last, and Pass, Skate and Shoot stay the main
calls. Each row reads `{playName}` · `{whatHappens}` · `{pct}% goal`.

### 5.1 Common power-play set plays (every team)
Standard hockey terms, not tied to any player or team stat.

| Key | Name | Sub-line |
| --- | --- | --- |
| setplay.oneTimer | One-timer | Feed across to the shooter in the circle |
| setplay.crossSeam | Cross-seam | Pass through the slot to the far circle |
| setplay.bumper | Bumper | Hit the middle man in the slot |
| setplay.pointShot | Point shot | Shoot from the point with traffic in front |
| setplay.netFrontTip | Net-front tip | Low shot for the net-front player to redirect |
| setplay.lowPlay | Low play | Work it below the goal line, then into the slot |
| setplay.overload | Half-wall overload | Cycle down the half-wall to pull the box over |

### 5.2 Team-specific set plays
- Name: `{shooterLast} one-timer` (also `{shooterLast} bumper`, `{shooterLast} net-front`).
- Show a team play only when the export data supports it, for example when that skater is the team's
  top power-play shooter from that spot in that season's play-by-play. Never pick a player by hand or
  from a well-known nickname. If the data doesn't support one, show only the common plays from 5.1.
- Sub-line: `{teammateLast} to {shooterLast} · {spotName}`.
- One-timers are fully playable: the One-timer shot type and the one-timer set plays both stay in.
  Their chances carry the **Estimate** tag, because public play-by-play doesn't label one-timers.
- `tag.oneTimer.info`: One-timers aren't tracked in public NHL data, so this chance is estimated from real
  slap and snap shots taken from the same spot.
- [Claude Code: proposed method in docs/DATA_STATUS.md, "One-timer proxy".]

---

## 6. Design v2 check (2026-10-18)
Checked "PowerPlay Core Screens v2" (`docs/design/PowerPlay_Core_Screens_v2.html`) against this file. Every string matches, there are no emoji, the legend reads "pts" with the
tooltip, and the Estimate tags and one-timer info line are as written here. One difference:
- The canvas still hard-codes the season range ("2015–2026", "2015–16 through 2025–26", "real 2015–26 power-play shots").
  Use the data-driven templates in this file ({firstYear}–{lastYear}). The playoff scope is moving back to 2009-10.
Sample names and times in the canvas (Point at 11:23, Hedman → Kucherov → Point, EDM–FLA OT 1:43 left) match verified entries in
curated_moments.json. In the app they must come from the data, never from the canvas.

## 7. Decisions and open questions
- Decided (2026-10-18, Emmett: "you decide"): the legend says "pts" and an info tooltip explains
  percentage points. The canvas's "0.5%" should be updated to match.
- Decided (2026-10-18, Emmett): one-timer shots and set plays stay in, with modeled chances tagged Estimate.
- Open: "Your PP looks like {team} by call mix" needs a definition of "call mix" that real data supports
   (public play-by-play has shot types and locations, not passes). That's an engine decision for
   Claude Code; the copy is ready either way.

---

## 8. Privacy policy (v1: no accounts, no backend)
[Draft. Accurate only if v1 really has no accounts, no backend, no analytics and no ads. Claude Code: if you add analytics,
error reporting or a backend, tell Cowork so this gets updated before launch. Not legal advice; Emmett should have it reviewed.]

**Title:** Privacy

**Last updated:** {date}

PowerPlay is a free fan-made game. We don't ask for your name or email, and you don't need an account.

**What stays on your device**
Your Daily results, streak and settings are saved in your browser's local storage so you can pick up where you left off.
They stay on your device. Clearing your browser data deletes them.

**What our host sees**
Like any website, our hosting provider handles standard technical data (such as your IP address and browser type) to
deliver the page and keep it secure. We don't use that data to identify you, and we don't sell it.

**What we don't do**
No ads. No tracking cookies. No selling or sharing of personal data.

**Kids**
PowerPlay isn't directed at children under 13 and doesn't knowingly collect their personal information.

**Changes and contact**
If this policy changes, we'll update the date above. Questions: {contactEmail}

## 9. Terms of use (v1)
[Draft, not legal advice. Have it reviewed before launch.]

**Title:** Terms of use

**Last updated:** {date}

1. **Free fan game.** PowerPlay is a free, non-commercial fan project. It is not affiliated with, endorsed by or sponsored
   by the National Hockey League (NHL), the NHL Players' Association (NHLPA) or any team.
2. **Game data.** Scenarios are rebuilt from publicly available NHL game data. Data is provided as-is and may contain
   errors. Percentages are model estimates, not predictions or historical statistics, except where labelled.
3. **Names and marks.** Team and player names are used only to describe real games. All trademarks belong to their owners.
4. **Fair play.** Don't try to break, overload or reverse-engineer the game or its scoring.
5. **No warranty.** The game is provided "as is", without warranties of any kind. We aren't liable for any loss from using it.
6. **Changes.** We may update the game or these terms at any time; continued use means you accept the changes.
7. **Contact:** {contactEmail}

## 10. Page metadata and share previews
| Key | Copy | Limit |
| --- | --- | --- |
| meta.title.home | PowerPlay · Coach a real NHL power play | ≤ 60 chars |
| meta.title.page | {pageName} · PowerPlay | |
| meta.description | Call the plays on real NHL power plays. Every time the puck hits your skater's stick, you decide: pass, skate, shoot or run a set play. New Daily every day. | ≤ 160 chars |
| og.title.default | PowerPlay | |
| og.description.default | Call the power play in a real NHL moment. Every touch, you decide. | |
| og.title.result | PowerPlay Daily No. {n} · {teamA} vs {teamB} | |
| og.description.result | {resultWord} · {best} best calls · Can you out-call the real bench? | |
| og.image | og-template.svg rendered per result (docs/design/assets/brand/), 1200×630 | |
| og.image.alt | PowerPlay result card: {teamA} vs {teamB}, {resultWord} | |
| twitter.card | summary_large_image | |
| app.manifest.name | PowerPlay | |
| app.manifest.short_name | PowerPlay | |
| app.manifest.description | Coach real NHL power plays. | |
| robots | index, follow (production only; previews noindex) | |
[Note: "NHL" appears in titles only as a description, never as a brand or logo. If the terms review says otherwise, drop it.]
