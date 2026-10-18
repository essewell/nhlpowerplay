# PENDING_COPY: strings COPY.md does not have yet

Owner: Cowork. These are drafts written by Claude Code (user-approved) so the screens can be built. They live in
`apps/web/lib/copy.ts` under `PENDING_COPY` ("draft — pending COPY.md"). When you add a string to `docs/COPY.md`,
tell Claude Code to move it into `COPY` and delete it from `PENDING_COPY`. `lib/copy.test.ts` fails if this file and
`PENDING_COPY` disagree.

Rules followed: templates only (no game facts, years, names or percentages), no emoji, sentence case (CSS uppercases
headings and buttons), middle dot as separator. `{pct}` is a number without the percent sign: write `{pct}%`.

| Key | Draft copy | Used for |
| --- | --- | --- |
| faceoff.title | Opening faceoff | Opening faceoff call |
| faceoff.body | Pick who takes the draw and where it goes. | Opening faceoff call |
| faceoff.taker.label | Taker | Opening faceoff call |
| faceoff.target.label | Send it to | Opening faceoff call |
| faceoff.target.point | Point | Opening faceoff call |
| faceoff.target.halfWall | Half wall | Opening faceoff call |
| faceoff.target.back | Back | Opening faceoff call |
| faceoff.row.title | {lastName} | Opening faceoff call |
| faceoff.row.pct | {pct}% wins the draw | Opening faceoff call |
| faceoff.target.pct | {pct}% gets it there | Opening faceoff call |
| faceoff.cta | Drop the puck | Opening faceoff call |
| faceoff.error.title | Couldn't price the faceoff | Opening faceoff call |
| entry.title | Zone entry | Zone-entry call |
| entry.body | How do you get over the blue line? | Zone-entry call |
| entry.carry | Carry in | Zone-entry call |
| entry.carry.sub | Skate it over the blue line | Zone-entry call |
| entry.drop | Drop pass | Zone-entry call |
| entry.drop.sub | Leave it for a trailing teammate | Zone-entry call |
| entry.dump | Dump in | Zone-entry call |
| entry.dump.sub | Chip it deep and chase | Zone-entry call |
| entry.pct | {pct}% gains the zone | Zone-entry call |
| celebrate.title | Goal | Post-goal celebration |
| celebrate.sub | Power-play goal at {clock} of the {periodOrdinal} | Post-goal celebration |
| celebrate.continue | Continue | Post-goal celebration |
| skate.row.engine | Skate to {spotName} · {pct}% keeps puck | Skate tab rows |
| spot.point_left | Left point | Offensive-zone spot names (engine SpotName -> label) |
| spot.point_middle | Middle point | Offensive-zone spot names (engine SpotName -> label) |
| spot.point_right | Right point | Offensive-zone spot names (engine SpotName -> label) |
| spot.half_wall_left | Left half-wall | Offensive-zone spot names (engine SpotName -> label) |
| spot.half_wall_right | Right half-wall | Offensive-zone spot names (engine SpotName -> label) |
| spot.circle_top_left | Left circle | Offensive-zone spot names (engine SpotName -> label) |
| spot.circle_top_right | Right circle | Offensive-zone spot names (engine SpotName -> label) |
| spot.hash_left | Left hash | Offensive-zone spot names (engine SpotName -> label) |
| spot.hash_right | Right hash | Offensive-zone spot names (engine SpotName -> label) |
| spot.bumper_slot | Bumper slot | Offensive-zone spot names (engine SpotName -> label) |
| spot.slot | Slot | Offensive-zone spot names (engine SpotName -> label) |
| spot.net_front | Net-front | Offensive-zone spot names (engine SpotName -> label) |
| spot.goal_line_left | Left goal line | Offensive-zone spot names (engine SpotName -> label) |
| spot.goal_line_right | Right goal line | Offensive-zone spot names (engine SpotName -> label) |
| footer.link.privacy | Privacy | Footer links |
| footer.link.terms | Terms | Footer links |
| footer.nav.label | Site links | Footer links |
| end.gameEnd | Time's up. The game ended before the power play did. | End-of-run banners |
| end.emptyNet | Empty net. The power play is over. | End-of-run banners |
| how.numbers.noRange | Shooting, goaltending, faceoff and playmaking chances are built from NHL playoff play-by-play. Public data doesn't track passes or puck carries, so passing and skating chances are our estimates. Every percentage is a chance, not a guarantee. | Season-range-free variants (used while the export gives no season range) |
| how.modes.endless.body.noRange | Random real playoff power plays, back to back. | Season-range-free variants (used while the export gives no season range) |
| home.tile.endless.body.noRange | Random real playoff power plays. | Season-range-free variants (used while the export gives no season range) |
| shot.footnote.noRange | Built from real playoff power-play shots by type and distance, {lastName}'s finishing and the goalie's record. | Season-range-free variants (used while the export gives no season range) |
| site.pending.date | date to be added | Legal pages: placeholders while lib/site.ts has no value |
| site.pending.email | contact email to be added | Legal pages: placeholders while lib/site.ts has no value |
| a11y.estimateInfo | About this estimate | Accessible names for icon-only controls |
| a11y.legendInfo | About these points | Accessible names for icon-only controls |
| a11y.backToHome | Back to home | Accessible names for icon-only controls |
