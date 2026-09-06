/**
 * Mastery engine — DeepTutor-aligned mastery scoring, gating, and spaced repetition.
 *
 * Ported from DeepTutor's learning/mastery.py, learning/policy.py, learning/scheduler.py.
 * Pure functions, no LLM calls, no I/O.
 */

// ── Knowledge types ─────────────────────────────────────────

export type KnowledgeType = 'memory' | 'procedure' | 'concept' | 'design';

export const QUALITATIVE_TYPES: ReadonlySet<KnowledgeType> = new Set([
  'concept',
  'design',
]);

// ── Mastery scoring (recency-weighted accuracy + confidence cap) ──

// Recency weights: oldest → newest. Newer attempts count more.
const RECENCY_WEIGHTS = [0.5, 0.7, 0.85, 0.95, 1.0];

// Mastery cannot exceed this until enough attempts accumulate.
const CONFIDENCE_CAP: Record<number, number> = { 1: 0.5, 2: 0.8 };

export function computeMastery(correctness: boolean[]): number {
  if (correctness.length === 0) return 0.0;
  const recent = correctness.slice(-RECENCY_WEIGHTS.length);
  const weights = RECENCY_WEIGHTS.slice(-recent.length);
  const score =
    recent.reduce((sum, c, i) => sum + weights[i] * (c ? 1.0 : 0.0), 0) /
    weights.reduce((a, b) => a + b, 0);
  return Math.min(score, CONFIDENCE_CAP[recent.length] ?? 1.0);
}

// ── Gate thresholds (per-type) ──────────────────────────────

export const QUANTITATIVE_GATE: Partial<Record<KnowledgeType, number>> = {
  memory: 0.9,
  procedure: 0.9,
};

export function gateThreshold(kpType: KnowledgeType): number {
  if (QUALITATIVE_TYPES.has(kpType)) return 1.0;
  return QUANTITATIVE_GATE[kpType] ?? 0.9;
}

export function isMastered(
  masteryScore: number,
  kpType: KnowledgeType,
  qualitativePassed: boolean,
): boolean {
  if (QUALITATIVE_TYPES.has(kpType)) return qualitativePassed;
  return masteryScore >= gateThreshold(kpType);
}

// ── Objective status (DeepTutor policy.py: objective_status) ──

export type ObjectiveStatus = 'mastered' | 'learning' | 'new';

export function objectiveStatus(
  masteryScore: number,
  kpType: KnowledgeType,
  qualitativePassed: boolean,
  hasAttempts: boolean,
): ObjectiveStatus {
  if (isMastered(masteryScore, kpType, qualitativePassed)) return 'mastered';
  return hasAttempts ? 'learning' : 'new';
}

// ── Next step decision (DeepTutor policy.py: next_objective) ──

export type NextAction =
  | 'answer_pending'
  | 'review'
  | 'probe'
  | 'practice'
  | 'assess'
  | 'complete';

export interface NextStep {
  action: NextAction;
  kp_id: string;
  concept: string;
  kp_type: KnowledgeType;
  status: ObjectiveStatus;
  gate: 'quantitative' | 'qualitative';
  mastery: number;
  threshold: number;
  reason: string;
}

export function nextObjective(
  knowledgePoints: {
    kp_id: string;
    concept: string;
    kp_type: KnowledgeType;
    mastery: number;
    qualitative_passed: boolean;
    has_attempts: boolean;
    has_pending_question: boolean;
    is_due_for_review: boolean;
  }[],
): NextStep {
  // 1. Pending question (grade it before moving on)
  const pending = knowledgePoints.find((kp) => kp.has_pending_question);
  if (pending) {
    return {
      action: 'answer_pending',
      kp_id: pending.kp_id,
      concept: pending.concept,
      kp_type: pending.kp_type,
      status: objectiveStatus(pending.mastery, pending.kp_type, pending.qualitative_passed, pending.has_attempts),
      gate: QUALITATIVE_TYPES.has(pending.kp_type) ? 'qualitative' : 'quantitative',
      mastery: pending.mastery,
      threshold: gateThreshold(pending.kp_type),
      reason: 'A posed question is awaiting the learner\'s answer; grade it first.',
    };
  }

  // 2. Due spaced-repetition review
  const due = knowledgePoints.find((kp) => kp.is_due_for_review && !isMastered(kp.mastery, kp.kp_type, kp.qualitative_passed));
  if (due) {
    return {
      action: 'review',
      kp_id: due.kp_id,
      concept: due.concept,
      kp_type: due.kp_type,
      status: objectiveStatus(due.mastery, due.kp_type, due.qualitative_passed, due.has_attempts),
      gate: QUALITATIVE_TYPES.has(due.kp_type) ? 'qualitative' : 'quantitative',
      mastery: due.mastery,
      threshold: gateThreshold(due.kp_type),
      reason: 'This objective is due for spaced-repetition review.',
    };
  }

  // 3. First not-yet-mastered objective in order
  for (const kp of knowledgePoints) {
    if (isMastered(kp.mastery, kp.kp_type, kp.qualitative_passed)) continue;
    const status = objectiveStatus(kp.mastery, kp.kp_type, kp.qualitative_passed, kp.has_attempts);
    const gate = QUALITATIVE_TYPES.has(kp.kp_type) ? 'qualitative' : 'quantitative';
    const action: NextAction = status === 'new' ? 'probe' : gate === 'qualitative' ? 'assess' : 'practice';
    return {
      action,
      kp_id: kp.kp_id,
      concept: kp.concept,
      kp_type: kp.kp_type,
      status,
      gate,
      mastery: kp.mastery,
      threshold: gateThreshold(kp.kp_type),
      reason:
        status === 'new'
          ? 'Untouched objective — probe first to let the learner test out.'
          : 'Objective is below its mastery gate; keep working it until it clears.',
    };
  }

  // 4. Complete
  return {
    action: 'complete',
    kp_id: '',
    concept: '',
    kp_type: 'memory',
    status: 'mastered',
    gate: 'quantitative',
    mastery: 1.0,
    threshold: 0.9,
    reason: 'All objectives are mastered and no reviews are due.',
  };
}

