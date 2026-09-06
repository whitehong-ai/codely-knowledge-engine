/**
 * SQLite database connection manager for knowledge-engine.
 *
 * Stores: trace_nodes, sessions, weak_concepts, concept_evidence, reflections.
 * Also manages FTS5 virtual table for keyword search on trace content.
 */
import BetterSqlite3 from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { getConfig } from './config.js';

let _db: DatabaseType | null = null;

export function getDb(): DatabaseType {
  if (!_db) {
    const config = getConfig();
    _db = new BetterSqlite3(config.dbPath) as DatabaseType;
    _db.pragma('journal_mode = WAL');
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

let _ftsDb: DatabaseType | null = null;

export function getFtsDb(): DatabaseType {
  if (!_ftsDb) {
    const config = getConfig();
    _ftsDb = new BetterSqlite3(config.ftsDbPath) as DatabaseType;
    _ftsDb.pragma('journal_mode = WAL');
    _ftsDb.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS trace_fts USING fts5(
        content,
        node_id UNINDEXED,
        tokenize = 'trigram'
      );
    `);
  }
  return _ftsDb;
}

function initSchema(db: DatabaseType): void {
  db.exec(`
    -- Trace Forest: hierarchical memory nodes
    CREATE TABLE IF NOT EXISTS trace_nodes (
      node_id     TEXT PRIMARY KEY,
      level       TEXT NOT NULL,
      parent_id   TEXT,
      session_id  TEXT NOT NULL,
      task_type   TEXT NOT NULL,
      topic       TEXT DEFAULT '',
      content     TEXT NOT NULL,
      metadata    TEXT DEFAULT '{}',
      created_at  TEXT NOT NULL,
      FOREIGN KEY (parent_id) REFERENCES trace_nodes(node_id)
    );

    CREATE INDEX IF NOT EXISTS idx_trace_level    ON trace_nodes(level);
    CREATE INDEX IF NOT EXISTS idx_trace_session   ON trace_nodes(session_id);
    CREATE INDEX IF NOT EXISTS idx_trace_task      ON trace_nodes(task_type);
    CREATE INDEX IF NOT EXISTS idx_trace_topic    ON trace_nodes(topic);

    -- Trace vector persistence (replaces in-memory cache)
    CREATE TABLE IF NOT EXISTS trace_vectors (
      node_id   TEXT PRIMARY KEY,
      vector    TEXT NOT NULL,
      FOREIGN KEY (node_id) REFERENCES trace_nodes(node_id) ON DELETE CASCADE
    );

    -- Learner Profile: sessions
    CREATE TABLE IF NOT EXISTS sessions (
      session_id   TEXT PRIMARY KEY,
      task_type    TEXT NOT NULL,
      topic        TEXT DEFAULT '',
      summary      TEXT DEFAULT '',
      started_at   TEXT NOT NULL,
      ended_at     TEXT,
      outcome      TEXT DEFAULT 'active',
      replan_count INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_type);
  `);

  // Migration: add replan_count column if missing (for pre-existing databases)
  try {
    db.prepare('SELECT replan_count FROM sessions LIMIT 0').get();
  } catch {
    db.exec('ALTER TABLE sessions ADD COLUMN replan_count INTEGER DEFAULT 0');
  }

  db.exec(`
    -- Learner Profile: weak concepts (evidence-driven state machine)
    CREATE TABLE IF NOT EXISTS weak_concepts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      concept     TEXT NOT NULL UNIQUE,
      state       TEXT DEFAULT 'active',
      first_seen   TEXT NOT NULL,
      last_seen    TEXT NOT NULL,
      resolved_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_weak_state ON weak_concepts(state);

    -- Learner Profile: concept evidence chain
    CREATE TABLE IF NOT EXISTS concept_evidence (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      concept         TEXT NOT NULL,
      trace_node_id   TEXT,
      evidence_type   TEXT NOT NULL,
      detail          TEXT DEFAULT '',
      timestamp       TEXT NOT NULL,
      FOREIGN KEY (trace_node_id) REFERENCES trace_nodes(node_id)
    );

    CREATE INDEX IF NOT EXISTS idx_evidence_concept ON concept_evidence(concept);

    -- Learner Profile: teaching reflections (𝒟_r)
    CREATE TABLE IF NOT EXISTS reflections (
      reflection_id   TEXT PRIMARY KEY,
      session_id      TEXT NOT NULL,
      topic           TEXT DEFAULT '',
      what_worked     TEXT DEFAULT '',
      what_failed     TEXT DEFAULT '',
      recommendation  TEXT DEFAULT '',
      created_at      TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_reflections_session ON reflections(session_id);

    -- Mastery: knowledge points (DeepTutor-aligned types)
    CREATE TABLE IF NOT EXISTS knowledge_points (
      kp_id       TEXT PRIMARY KEY,
      concept     TEXT NOT NULL,
      kp_type     TEXT NOT NULL DEFAULT 'concept',
      session_id  TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_kp_concept ON knowledge_points(concept);

    -- Mastery: quiz attempts (correctness history per knowledge point)
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      kp_id           TEXT NOT NULL,
      is_correct      BOOLEAN NOT NULL,
      question_type   TEXT DEFAULT 'short',
      answer          TEXT DEFAULT '',
      timestamp       TEXT NOT NULL,
      FOREIGN KEY (kp_id) REFERENCES knowledge_points(kp_id)
    );

    CREATE INDEX IF NOT EXISTS idx_attempts_kp ON quiz_attempts(kp_id);

    -- Mastery: spaced repetition state (DeepTutor scheduler)
    CREATE TABLE IF NOT EXISTS repetition_states (
      kp_id                  TEXT PRIMARY KEY,
      interval_index         INTEGER DEFAULT 0,
      consecutive_correct    INTEGER DEFAULT 0,
      consecutive_wrong      INTEGER DEFAULT 0,
      next_review_at         REAL NOT NULL,
      FOREIGN KEY (kp_id) REFERENCES knowledge_points(kp_id)
    );

    -- Mastery: qualitative passes (CONCEPT/DESIGN Feynman check)
    CREATE TABLE IF NOT EXISTS qualitative_mastery (
      kp_id      TEXT PRIMARY KEY,
      passed     BOOLEAN NOT NULL,
      evidence   TEXT DEFAULT '',
      timestamp  TEXT NOT NULL,
      FOREIGN KEY (kp_id) REFERENCES knowledge_points(kp_id)
    );
  `);
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
  if (_ftsDb) {
    _ftsDb.close();
    _ftsDb = null;
  }
}
