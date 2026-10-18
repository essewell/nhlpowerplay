/**
 * Zod schemas for every file the data pipeline exports (data-pipeline/data/export), plus typed
 * parsers that return Result with a readable "<file>: <path>: <message>" error. Parsers use
 * safeParse and never throw.
 *
 * Stateless (schemas are immutable module constants): safe in Web Workers, on the server and in
 * the data:sync script. No randomness, no clock: calendar dates are checked arithmetically.
 *
 * Scenario shape: the pipeline is gaining state.penalties, state.goalie_pulled and pp.bench. They
 * are OPTIONAL here so files exported before that change still validate; loader.ts fills them
 * with an explicit, flagged fallback. ScenarioStrict requires them (use it for new exports).
 */
import { z } from "zod";
import { PENALTY_S } from "./constants.ts";
import { periodLengthS, strengthOf } from "./clock.ts";
import { err, ok, type Result } from "./result.ts";
import type { GameType, Penalty } from "./sim-types.ts";

// ============================================================================ primitives

const MAX_UINT32 = 0xffff_ffff;
const MONTHS_PER_YEAR = 12;
/** Days per month in a common year (index 0 = January). Calendar rule, not data. */
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;
const FEBRUARY = 2;
/** Gregorian leap-year rule. O(1). */
const isLeap = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** True for a real Gregorian calendar date written YYYY-MM-DD. O(1). */
export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (m === null) return false;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > MONTHS_PER_YEAR) return false;
  const base = DAYS_IN_MONTH[mo - 1];
  if (base === undefined) return false;
  const max = mo === FEBRUARY && isLeap(y) ? base + 1 : base;
  return d >= 1 && d <= max;
}

const CalendarDate = z.string().refine(isCalendarDate, { message: "must be a real calendar date YYYY-MM-DD" });
const NonNegInt = z.int().min(0);
const PosInt = z.int().min(1);
const Prob = z.number().min(0).max(1);
const PosMult = z.number().positive().refine(Number.isFinite, { message: "must be finite" });
const Flag01 = z.union([z.literal(0), z.literal(1)]);
/** Scenario ids double as file names: letters, digits, '-' and '_' only. */
const SCENARIO_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const ScenarioId = z.string().regex(SCENARIO_ID_RE, { message: "must be a file-safe id ([A-Za-z0-9_-])" });

/** "all" or a season "YYYYZZZZ" with ZZZZ = YYYY + 1. */
export const SCOPE_ALL = "all";
const Scope = z.string().refine((s) => {
  if (s === SCOPE_ALL) return true;
  const m = /^(\d{4})(\d{4})$/.exec(s);
  return m !== null && Number(m[2]) === Number(m[1]) + 1;
}, { message: `must be "${SCOPE_ALL}" or a season like "20232024"` });

/** O(N). Adds an issue for every row whose (player_id, scope) repeats an earlier row. */
function uniqueKeys<T extends { player_id: number; scope: string }>(rows: T[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const k = `${r.player_id}|${r.scope}`;
    if (seen.has(k)) ctx.addIssue({ code: "custom", path: [i], message: `duplicate (player_id, scope) ${r.player_id}, ${r.scope}` });
    seen.add(k);
  });
}

// ============================================================================ base rates

export const BaseRateExportRow = z.object({
  scope: Scope,
  shot_type: z.string().min(1),
  dist_bucket: NonNegInt,
  attempts: NonNegInt,
  on_net: NonNegInt,
  goals: NonNegInt,
  p_unblocked: Prob,
  p_on_net: Prob,
}).superRefine((r, ctx) => {
  if (r.on_net > r.attempts) ctx.addIssue({ code: "custom", path: ["on_net"], message: "on_net exceeds attempts" });
  if (r.goals > r.on_net) ctx.addIssue({ code: "custom", path: ["goals"], message: "goals exceed on_net" });
});
export const BaseRatesFile = z.array(BaseRateExportRow).superRefine((rows, ctx) => {
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    const k = `${r.scope}|${r.shot_type}|${r.dist_bucket}`;
    if (seen.has(k)) ctx.addIssue({ code: "custom", path: [i], message: `duplicate (scope, shot_type, dist_bucket) ${k}` });
    seen.add(k);
  });
});
export type BaseRateExportRow = z.infer<typeof BaseRateExportRow>;
export type BaseRatesFile = z.infer<typeof BaseRatesFile>;

// ============================================================================ ratings

