/**
 * Learner Profile store — SQLite persistence for sessions, weak concepts, and reflections.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { countL1Traces } from '../trace-forest/store.js';
import {
  computeMastery,
  gateThreshold,
  isMastered,
  getInitialState,
  scheduleNext,
  getPriority,
  canReplan,
  MAX_REPLAN_ROUNDS,
  nextObjective,
  buildMapSummary,
  type KnowledgeType,
  type RepetitionState,
  type NextStep,
  type MapSummary,
} from '../mastery.js';
import type {
  SessionRecord,
  WeakConcept,
  ConceptEvidence,
  Reflection,
  LearnerProfile,
} from './types.js';

// ── Sessions (𝒟_s) ──────────────────────────────────────

export function startSession(
  task_type: string,
  topic: string,
): { session_id: string } {
  const db = getDb();
  const session_id = `sess_${randomUUID().slice(0, 16)}`;
  const now = new Date().toISOString();

  db.prepare(
    "INSERT INTO sessions (session_id, task_type, topic, started_at, outcome) VALUES (?, ?, ?, ?, 'active')",
  ).run(session_id, task_type, topic, now);

  return { session_id };
}

export function endSession(
  session_id: string,
  outcome: 'success' | 'partial' | 'failed',
  summary?: string,
): { success: boolean } {
  const db = getDb();
  const now = new Date().toISOString();

  const result = db
    .prepare(
      'UPDATE sessions SET ended_at = ?, outcome = ?, summary = ? WHERE session_id = ?',
    )
    .run(now, outcome, summary ?? '', session_id);

  return { success: result.changes > 0 };
}

export function getSessions(limit: number = 50): SessionRecord[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM sessions ORDER BY started_at DESC LIMIT ?')
    .all(limit) as any[];

  return rows.map((r) => ({
    session_id: r.session_id,
    task_type: r.task_type,
    topic: r.topic,
    summary: r.summary,
    started_at: r.started_at,
    ended_at: r.ended_at,
    outcome: r.outcome,
  }));
}

export function getSession(session_id: string): SessionRecord | null {
  const db = getDb();
  const row = db
    .prepare('SELECT * FROM sessions WHERE session_id = ?')
    .get(session_id) as any;
  if (!row) return null;
  return {
    session_id: row.session_id,
    task_type: row.task_type,
    topic: row.topic,
    summary: row.summary,
    started_at: row.started_at,
    ended_at: row.ended_at,
    outcome: row.outcome,
  };
}

// ── Weak Concepts (𝒟_w) ──────────────────────────────────

export function recordWeakness(
  concept: string,
  evidence_type: string,
  detail: string,
  trace_node_id?: string,
): { concept: string; state: string } {
  const db = getDb();
  const now = new Date().toISOString();

  // Check if concept already exists
  const existing = db
    .prepare('SELECT * FROM weak_concepts WHERE concept = ?')
    .get(concept) as any;

  if (existing) {
    // Update last_seen, keep state active (unless already resolved → reactivate)
    if (existing.state === 'resolved') {
      db.prepare(
        "UPDATE weak_concepts SET state = 'active', last_seen = ?, resolved_at = NULL WHERE concept = ?",
      ).run(now, concept);
    } else {
      db.prepare(
        'UPDATE weak_concepts SET last_seen = ? WHERE concept = ?',
      ).run(now, concept);
    }
  } else {
    db.prepare(
      "INSERT INTO weak_concepts (concept, state, first_seen, last_seen) VALUES (?, 'active', ?, ?)",
    ).run(concept, now, now);
  }

  // Record evidence
  db.prepare(
    'INSERT INTO concept_evidence (concept, trace_node_id, evidence_type, detail, timestamp) VALUES (?, ?, ?, ?, ?)',
  ).run(concept, trace_node_id ?? null, evidence_type, detail, now);

  const state = (
    db
      .prepare('SELECT state FROM weak_concepts WHERE concept = ?')
      .get(concept) as any
  ).state;

  return { concept, state };
}

export function resolveWeakness(concept: string): { success: boolean } {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db
    .prepare(
      "UPDATE weak_concepts SET state = 'resolved', resolved_at = ? WHERE concept = ?",
    )
    .run(now, concept);
  return { success: result.changes > 0 };
}

export function reviewConcept(concept: string): {
  success: boolean;
  concept: string;
  state: string;
} {
  const db = getDb();
  const result = db
    .prepare(
      "UPDATE weak_concepts SET state = 'reviewing' WHERE concept = ? AND state = 'active'",
    )
    .run(concept);
  const row = db
    .prepare('SELECT state FROM weak_concepts WHERE concept = ?')
    .get(concept) as any;
  return {
    success: result.changes > 0,
    concept,
    state: row?.state ?? 'not_found',
  };
}

export function getWeakConcepts(state?: string): WeakConcept[] {
  const db = getDb();
  const rows = state
    ? (db
        .prepare(
          'SELECT * FROM weak_concepts WHERE state = ? ORDER BY last_seen DESC',
        )
        .all(state) as any[])
    : (db
        .prepare('SELECT * FROM weak_concepts ORDER BY last_seen DESC')
        .all() as any[]);

  return rows.map((r) => {
    const evidenceCount = (
      db
        .prepare(
          'SELECT COUNT(*) as cnt FROM concept_evidence WHERE concept = ?',
        )
        .get(r.concept) as any
    ).cnt;
    return {
      concept: r.concept,
      state: r.state,
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      resolved_at: r.resolved_at,
      evidence_count: evidenceCount,
    };
  });
}

export function getEvidence(concept: string): ConceptEvidence[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM concept_evidence WHERE concept = ? ORDER BY timestamp DESC',
    )
    .all(concept) as any[];
  return rows.map((r) => ({
    id: r.id,
    concept: r.concept,
    trace_node_id: r.trace_node_id,
    evidence_type: r.evidence_type,
    detail: r.detail,
    timestamp: r.timestamp,
  }));
}

// ── Reflections (𝒟_r) ────────────────────────────────────

export function addReflection(
  session_id: string,
  topic: string,
  what_worked: string,
  what_failed: string,
  recommendation: string,
): { reflection_id: string } {
  const db = getDb();
  const reflection_id = `refl_${randomUUID().slice(0, 16)}`;
  const now = new Date().toISOString();

  db.prepare(
    'INSERT INTO reflections (reflection_id, session_id, topic, what_worked, what_failed, recommendation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(
    reflection_id,
    session_id,
    topic,
    what_worked,
    what_failed,
    recommendation,
    now,
  );

  return { reflection_id };
}

export function getReflections(limit: number = 20): Reflection[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT * FROM reflections ORDER BY created_at DESC LIMIT ?')
    .all(limit) as any[];

  return rows.map((r) => ({
    reflection_id: r.reflection_id,
    session_id: r.session_id,
    topic: r.topic,
    what_worked: r.what_worked,
    what_failed: r.what_failed,
    recommendation: r.recommendation,
    created_at: r.created_at,
  }));
}

// ── Full Profile ──────────────────────────────────────────

export function getLearnerProfile(): LearnerProfile {
  return {
    sessions: getSessions(),
    weak_concepts: getWeakConcepts(),
    reflections: getReflections(),
  };
}

// ── Mastery: knowledge points ─────────────────────────────

export function registerKnowledgePoint(
  concept: string,
  kpType: KnowledgeType = 'concept',
  sessionId?: string,
): { kp_id: string } {
  const db = getDb();
  // Check if KP already exists for this concept
  const existing = db
    .prepare('SELECT kp_id FROM knowledge_points WHERE concept = ?')
    .get(concept) as any;
  if (existing) return { kp_id: existing.kp_id };

  const kp_id = `kp_${randomUUID().slice(0, 12)}`;
  const now = new Date().toISOString();
  db.prepare(
    'INSERT INTO knowledge_points (kp_id, concept, kp_type, session_id, created_at) VALUES (?, ?, ?, ?, ?)',
  ).run(kp_id, concept, kpType, sessionId ?? null, now);

  // Initialize spaced repetition state
  const initState = getInitialState(kpType);
  db.prepare(
    'INSERT INTO repetition_states (kp_id, interval_index, consecutive_correct, consecutive_wrong, next_review_at) VALUES (?, ?, ?, ?, ?)',
  ).run(
    kp_id,
    initState.interval_index,
    initState.consecutive_correct,
    initState.consecutive_wrong,
    initState.next_review_at,
  );

  return { kp_id };
}

export function recordQuizAttempt(
  kp_id: string,
  isCorrect: boolean,
  questionType: string = 'short',
  answer: string = '',
): {
  mastery: number;
  threshold: number;
  mastered: boolean;
  next_review_at: number;
} {
  const db = getDb();
  const now = new Date().toISOString();

  // Record attempt
  db.prepare(
    'INSERT INTO quiz_attempts (kp_id, is_correct, question_type, answer, timestamp) VALUES (?, ?, ?, ?, ?)',
  ).run(kp_id, isCorrect ? 1 : 0, questionType, answer, now);

  // Get KP type
  const kp = db
    .prepare('SELECT kp_type FROM knowledge_points WHERE kp_id = ?')
    .get(kp_id) as any;
  if (!kp) throw new Error(`Knowledge point ${kp_id} not found`);
  const kpType = kp.kp_type as KnowledgeType;

  // Get all attempts for mastery computation
  const attempts = db
    .prepare(
      'SELECT is_correct FROM quiz_attempts WHERE kp_id = ? ORDER BY timestamp',
    )
    .all(kp_id) as any[];
  const correctness = attempts.map((a) => Boolean(a.is_correct));
  const masteryScore = computeMastery(correctness);

  // Check qualitative mastery
  const qualRow = db
    .prepare('SELECT passed FROM qualitative_mastery WHERE kp_id = ?')
    .get(kp_id) as any;
  const qualPassed = Boolean(qualRow?.passed);

  const mastered = isMastered(masteryScore, kpType, qualPassed);
  const threshold = gateThreshold(kpType);

  // Update spaced repetition
  const stateRow = db
    .prepare('SELECT * FROM repetition_states WHERE kp_id = ?')
    .get(kp_id) as any;
  if (stateRow) {
    const state: RepetitionState = {
      interval_index: stateRow.interval_index,
      consecutive_correct: stateRow.consecutive_correct,
      consecutive_wrong: stateRow.consecutive_wrong,
      next_review_at: stateRow.next_review_at,
    };
    const newState = scheduleNext(state, kpType, isCorrect);
    db.prepare(
      'UPDATE repetition_states SET interval_index = ?, consecutive_correct = ?, consecutive_wrong = ?, next_review_at = ? WHERE kp_id = ?',
    ).run(
      newState.interval_index,
      newState.consecutive_correct,
      newState.consecutive_wrong,
      newState.next_review_at,
      kp_id,
    );
  }

  // Auto-resolve weak concept if mastered
  if (mastered) {
    const kpConcept = (
      db
        .prepare('SELECT concept FROM knowledge_points WHERE kp_id = ?')
        .get(kp_id) as any
    )?.concept;
    if (kpConcept) {
      db.prepare(
        "UPDATE weak_concepts SET state = 'resolved', resolved_at = ? WHERE concept = ? AND state != 'resolved'",
      ).run(now, kpConcept);
    }
  }

  return {
    mastery: Math.round(masteryScore * 1000) / 1000,
    threshold,
    mastered,
    next_review_at: stateRow
      ? (
          db
            .prepare(
              'SELECT next_review_at FROM repetition_states WHERE kp_id = ?',
            )
            .get(kp_id) as any
        ).next_review_at
      : 0,
  };
}

export function recordQualitativeAssessment(
  kp_id: string,
  passed: boolean,
  evidence: string = '',
): { mastered: boolean; mastery: number } {
  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(
    'INSERT OR REPLACE INTO qualitative_mastery (kp_id, passed, evidence, timestamp) VALUES (?, ?, ?, ?)',
  ).run(kp_id, passed ? 1 : 0, evidence, now);

  const kp = db
    .prepare('SELECT kp_type, concept FROM knowledge_points WHERE kp_id = ?')
    .get(kp_id) as any;
  if (!kp) throw new Error(`Knowledge point ${kp_id} not found`);
  const kpType = kp.kp_type as KnowledgeType;

  const attempts = db
    .prepare(
      'SELECT is_correct FROM quiz_attempts WHERE kp_id = ? ORDER BY timestamp',
    )
    .all(kp_id) as any[];
  const correctness = attempts.map((a) => Boolean(a.is_correct));
  const masteryScore = computeMastery(correctness);
  const mastered = isMastered(masteryScore, kpType, passed);

  if (mastered && kp.concept) {
    db.prepare(
      "UPDATE weak_concepts SET state = 'resolved', resolved_at = ? WHERE concept = ? AND state != 'resolved'",
    ).run(now, kp.concept);
  }

  return { mastered, mastery: Math.round(masteryScore * 1000) / 1000 };
}

export function getDueReviews(maxTasks: number = 5): {
  kp_id: string;
  concept: string;
  kp_type: string;
  next_review_at: number;
  interval_index: number;
}[] {
  const db = getDb();
  const now = Date.now() / 1000;
  const rows = db
    .prepare(
      `SELECT rs.kp_id, kp.concept, kp.kp_type, rs.next_review_at, rs.interval_index
       FROM repetition_states rs
       JOIN knowledge_points kp ON rs.kp_id = kp.kp_id
       WHERE rs.next_review_at <= ?
       ORDER BY rs.next_review_at ASC
       LIMIT ?`,
    )
    .all(now, maxTasks) as any[];
  return rows.map((r) => ({
    kp_id: r.kp_id,
    concept: r.concept,
    kp_type: r.kp_type,
    next_review_at: r.next_review_at,
    interval_index: r.interval_index,
  }));
}

export function getMasteryStatus(kp_id: string): {
  mastery: number;
  threshold: number;
  mastered: boolean;
  attempts: number;
  correct_count: number;
  kp_type: string;
} {
  const db = getDb();
  const kp = db
    .prepare('SELECT * FROM knowledge_points WHERE kp_id = ?')
    .get(kp_id) as any;
  if (!kp) throw new Error(`Knowledge point ${kp_id} not found`);

  const attempts = db
    .prepare(
      'SELECT is_correct FROM quiz_attempts WHERE kp_id = ? ORDER BY timestamp',
    )
    .all(kp_id) as any[];
  const correctness = attempts.map((a) => Boolean(a.is_correct));
  const masteryScore = computeMastery(correctness);
  const kpType = kp.kp_type as KnowledgeType;
  const qualRow = db
    .prepare('SELECT passed FROM qualitative_mastery WHERE kp_id = ?')
    .get(kp_id) as any;
  const qualPassed = Boolean(qualRow?.passed);

  return {
    mastery: Math.round(masteryScore * 1000) / 1000,
    threshold: gateThreshold(kpType),
    mastered: isMastered(masteryScore, kpType, qualPassed),
    attempts: attempts.length,
    correct_count: attempts.filter((a) => a.is_correct).length,
    kp_type: kpType,
  };
}

// ── Adaptive replanning (deep_solve) ───────────────────────

export function incrementReplan(sessionId: string): {
  replan_count: number;
  can_continue: boolean;
  max_rounds: number;
} {
  const db = getDb();
  const row = db
    .prepare('SELECT replan_count FROM sessions WHERE session_id = ?')
    .get(sessionId) as any;
  if (!row) throw new Error(`Session ${sessionId} not found`);

  const newCount = (row.replan_count ?? 0) + 1;
  db.prepare('UPDATE sessions SET replan_count = ? WHERE session_id = ?').run(
    newCount,
    sessionId,
  );

  return {
    replan_count: newCount,
    can_continue: canReplan(newCount),
    max_rounds: MAX_REPLAN_ROUNDS,
  };
}

export function getReplanStatus(sessionId: string): {
  replan_count: number;
  can_continue: boolean;
  max_rounds: number;
} {
  const db = getDb();
  const row = db
    .prepare('SELECT replan_count FROM sessions WHERE session_id = ?')
    .get(sessionId) as any;
  const count = row?.replan_count ?? 0;
  return {
    replan_count: count,
    can_continue: canReplan(count),
    max_rounds: MAX_REPLAN_ROUNDS,
  };
}

// ── Memory Agent logic (rule-driven, no LLM) ──────────────

export function checkMemoryPrompts(session_id: string): {
  should_summarize: boolean;
  summary_prompt?: string;
  should_reflect: boolean;
  reflection_prompt?: string;
} {
  const session = getSession(session_id);
  if (!session || session.outcome === 'active') {
    return { should_summarize: false, should_reflect: false };
  }

  const l1Count = countL1Traces(session_id);
  const shouldSummarize = l1Count >= 3;

  // Check if any weakness changes happened in this session
  const sessionEvidence = getDb()
    .prepare(
      `SELECT COUNT(*) as cnt FROM concept_evidence
       WHERE timestamp >= ? AND timestamp <= ?`,
    )
    .get(
      session.started_at,
      session.ended_at ?? new Date().toISOString(),
    ) as any;

  const shouldReflect = (sessionEvidence?.cnt ?? 0) > 0;

  return {
    should_summarize: shouldSummarize,
    summary_prompt: shouldSummarize
      ? `Summarize session "${session.topic}" (${session.task_type}). ` +
        `The session had ${l1Count} trace events with outcome: ${session.outcome}. ` +
        `Generate a concise L2 summary capturing key learnings, decisions, and outcomes. ` +
        `Return as a single paragraph.`
      : undefined,
    should_reflect: shouldReflect,
    reflection_prompt: shouldReflect
      ? `Reflect on session "${session.topic}" (${session.task_type}). ` +
        `What worked well? What failed? What should be recommended for future sessions on this topic? ` +
        `Return as JSON: {what_worked, what_failed, recommendation}.`
      : undefined,
  };
}
