# PowerPlay — design spec

Source of truth: `docs/design/PowerPlay_Core_Screens_v2.html` (v2 canvas, 2026-10-18; v1 kept alongside for history).
This file mirrors its tokens so code can use them. Assets live in `docs/design/assets/` (see `docs/design/README.md`).
All copy comes from `docs/COPY.md`. Look: night-game scoreboard — deep navy ground, a bright ice rink,
one goal-light orange accent. Mobile first, 390 x 844 reference frame.

## Tokens

| Token | Value | Use |
| --- | --- | --- |
| bg | #0B1220 | Page ground |
| surface | #131C2E | Cards, sheets |
| surface-sunk | #0F1828 | Inputs, list rows, inactive tabs |
| border | #26324A | 1 px borders |
| text | #EEF3F7 | Primary text |
| text-muted | #B7C3D3 | Secondary text (passes 4.5:1 on surface) |
| accent | #FF8A2B | Primary buttons, selection, the puck carrier |
| on-accent | #1A0E04 | Text on accent |
| pp | #9CCBFF / fill #13305A | Your skaters |
| pk | #5E6B7D | Penalty killers and goalie |
| ice | #DCE6EF | Rink surface |
| rink-red | #C8102E | Goal line, circles, net |
| blue-line | #2F6FD6 | Blue line |
| grade-best | #2E9E6B + ✓ | Best call or within 0.5 pp |
| grade-close | #E8C547 + • | Close |
| grade-costly | #E07A2E + ▲ | Costly |
| grade-miss | #8E1F35 + ✕ | Big miss |

### Tokens added in v2
Used in the canvas but missing from the table above:

| Token | Value | Use |
| --- | --- | --- |
| text-soft | #D5DEE9 | Stakes line, PK read, legend |
| border-strong | #3A4A66 | Net targets, tags, tooltips |
| surface-raised | #1E2A40 | Active tab, tooltips |
| accent-sunk | #2A1C10 | Selected tile fill |
| on-accent-sunk | #FFD9B8 | Label on accent-sunk |
| pk-team | #8593A6 | Killing team bar |
| on-grade-close | #1A1404 | Glyph on grade-close |

New in v2:

| Token | Value | Use |
| --- | --- | --- |
| skeleton | #1A2438 | Loading placeholders |
| accent-on-light | #C2560E | Dark wordmark "PLAY" (4.53:1 on white) |
| shadow-pop | 0 12px 28px rgba(0,0,0,.45) | Tooltips only |

Type: **Barlow Condensed** 600/700 for scoreboard numbers, headings and buttons;
**IBM Plex Sans** 400/500/600 for body. Radii 10 / 12 / 14 / 16 / 22, plus (v2) 6 (chips, Estimate tag), 18 (Home Daily card),
20 (Results banner), 40 40 8 8 (rink), 999 (pills). Touch targets >= 44 px.
Grades always pair colour with an icon and a word. Icons are the SVGs in `docs/design/assets/grades/` (tiles on dark,
`-glyph` on light), never emoji. Shape carries the grade, so it still reads in greyscale.

### Component specs (v2)
- **Estimate tag** (on every modeled chance: pass, skate, set play, one-timer, net target): 11 px / 600, line 16,
  padding 0 6, radius 6, 1 px #3A4A66 border, text #B7C3D3. Its info button opens the explanation from COPY.md.
- **Info button:** 18 px glyph (16 in the legend), 44 × 44 hit area.
- **Tooltip:** #1E2A40, 1 px #3A4A66, radius 12, padding 12 14, 13 px / 1.45, shadow-pop.
- **Grade icon sizes:** 16 / 24 / 48 px. **Set play thumbnail:** 52 × 47, radius 8.
- **Rink:** `oz-rink.svg` for geometry (1 unit = 1 ft), `oz-rink-display.svg` for phone scale. Skater tokens:
  PP 44, PK 28, goalie 26, puck carrier 50, selected 44 + ring; dashed pass lanes.

## Screens

1. **Home** — wordmark, Daily card (stage, teams, score, period, clock, strength, one-line stakes,
   "Take the bench"), Daily / Endless tiles, How it works, streak.
2. **Decision pause** — scoreboard with PP timer; "Paused · puck on NN's stick" chip; rink
   (offensive zone, net at top, your skaters as tappable numbered circles, carrier in accent,
   dashed lanes to pass targets); bottom sheet: carrier name and spot, PK read, tabs
   PASS / SKATE / SHOOT / SET PLAY, option rows with "NN% connects" / "NN% keeps puck" and a meter.
3. **Shot picker** — shot type grid (wrist, snap, slap, one-timer, backhand, tip) each with % goal;
   net with five targets (four corners labelled glove/blocker from the goalie's catch hand,
   plus five-hole) each with % goal; summary of % goal, on net, blocked; SHOOT button.
4. **Results** — result banner (You score / Kill holds / Shorthanded goal), the real bench's outcome and match line
   (You matched it / You out-called it / They got this one / Nobody scored), grade strip + legend ("within 0.5 pts"
   with an info tooltip explaining percentage points), coach percentile, "Your PP looks like {team} by call mix",
   Share result, Review my calls, Play Endless.

Added in v2: **Set play tab** on the decision pause (7 common plays, each with a diagram and Estimate tag); **Shot picker**
with One-timer marked Estimate and an info state; **How it works**; **About** (with the non-affiliation notice); loading,
empty and error states for every screen.

All "NN%" values in the canvas are placeholders; in code they come only from the engine.