export const ShooterRatingRow = z.object({
  player_id: PosInt,
  scope: Scope,
  attempts: NonNegInt,
  on_net: NonNegInt,
  goals: NonNegInt,
  xg: z.number().min(0),
  finishing_mult: PosMult,
  accuracy: z.number().gt(0).max(1),
  /** Display rating; the pipeline leaves it null for low-sample rows. */
  rating: z.int().min(0).max(100).nullable(),
  low_sample: Flag01,
});
export const GoalieRatingRow = z.object({
  player_id: PosInt,
  scope: Scope,
  on_net: NonNegInt,
  ga: NonNegInt,
  xga: z.number().min(0),
  ga_mult: PosMult,
  rating: z.int().min(0).max(100).nullable(),
  low_sample: Flag01,
});
export const FaceoffRatingRow = z.object({
  player_id: PosInt,
  scope: Scope,
  won: NonNegInt,
  taken: NonNegInt,
  /** Shrunk rate; open interval because the engine rejects a certain win or loss. */
  win_rate: z.number().gt(0).lt(1),
}).refine((r) => r.won <= r.taken, { message: "won exceeds taken", path: ["won"] });
export const PlaymakerRatingRow = z.object({
  player_id: PosInt,
  scope: Scope,
  a1: NonNegInt,
  presence: NonNegInt,
  playmaking_mult: PosMult,
});
export const ShooterRatingsFile = z.array(ShooterRatingRow).superRefine(uniqueKeys);
export const GoalieRatingsFile = z.array(GoalieRatingRow).superRefine(uniqueKeys);
export const FaceoffRatingsFile = z.array(FaceoffRatingRow).superRefine(uniqueKeys);
export const PlaymakerRatingsFile = z.array(PlaymakerRatingRow).superRefine(uniqueKeys);
export type ShooterRatingRow = z.infer<typeof ShooterRatingRow>;
export type GoalieRatingRow = z.infer<typeof GoalieRatingRow>;
export type FaceoffRatingRow = z.infer<typeof FaceoffRatingRow>;
export type PlaymakerRatingRow = z.infer<typeof PlaymakerRatingRow>;

// ============================================================================ schedule, endless

export const ScheduleRow = z.object({ date: CalendarDate, scenario_id: ScenarioId });
export const ScheduleFile = z.array(ScheduleRow).superRefine((rows, ctx) => {
  const seen = new Set<string>();
  rows.forEach((r, i) => {
    if (seen.has(r.date)) ctx.addIssue({ code: "custom", path: [i, "date"], message: `duplicate date ${r.date}` });
    seen.add(r.date);
  });
});
export const EndlessIndexFile = z.array(ScenarioId).superRefine((ids, ctx) => {
  const seen = new Set<string>();
  ids.forEach((id, i) => {
    if (seen.has(id)) ctx.addIssue({ code: "custom", path: [i], message: `duplicate scenario id ${id}` });
    seen.add(id);
  });
});
export type ScheduleRow = z.infer<typeof ScheduleRow>;
export type ScheduleFile = z.infer<typeof ScheduleFile>;
export type EndlessIndexFile = z.infer<typeof EndlessIndexFile>;

// ============================================================================ scenario

const SKATER_POSITIONS = ["C", "L", "R", "D"] as const;
const MAX_SWEATER_NUMBER = 99;
const Person = {
  id: PosInt,
  team_id: PosInt,
  first: z.string().min(1),
  last: z.string().min(1),
  number: z.int().min(0).max(MAX_SWEATER_NUMBER),
};
export const ScenarioSkater = z.object({ ...Person, pos: z.enum(SKATER_POSITIONS) });
export const ScenarioGoalie = z.object({ ...Person, pos: z.literal("G") });
export type ScenarioSkater = z.infer<typeof ScenarioSkater>;
export type ScenarioGoalie = z.infer<typeof ScenarioGoalie>;

export const ScenarioPenalty = z.object({
  side: z.enum(["pp", "pk"]),
  player_id: PosInt.nullable(),
  kind: z.enum(["minor", "double_minor", "major"]),
  remaining_s: PosInt,
  queued: z.boolean(),
}).refine((p) => p.remaining_s <= PENALTY_S[p.kind], { message: "remaining_s exceeds the penalty length", path: ["remaining_s"] });
export type ScenarioPenalty = z.infer<typeof ScenarioPenalty>;

const STRENGTH_RE = /^(\d+)v(\d+)$/;
/** "5v4" -> { pp: 5, pk: 4 }; null when the string is not N v M. O(1). */
export function parseStrength(s: string): { pp: number; pk: number } | null {
  const m = STRENGTH_RE.exec(s);
  return m === null ? null : { pp: Number(m[1]), pk: Number(m[2]) };
}

const teamSide = {
  team_id: PosInt,
  abbrev: z.string().min(1),
  skaters: z.array(ScenarioSkater),
  goalie: ScenarioGoalie,
  on_ice_source: z.string().min(1),
};

