-- PowerPlay scenario + ratings database.
-- Written in the SQL subset shared by SQLite 3.35+ and PostgreSQL 14+ so the
-- same file seeds local dev (SQLite) and Supabase (Postgres).
-- Postgres note: swap REAL -> DOUBLE PRECISION and TEXT payload_json -> JSONB if desired.

CREATE TABLE IF NOT EXISTS games (
    game_id       BIGINT PRIMARY KEY,
    season        TEXT    NOT NULL,           -- e.g. '20232024'
    game_type     INTEGER NOT NULL,           -- 2 regular, 3 playoff
    game_date     TEXT    NOT NULL,           -- YYYY-MM-DD
    home_id       INTEGER NOT NULL,
    away_id       INTEGER NOT NULL,
    home_abbrev   TEXT    NOT NULL,
    away_abbrev   TEXT    NOT NULL,
    has_shifts    INTEGER NOT NULL DEFAULT 0  -- 1 if shift charts parsed
);

CREATE TABLE IF NOT EXISTS players (
    player_id  BIGINT PRIMARY KEY,
    first_name TEXT,
    last_name  TEXT,
    position   TEXT                            -- C, L, R, D, G
);

CREATE TABLE IF NOT EXISTS pp_segments (
    segment_id      TEXT PRIMARY KEY,          -- '<game_id>-p<period>-<start_t>'
    game_id         BIGINT  NOT NULL REFERENCES games(game_id),
    pp_team_id      INTEGER NOT NULL,
    pk_team_id      INTEGER NOT NULL,
    period          INTEGER NOT NULL,
    start_t         INTEGER NOT NULL,          -- seconds elapsed in period
    end_t           INTEGER NOT NULL,
    strength        TEXT    NOT NULL,          -- '5v4', '5v3', '4v3', '6v4'
    pp_score        INTEGER NOT NULL,
    pk_score        INTEGER NOT NULL,
    pp_remaining_s  INTEGER,                   -- NULL if no linked penalty
    outcome         TEXT    NOT NULL CHECK (outcome IN ('goal','no_goal','sh_goal_against','carried_over')),
    scorer_id       BIGINT,
    assist1_id      BIGINT,
    assist2_id      BIGINT,
    goalie_id       BIGINT,
    drama           REAL    NOT NULL DEFAULT 0,
    payload_json    TEXT    NOT NULL           -- full PpSegment incl. shots + faceoffs
);
CREATE INDEX IF NOT EXISTS idx_seg_game ON pp_segments(game_id);
CREATE INDEX IF NOT EXISTS idx_seg_drama ON pp_segments(drama DESC);

CREATE TABLE IF NOT EXISTS base_rates (
    scope        TEXT    NOT NULL,             -- 'all' or a season
    shot_type    TEXT    NOT NULL,
    dist_bucket  INTEGER NOT NULL,             -- index into DISTANCE_BUCKETS_FT
    attempts     INTEGER NOT NULL,
    on_net       INTEGER NOT NULL,
    goals        INTEGER NOT NULL,
    p_unblocked  REAL    NOT NULL,
    p_on_net     REAL    NOT NULL,
    PRIMARY KEY (scope, shot_type, dist_bucket)
);

CREATE TABLE IF NOT EXISTS shooter_ratings (
    player_id      BIGINT NOT NULL,
    scope          TEXT   NOT NULL,
    attempts       INTEGER NOT NULL,
    on_net         INTEGER NOT NULL,
    goals          INTEGER NOT NULL,
    xg             REAL    NOT NULL,
    finishing_mult REAL    NOT NULL,
    accuracy       REAL    NOT NULL,
    rating         INTEGER,
    low_sample     INTEGER NOT NULL,
    PRIMARY KEY (player_id, scope)
);

CREATE TABLE IF NOT EXISTS goalie_ratings (
    player_id  BIGINT NOT NULL,
    scope      TEXT   NOT NULL,
    on_net     INTEGER NOT NULL,
    ga         INTEGER NOT NULL,
    xga        REAL    NOT NULL,
    ga_mult    REAL    NOT NULL,              -- > 1 means allows more than expected
    rating     INTEGER,
    low_sample INTEGER NOT NULL,
    PRIMARY KEY (player_id, scope)
);

CREATE TABLE IF NOT EXISTS faceoff_ratings (
    player_id BIGINT NOT NULL,
    scope     TEXT   NOT NULL,
    won       INTEGER NOT NULL,
    taken     INTEGER NOT NULL,
    win_rate  REAL    NOT NULL,
    PRIMARY KEY (player_id, scope)
);

CREATE TABLE IF NOT EXISTS playmaker_ratings (
    player_id       BIGINT NOT NULL,
    scope           TEXT   NOT NULL,
    a1              INTEGER NOT NULL,
    presence        INTEGER NOT NULL,
    playmaking_mult REAL    NOT NULL,
    PRIMARY KEY (player_id, scope)
);

CREATE TABLE IF NOT EXISTS matchups (
    shooter_id BIGINT NOT NULL,
    goalie_id  BIGINT NOT NULL,
    scope      TEXT   NOT NULL,
    on_net     INTEGER NOT NULL,
    goals      INTEGER NOT NULL,
    xg         REAL    NOT NULL,
    PRIMARY KEY (shooter_id, goalie_id, scope)
);

CREATE TABLE IF NOT EXISTS scenarios (
    scenario_id  TEXT PRIMARY KEY,
    kind         TEXT NOT NULL CHECK (kind IN ('curated','mined')),
    drama        REAL NOT NULL DEFAULT 0,
    payload_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_schedule (
    play_date   TEXT PRIMARY KEY,              -- YYYY-MM-DD, rollover time zone set in the app
    scenario_id TEXT NOT NULL REFERENCES scenarios(scenario_id)
);
