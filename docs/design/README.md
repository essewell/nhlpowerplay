# docs/design

Design source for PowerPlay. `docs/DESIGN.md` mirrors the tokens and specs in code-friendly form; this folder holds
the canvases and the exported assets.

| File | What it is |
| --- | --- |
| `PowerPlay_Core_Screens_v2.html` | **Current source of truth.** Standalone canvas (open in a browser): 4 core screens, Set play tab, One-timer Estimate states, all Results variants, How it works, About, every loading/empty/error state, brand, grade icons, rink kit, set-play diagrams, token sheet. |
| `PowerPlay_Core_Screens_v1.html` | Original canvas (superseded; kept for history). |
| `assets/` | 41 asset files taken out of the v2 canvas (see below). |

## assets/

| Folder | Files |
| --- | --- |
| `brand/` | wordmark-light / -dark / -mono-light / -mono-dark (.svg), app-mark.svg, favicon.svg, favicon-32.png, favicon-16.png, pwa-192.png, pwa-512.png, pwa-maskable-192.png, pwa-maskable-512.png (80% safe zone), apple-touch-icon-180.png, og-template.svg (1200×630, slots `#slot-eyebrow`, `#slot-team-a`, `#slot-score`, `#slot-team-b`, `#slot-result`, `#slot-grade-1…6`, `#slot-url`), og-sample.png |
| `grades/` | grade-best / -close / -costly / -miss (.svg tiles for strips and legends) and the same with `-glyph.svg` for light grounds |
| `rink/` | oz-rink.svg (viewBox −42.5 0 85 77, 1 unit = 1 ft, 2 in lines), oz-rink-display.svg (same geometry, 6 in lines for phone scale), token-pp-skater, token-pk-skater, token-goalie, token-puck-carrier, token-selected, pass-lane (.svg) |
| `setplays/` | one-timer, cross-seam, bumper, point-shot, net-front-tip, low-play, half-wall-overload (.svg thumbnails 52×47) and legend-pass / -skate / -shot (.svg) |

How these were made (2026-10-18, Cowork): the v2 canvas embeds every asset as a data URI and lists it by
filename. Each file was decoded byte for byte from the canvas, and the name comes from the canvas caption next to it.
Every name was then checked on a contact sheet. Not included: `og-sample.svg` (the canvas only shows the PNG). If the
design session later exports the asset folder directly, that export replaces these files.

## Rules
- No NHL, NHLPA or team logos, wordmarks, crests or team colour schemes. Teams appear only as 3-letter abbreviations.
- Grade marks are these SVG icons, never emoji, always shown with their colour and their word.
- All copy comes from `docs/COPY.md`. Names, scores and times in the canvas are placeholders or samples from
  `data-pipeline/data/curated_moments.json`. In the app they come from the data, never from the canvas.
- Season ranges in the canvas ("2015–2026") are out of date: the app fills them from the export (COPY.md §6).
- App use: Claude Code copies what it needs from `assets/` into `apps/web/public/`. This folder stays the design source.
