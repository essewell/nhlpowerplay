# Launch plan (v1)

Written by Cowork, 2026-10-18. Shared doc: Claude Code ticks items and adds notes; Cowork keeps the
content, data and terms items current.

## Decision: v1 scope (Emmett, 2026-10-18)
- **Ship without the backend.** Daily and Endless run fully on the device. Results, streaks and settings are
  saved in localStorage. Coach percentile stays (it's computed against simulated benches on the device).
- **Deferred to v1.1:** Step 6 (Supabase, anonymous auth, `POST /api/runs`, server scoring, global leaderboard).
  The "Global rank" line comes off the Daily tile until then (COPY.md).
- **Data scope:** playoffs only, 2009-10 onward (see DATA_STATUS.md). No pre-2009 moments in v1.

## Parallel tracks
| Track | Owner | Status |
| --- | --- | --- |
| A. Pipeline fixes (strength from restart, misconducts) + 2009-10 rebuild | Claude Code (pipeline) → Emmett runs stage 3 → Cowork verifies 27 curated | in progress |
| B. Step 3 finish (sync + gate test) | Claude Code (app) | waiting on A |
| C. Step 4 screens from design v2 (+ How it works, About, Privacy, Terms, states) | Claude Code (app) | can start now on current export |
| D. Step 5 grader, results, share (share = plain text + OG card) | Claude Code (app) | after C |
| E. Deploy: Netlify site `powerplay-game` created; link GitHub repo, previews per PR, production domain | Claude Code (link + build config) | site created, not linked |
| F. Copy, privacy, terms, metadata | Cowork | drafted (COPY.md §8–10) |
| G. NHL terms review | Cowork summary below; Emmett decides | done (summary) |

## Hosting decision (Emmett, 2026-10-18)
Netlify instead of Vercel: personal team `essewell`, Free plan. No API routes are needed in v1 (no backend), so the site
can be static or use the Next.js runtime, whichever the app session's build needs.

## Go / no-go checklist
Data
- [ ] Stage 3 rebuilt on the fixed pipeline; `run_status.json` all 0; 27/27 curated verified
- [ ] No zero-length or over-length power plays in the mined pool; loader gate test passes on the full export
- [ ] Schedule covers at least 90 days from launch day (Pacific time)
- [ ] `data/raw/` and `powerplay.db` excluded from git (.gitignore)

App
- [ ] Playwright mobile test plays Daily start to finish (Step 4 gate)
- [ ] axe: no contrast errors; every grade shows icon + colour + word
- [ ] One pause grades in < 150 ms on a mid-range phone profile, or falls back to "approx" (Step 5 gate)
- [ ] Reload mid-run resumes; no second Daily attempt; Daily rolls over at midnight America/Vancouver
- [ ] Offline: run finishes and is saved locally
- [ ] No synthetic fixture bundled in production (build fails if one is)
- [ ] No hard-coded years, stats or names: everything from export + COPY.md

Content and legal
- [ ] Privacy + Terms pages live and accurate to what v1 actually does (no analytics/ads unless the policy is updated)
- [ ] Non-affiliation notice in footer, About and Terms
- [ ] No NHL/NHLPA/team logos, crests or team colour schemes anywhere (including OG images)
- [ ] Emmett has read the NHL terms summary below and accepted the risk, or sought advice
- [ ] Contact email set ({contactEmail} in COPY.md)

Deploy
- [x] Netlify site created on Emmett's personal team `essewell` (slug `ess-hobby61263`, Free): `powerplay-game`,
      site id `57a4d603-e4a7-48ca-996c-b056e6cf5c96`, https://powerplay-game.netlify.app (Vercel dropped, 2026-10-18)
- [x] Repo linked (base directory `apps/web`), Next.js build verified on Netlify, deploy previews per PR
      (Claude Code 2026-10-18: linked to essewell/nhlpowerplay in Netlify monorepo mode, package dir apps/web;
      production https://powerplay-game.netlify.app built from 81515cc; PR #1 preview built)
- [x] Previews not indexed (check that the X-Robots-Tag noindex header is present on a deploy preview)
      (verified: deploy-preview-1 sends `X-Robots-Tag: noindex`; production does not)
- [x] Production domain: https://powerplay-game.netlify.app (Netlify free subdomain; no custom domain for v1, Emmett 2026-10-18). HTTPS is on by default on netlify.app; confirm after first deploy
- [ ] Favicon, PWA manifest, apple-touch-icon, OG image wired from docs/design/assets/brand/
- [ ] Smoke test on iOS Safari and Android Chrome at 390 px

## NHL Terms of Service: what matters for PowerPlay
Summary for Emmett, not legal advice. Source: NHL Terms of Service, https://www.nhl.com/terms, "Last Updated: October 29, 2025"
(fetched 2026-10-18).
- **Automated collection:** Section 2 (Prohibited Content and Activities) bars "unauthorized spidering, scraping, or harvesting of
  content or information" and actions that impose "an unreasonable or disproportionately large load on our network or infrastructure".
  The pipeline fetches NHL endpoints automatically, at 0.5 s per request, about 2,000-3,000 requests per build.
- **Personal, non-commercial use:** Section 7 (Intellectual Property): "You may access, use, and display the Services, but only for
  non-commercial, informational, personal use". It also says you "may not copy, reproduce, distribute, publish, enter into a
  database, display" content.
- **Revenue:** embedded NHL content must be "for non-commercial purposes only"; "gaining advertising, subscription, or other
  revenue" is listed as prohibited commercial use without written approval.
- **Marks:** "the NHL Shield, and the word mark and image of the Stanley Cup are registered trademarks" and "may not be reproduced or
  used commercially without the prior written consent of NHL Enterprises, L.P." PowerPlay uses no logos; it does use the words
  "Stanley Cup Final" as a stage name in text.
- The Terms don't mention statistics, scores or the api-web/api.nhle.com endpoints specifically.

What this means in practice (Cowork's reading; Emmett decides):
- A free, ad-free fan game is the lowest-risk version. Any ads, subscriptions or paid features raise the risk sharply under the
  revenue clause.
- Building a database from NHL responses and publishing derived data is the main tension with the scraping and "enter into a
  database" language. Mitigations already in place: low request rate, cached responses (no repeat load), no logos, clear
  non-affiliation notice. A lawyer can say whether facts like scores and play-by-play events are protected where you launch.
- Before monetizing, or if the NHL objects: get legal advice, or license data from a commercial provider.
