// Brings a room's SQLite schema up to date. Each step runs once, in order, and is never edited after release.
export function migrate(sql: SqlStorage) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const { version } = sql
    .exec<{ version: number }>("SELECT COALESCE(MAX(id), 0) AS version FROM _sql_schema_migrations")
    .one();

  if (version < 1) {
    sql.exec(`
      CREATE TABLE room (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        code         TEXT    NOT NULL,
        host_key     TEXT    NOT NULL,
        yes_budget   INTEGER NOT NULL DEFAULT 0,
        focus_pnm_id TEXT,
        phase        TEXT    NOT NULL,
        created_at   INTEGER NOT NULL
      );
      CREATE TABLE pnm (
        id        TEXT PRIMARY KEY,
        ordinal   INTEGER NOT NULL,
        name      TEXT NOT NULL,
        photo_url TEXT,
        answers   TEXT NOT NULL,
        seen      INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE member (
        id        TEXT PRIMARY KEY,
        handle    TEXT NOT NULL UNIQUE,
        name      TEXT NOT NULL,
        joined_at INTEGER NOT NULL,
        kicked    INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE vote (
        member_id  TEXT NOT NULL,
        pnm_id     TEXT NOT NULL,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (member_id, pnm_id)
      );
      CREATE INDEX idx_vote_pnm ON vote(pnm_id);
      INSERT INTO _sql_schema_migrations (id) VALUES (1);
    `);
  }

  if (version < 2) {
    sql.exec(`
      ALTER TABLE room ADD COLUMN revealed_pnm_id TEXT;
      INSERT INTO _sql_schema_migrations (id) VALUES (2);
    `);
  }

  if (version < 3) {
    sql.exec(`
      ALTER TABLE room ADD COLUMN revote_spots INTEGER;
      ALTER TABLE pnm ADD COLUMN in_revote INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE pnm ADD COLUMN past_rounds TEXT NOT NULL DEFAULT '[]';
      INSERT INTO _sql_schema_migrations (id) VALUES (3);
    `);
  }

  if (version < 4) {
    sql.exec(`
      ALTER TABLE room ADD COLUMN class_revealed INTEGER NOT NULL DEFAULT 0;
      INSERT INTO _sql_schema_migrations (id) VALUES (4);
    `);
  }

  if (version < 5) {
    sql.exec(`
      ALTER TABLE room ADD COLUMN projector_key TEXT;
      ALTER TABLE room ADD COLUMN revealed_yes INTEGER;
      ALTER TABLE room ADD COLUMN revealed_no INTEGER;
      UPDATE room SET projector_key = lower(hex(randomblob(24)));
      UPDATE room SET
        revealed_yes = (SELECT COUNT(*) FROM vote WHERE pnm_id = revealed_pnm_id AND value = 'yes'),
        revealed_no = (SELECT COUNT(*) FROM vote WHERE pnm_id = revealed_pnm_id AND value = 'no')
      WHERE revealed_pnm_id IS NOT NULL;
      INSERT INTO _sql_schema_migrations (id) VALUES (5);
    `);
  }

  if (version < 6) {
    sql.exec(`
      ALTER TABLE room ADD COLUMN join_locked INTEGER NOT NULL DEFAULT 0;
      INSERT INTO _sql_schema_migrations (id) VALUES (6);
    `);
  }
}
