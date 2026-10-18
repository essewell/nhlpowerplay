# PowerPlay — design spec

Source of truth: the "PowerPlay — Core Screens" design canvas (claude.ai). This file mirrors its
tokens so code can use them. Look: night-game scoreboard — deep navy ground, a bright ice rink,
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

Type: **Barlow Condensed** 600/700 for scoreboard numbers, headings and buttons;
**IBM Plex Sans** 400/500/600 for body. Radii 10 / 12 / 14 / 16 / 22. Touch targets >= 44 px.
Grades always pair colour with an icon and a word.

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
4. **Results** — result banner, the real bench's outcome, grade strip + legend, coach percentile,
   "your PP looks like", Share, Review my calls, Play Endless.

All "NN%" values in the canvas are placeholders; in code they come only from the engine.