// ── Map summary (DeepTutor policy.py: map_summary) ──

export interface MapSummaryEntry {
  kp_id: string;
  concept: string;
  kp_type: KnowledgeType;
  status: ObjectiveStatus;
  mastery: number;
}

export interface MapSummary {
  counts: { mastered: number; learning: number; new: number; total: number };
  due_reviews: number;
  complete: boolean;
  knowledge_points: MapSummaryEntry[];
}

export function buildMapSummary(
  knowledgePoints: {
    kp_id: string;
    concept: string;
    kp_type: KnowledgeType;
    mastery: number;
    qualitative_passed: boolean;
    has_attempts: boolean;
  }[],
  dueReviewCount: number,
): MapSummary {
  const counts = { mastered: 0, learning: 0, new: 0, total: 0 };
  const entries: MapSummaryEntry[] = [];

  for (const kp of knowledgePoints) {
    const status = objectiveStatus(kp.mastery, kp.kp_type, kp.qualitative_passed, kp.has_attempts);
    counts[status]++;
    counts.total++;
    entries.push({
      kp_id: kp.kp_id,
      concept: kp.concept,
      kp_type: kp.kp_type,
      status,
      mastery: Math.round(kp.mastery * 1000) / 1000,
    });
  }

  return {
    counts,
    due_reviews: dueReviewCount,
    complete: counts.total > 0 && counts.mastered === counts.total,
    knowledge_points: entries,
  };
}

// ── Spaced repetition (DeepTutor scheduler) ────────────────

export const INTERVAL_SEQUENCES: Record<KnowledgeType, number[]> = {
  memory: [0, 1, 3, 7, 14, 30, 60],
  concept: [3, 7, 14, 30],
  procedure: [3, 7, 14],
  design: [14, 28],
};

const TYPE_PRIORITY: Record<KnowledgeType, number> = {
  memory: 2,
  concept: 3,
  procedure: 4,
  design: 5,
};

export interface RepetitionState {
  interval_index: number;
  consecutive_correct: number;
  consecutive_wrong: number;
  next_review_at: number; // Unix timestamp (seconds)
}

export function getInitialState(kpType: KnowledgeType): RepetitionState {
  const intervals = INTERVAL_SEQUENCES[kpType];
  const now = Date.now() / 1000;
  return {
    interval_index: 0,
    consecutive_correct: 0,
    consecutive_wrong: 0,
    next_review_at: now + intervals[0] * 86400,
  };
}

export function scheduleNext(
  state: RepetitionState,
  kpType: KnowledgeType,
  isCorrect: boolean,
): RepetitionState {
  const intervals = INTERVAL_SEQUENCES[kpType];
  const maxIndex = intervals.length - 1;
  const now = Date.now() / 1000;

  if (isCorrect) {
    state.consecutive_wrong = 0;
    state.consecutive_correct += 1;
    if (state.consecutive_correct >= 2) {
      state.interval_index += 2;
      state.consecutive_correct = 0;
    } else {
      state.interval_index += 1;
    }
  } else {
    state.consecutive_wrong += 1;
    state.consecutive_correct = 0;
    state.interval_index = Math.max(0, state.interval_index - 1);
    if (state.consecutive_wrong >= 2) {
      state.consecutive_wrong = 0;
    }
  }

  state.interval_index = Math.max(0, Math.min(state.interval_index, maxIndex));
  state.next_review_at = now + intervals[state.interval_index] * 86400;
  return state;
}

export function getPriority(kpType: KnowledgeType, hasError: boolean): number {
  return hasError ? 1 : TYPE_PRIORITY[kpType];
}

// ── Adaptive replanning (deep_solve) ────────────────────────

export const MAX_REPLAN_ROUNDS = 2;

export function canReplan(currentCount: number): boolean {
  return currentCount < MAX_REPLAN_ROUNDS;
}