const ScenarioBase = z.object({
  id: ScenarioId,
  seed: z.int().min(0).max(MAX_UINT32),
  game: z.object({
    /** NHL game ids are 10 digits: season start year, game type, game number. */
    nhl_game_id: z.int().min(1_000_000_000).max(9_999_999_999),
    date: CalendarDate,
    game_type: z.union([z.literal(2), z.literal(3)]),
    home: z.string().min(1),
    away: z.string().min(1),
    stage: z.string().min(1),
  }),
  state: z.object({
    period: PosInt,
    clock_elapsed_s: NonNegInt,
    strength: z.string().regex(STRENGTH_RE, { message: "must look like 5v4" }),
    score: z.object({ pp: NonNegInt, pk: NonNegInt }),
    pp_remaining_s: PosInt,
    penalties: z.array(ScenarioPenalty).optional(),
    goalie_pulled: z.boolean().optional(),
  }),
  pp: z.object({ ...teamSide, bench: z.array(ScenarioSkater).optional() }),
  pk: z.object(teamSide),
  real_outcome: z.object({
    result: z.enum(["goal", "no_goal", "sh_goal_against"]),
    scorer_id: PosInt.nullable(),
    assist1_id: PosInt.nullable(),
    assist2_id: PosInt.nullable(),
    end_t: NonNegInt,
  }),
  narrative: z.object({ title: z.string().min(1), sources: z.array(z.url()).min(1) }),
  verification: z.object({ status: z.string().min(1), warnings: z.array(z.string()) }),
});
type ScenarioBaseT = z.infer<typeof ScenarioBase>;

/** Engine penalties for a strength check only: expiry values are placeholders (strengthOf counts active ones). O(K). */
function strengthCheckPenalties(ps: ScenarioPenalty[]): Penalty[] {
  return ps.map((p, i) => ({ id: i + 1, side: p.side, kind: p.kind, expiresAtS: p.queued ? null : 0, durationS: PENALTY_S[p.kind] }));
}

/** Cross-field rules of a scenario. O(S + K) for S listed players and K penalties. */
function scenarioRules(s: ScenarioBaseT, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  const gt: GameType = s.game.game_type;
  const len = periodLengthS(s.state.period, gt);
  if (!len.ok) issue(["state", "period"], len.error);
  else if (s.state.clock_elapsed_s > len.value) {
    issue(["state", "clock_elapsed_s"], `exceeds period length ${len.value}`);
  }
  const st = parseStrength(s.state.strength);
  if (st !== null) {
    if (s.pp.skaters.length !== st.pp) issue(["pp", "skaters"], `strength ${s.state.strength} needs ${st.pp} PP skaters on ice, got ${s.pp.skaters.length}`);
    if (s.pk.skaters.length !== st.pk) issue(["pk", "skaters"], `strength ${s.state.strength} needs ${st.pk} PK skaters on ice, got ${s.pk.skaters.length}`);
    const pens = s.state.penalties;
    if (pens !== undefined && len.ok) {
      const pulledOptions = s.state.goalie_pulled === undefined ? [false, true] : [s.state.goalie_pulled];
      const fits = pulledOptions.some((pulled) => {
        const r = strengthOf(strengthCheckPenalties(pens), pulled, s.state.period, gt);
        return r.ok && r.value.pp === st.pp && r.value.pk === st.pk;
      });
      if (!fits) issue(["state", "penalties"], `penalties do not produce strength ${s.state.strength}`);
    }
  }
  if (s.pp.team_id === s.pk.team_id) issue(["pk", "team_id"], "PP and PK are the same team");
  const abbrevs = [s.game.home, s.game.away];
  if (!abbrevs.includes(s.pp.abbrev)) issue(["pp", "abbrev"], `not one of the game's teams (${abbrevs.join(", ")})`);
  if (!abbrevs.includes(s.pk.abbrev)) issue(["pk", "abbrev"], `not one of the game's teams (${abbrevs.join(", ")})`);
  const seen = new Set<number>();
  const claim = (path: (string | number)[], p: { id: number; team_id: number }, teamId: number) => {
    if (seen.has(p.id)) issue([...path, "id"], `player ${p.id} listed twice`);
    seen.add(p.id);
    if (p.team_id !== teamId) issue([...path, "team_id"], `player ${p.id} is not on team ${teamId}`);
  };
  s.pp.skaters.forEach((p, i) => claim(["pp", "skaters", i], p, s.pp.team_id));
  (s.pp.bench ?? []).forEach((p, i) => claim(["pp", "bench", i], p, s.pp.team_id));
  claim(["pp", "goalie"], s.pp.goalie, s.pp.team_id);
  s.pk.skaters.forEach((p, i) => claim(["pk", "skaters", i], p, s.pk.team_id));
  claim(["pk", "goalie"], s.pk.goalie, s.pk.team_id);
}

