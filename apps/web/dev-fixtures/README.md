# Dev fixtures (SYNTHETIC: invented data)

Every file here is **invented** for local development and tests. None of it is a real game,
player, team or statistic: ids are in the unused 99xxxxx range, names are placeholders, team
abbreviations are `AAA` / `BBB`, and every number is made up.

- File names end in `.synthetic.json`. The scenario also carries `"synthetic": true` at its top
  level; the other files are JSON arrays (no room for a flag), so the filename suffix and this
  README are their label.
- Shapes mirror `data-pipeline/data/export/` (one scenario, `base_rates`, the four rating files,
  `schedule`, `endless_index`) and are validated against `packages/engine/src/schema.ts` in
  `apps/web/test/data-sync.test.ts`.
- They must never ship: `apps/web/scripts/check-no-synthetic.ts` runs as `prebuild` (over
  `public/`) and `postbuild` (over `.next/`) and fails the build on any `*.synthetic.json` file or
  `"synthetic": true` marker. Real data reaches `public/data/` only through `pnpm data:sync`.