/** Scenario as exported today and tomorrow: penalties / goalie_pulled / bench may be absent (loader falls back). */
export const Scenario = ScenarioBase.superRefine(scenarioRules);
/** Scenario shape required for new exports: penalties, goalie_pulled and bench present. */
export const ScenarioStrict = ScenarioBase.extend({
  state: ScenarioBase.shape.state.extend({ penalties: z.array(ScenarioPenalty), goalie_pulled: z.boolean() }),
  pp: ScenarioBase.shape.pp.extend({ bench: z.array(ScenarioSkater) }),
}).superRefine(scenarioRules);
export type Scenario = z.infer<typeof Scenario>;
export type ScenarioStrict = z.infer<typeof ScenarioStrict>;

// ============================================================================ files + parsers

/** Top-level export files, and the per-scenario directory convention `scenarios/<id>.json`. */
export const EXPORT_FILES = {
  files: [
    "base_rates.json", "shooter_ratings.json", "goalie_ratings.json", "faceoff_ratings.json",
    "playmaker_ratings.json", "schedule.json", "endless_index.json",
  ],
  scenariosDir: "scenarios",
  scenarioFile: (id: string): string => `scenarios/${id}.json`,
} as const;
export type ExportFileName = (typeof EXPORT_FILES.files)[number];

const FILE_SCHEMAS: Record<ExportFileName, z.ZodType> = {
  "base_rates.json": BaseRatesFile,
  "shooter_ratings.json": ShooterRatingsFile,
  "goalie_ratings.json": GoalieRatingsFile,
  "faceoff_ratings.json": FaceoffRatingsFile,
  "playmaker_ratings.json": PlaymakerRatingsFile,
  "schedule.json": ScheduleFile,
  "endless_index.json": EndlessIndexFile,
};

const MAX_REPORTED_ISSUES = 5;

/** "[3].attempts" style path. O(path length). */
function fmtPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const p of path) out += typeof p === "number" ? `[${p}]` : `${out === "" ? "" : "."}${String(p)}`;
  return out === "" ? "(root)" : out;
}

/** safeParse with a readable "<file>: <path>: <message>" error (first MAX_REPORTED_ISSUES issues). O(size of data). */
function parseWith<T>(schema: z.ZodType<T>, file: string, data: unknown): Result<T> {
  const r = schema.safeParse(data);
  if (r.success) return ok(r.data);
  const issues = r.error.issues;
  const shown = issues.slice(0, MAX_REPORTED_ISSUES).map((i) => `${file}: ${fmtPath(i.path)}: ${i.message}`);
  const more = issues.length > MAX_REPORTED_ISSUES ? ` (+${issues.length - MAX_REPORTED_ISSUES} more)` : "";
  return err(shown.join("; ") + more);
}

export const parseBaseRates = (data: unknown, file = "base_rates.json") => parseWith(BaseRatesFile, file, data);
export const parseShooterRatings = (data: unknown, file = "shooter_ratings.json") => parseWith(ShooterRatingsFile, file, data);
export const parseGoalieRatings = (data: unknown, file = "goalie_ratings.json") => parseWith(GoalieRatingsFile, file, data);
export const parseFaceoffRatings = (data: unknown, file = "faceoff_ratings.json") => parseWith(FaceoffRatingsFile, file, data);
export const parsePlaymakerRatings = (data: unknown, file = "playmaker_ratings.json") => parseWith(PlaymakerRatingsFile, file, data);
export const parseSchedule = (data: unknown, file = "schedule.json") => parseWith(ScheduleFile, file, data);
export const parseEndlessIndex = (data: unknown, file = "endless_index.json") => parseWith(EndlessIndexFile, file, data);
export const parseScenario = (data: unknown, file = "scenario") => parseWith(Scenario, file, data);
export const parseScenarioStrict = (data: unknown, file = "scenario") => parseWith(ScenarioStrict, file, data);

const SCENARIO_PATH_RE = /^scenarios\/([^/]+)\.json$/;

/**
 * Validate one export file by its path relative to the export dir ("schedule.json",
 * "scenarios/<id>.json"). A scenario's id must match its file name. O(size of data).
 */
export function validateExportFile(name: string, data: unknown): Result<unknown> {
  const normalised = name.replaceAll("\\", "/");
  const sc = SCENARIO_PATH_RE.exec(normalised);
  if (sc !== null) {
    const r = parseScenario(data, normalised);
    if (!r.ok) return r;
    if (r.value.id !== sc[1]) return err(`${normalised}: id: "${r.value.id}" does not match the file name`);
    return r;
  }
  const known = EXPORT_FILES.files.find((f) => f === normalised);
  if (known === undefined) return err(`${normalised}: not an export file (expected one of ${EXPORT_FILES.files.join(", ")} or scenarios/<id>.json)`);
  return parseWith(FILE_SCHEMAS[known], normalised, data);
}
