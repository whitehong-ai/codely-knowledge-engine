import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeMastery,
  gateThreshold,
  isMastered,
  getInitialState,
  scheduleNext,
  INTERVAL_SEQUENCES,
  canReplan,
  MAX_REPLAN_ROUNDS,
  type KnowledgeType,
} from '../src/mastery.js';
import {
  registerKnowledgePoint,
  recordQuizAttempt,
  recordQualitativeAssessment,
  getDueReviews,
  getMasteryStatus,
  incrementReplan,
  getReplanStatus,
  startSession,
  endSession,
  recordWeakness,
  getWeakConcepts,
} from '../src/learner-profile/store.js';
import { closeDb } from '../src/db.js';
import { resetConfig } from '../src/config.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

describe('Mastery Engine (pure functions)', () => {
  describe('computeMastery', () => {
    it('should return 0 for empty attempts', () => {
      expect(computeMastery([])).toBe(0.0);
    });

    it('should cap at 0.5 for single correct answer (confidence cap)', () => {
      expect(computeMastery([true])).toBe(0.5);
    });

    it('should cap at 0.8 for two correct answers', () => {
      expect(computeMastery([true, true])).toBe(0.8);
    });

    it('should allow full mastery after 3+ correct', () => {
      const score = computeMastery([true, true, true]);
      expect(score).toBeGreaterThan(0.8);
      expect(score).toBeLessThanOrEqual(1.0);
    });

    it('should weight recent attempts more', () => {
      const scoreRecentCorrect = computeMastery([
        false,
        false,
        true,
        true,
        true,
      ]);
      const scoreRecentWrong = computeMastery([true, true, true, false, false]);
      expect(scoreRecentCorrect).toBeGreaterThan(scoreRecentWrong);
    });
  });

  describe('gateThreshold', () => {
    it('should return 0.9 for memory type', () => {
      expect(gateThreshold('memory')).toBe(0.9);
    });
    it('should return 0.9 for procedure type', () => {
      expect(gateThreshold('procedure')).toBe(0.9);
    });
    it('should return 1.0 for concept type (qualitative)', () => {
      expect(gateThreshold('concept')).toBe(1.0);
    });
    it('should return 1.0 for design type (qualitative)', () => {
      expect(gateThreshold('design')).toBe(1.0);
    });
  });

  describe('isMastered', () => {
    it('should gate quantitative types by score ≥ threshold', () => {
      expect(isMastered(0.95, 'memory', false)).toBe(true);
      expect(isMastered(0.85, 'memory', false)).toBe(false);
    });
    it('should gate qualitative types by qualitative pass', () => {
      expect(isMastered(0.0, 'concept', true)).toBe(true);
      expect(isMastered(1.0, 'concept', false)).toBe(false);
    });
  });

  describe('Spaced repetition', () => {
    it('should have correct interval sequences per type', () => {
      expect(INTERVAL_SEQUENCES.memory).toEqual([0, 1, 3, 7, 14, 30, 60]);
      expect(INTERVAL_SEQUENCES.concept).toEqual([3, 7, 14, 30]);
      expect(INTERVAL_SEQUENCES.procedure).toEqual([3, 7, 14]);
      expect(INTERVAL_SEQUENCES.design).toEqual([14, 28]);
    });

    it('should advance interval on correct answer', () => {
      const state = getInitialState('memory');
      expect(state.interval_index).toBe(0);
      const next = scheduleNext({ ...state }, 'memory', true);
      expect(next.interval_index).toBe(1);
      expect(next.consecutive_correct).toBe(1);
    });

    it('should jump 2 intervals after 2 consecutive correct', () => {
      let state = getInitialState('memory');
      state = scheduleNext(state, 'memory', true);
      state = scheduleNext(state, 'memory', true);
      // After 2 consecutive correct, should jump 2 and reset counter
      expect(state.consecutive_correct).toBe(0);
      expect(state.interval_index).toBe(3); // 0→1→(+2)=3
    });

    it('should go back 1 interval on wrong answer', () => {
      let state = getInitialState('memory');
      state = scheduleNext(state, 'memory', true); // index=1
      state = scheduleNext(state, 'memory', false); // index=0
      expect(state.interval_index).toBe(0);
      expect(state.consecutive_wrong).toBe(1);
    });

    it('should not go below 0', () => {
      const state = getInitialState('memory');
      const next = scheduleNext({ ...state }, 'memory', false);
      expect(next.interval_index).toBe(0);
    });
  });

  describe('Adaptive replanning', () => {
    it('should allow replan when count < max', () => {
      expect(canReplan(0)).toBe(true);
      expect(canReplan(1)).toBe(true);
    });
    it('should disallow replan when count >= max', () => {
      expect(canReplan(2)).toBe(false);
      expect(canReplan(3)).toBe(false);
    });
    it('MAX_REPLAN_ROUNDS should be 2', () => {
      expect(MAX_REPLAN_ROUNDS).toBe(2);
    });
  });
});

describe('Mastery Store (SQLite)', () => {
  beforeEach(() => {
    process.env.KNOWLEDGE_ENGINE_HOME = `/tmp/ke-test-${randomUUID()}`;
    closeDb();
    resetConfig();
  });

  afterEach(() => {
    closeDb();
    const home = process.env.KNOWLEDGE_ENGINE_HOME;
    if (home && fs.existsSync(home)) {
      fs.rmSync(home, { recursive: true });
    }
  });

  describe('registerKnowledgePoint', () => {
    it('should create a KP with initial repetition state', () => {
      const { kp_id } = registerKnowledgePoint('binary search', 'memory');
      expect(kp_id).toMatch(/^kp_/);
      const status = getMasteryStatus(kp_id);
      expect(status.mastery).toBe(0);
      expect(status.threshold).toBe(0.9);
      expect(status.mastered).toBe(false);
      expect(status.kp_type).toBe('memory');
    });

    it('should return existing KP for same concept', () => {
      const { kp_id: id1 } = registerKnowledgePoint('recursion', 'concept');
      const { kp_id: id2 } = registerKnowledgePoint('recursion', 'concept');
      expect(id1).toBe(id2);
    });
  });

  describe('recordQuizAttempt', () => {
    it('should update mastery after correct answer', () => {
      const { kp_id } = registerKnowledgePoint('sorting', 'memory');
      const result = recordQuizAttempt(kp_id, true, 'choice', 'merge sort');
      expect(result.mastery).toBe(0.5); // single answer, confidence cap
      expect(result.mastered).toBe(false); // 0.5 < 0.9
    });

    it('should reach mastery after enough correct answers', () => {
      const { kp_id } = registerKnowledgePoint('arrays', 'memory');
      recordQuizAttempt(kp_id, true, 'choice', 'a');
      recordQuizAttempt(kp_id, true, 'choice', 'b');
      recordQuizAttempt(kp_id, true, 'choice', 'c');
      recordQuizAttempt(kp_id, true, 'choice', 'd');
      const result = recordQuizAttempt(kp_id, true, 'choice', 'e');
      expect(result.mastered).toBe(true);
    });

    it('should auto-resolve weak concept when mastered', () => {
      // First register weakness
      recordWeakness('hashing', 'quiz_miss', 'failed hash quiz');
      expect(getWeakConcepts('active')).toHaveLength(1);

      // Then master it
      const { kp_id } = registerKnowledgePoint('hashing', 'memory');
      for (let i = 0; i < 5; i++) {
        recordQuizAttempt(kp_id, true, 'choice', `ans${i}`);
      }
      expect(getWeakConcepts('active')).toHaveLength(0);
      expect(getWeakConcepts('resolved')).toHaveLength(1);
    });
  });

  describe('recordQualitativeAssessment', () => {
    it('should gate concept type qualitatively', () => {
      const { kp_id } = registerKnowledgePoint('abstraction', 'concept');
      const result = recordQualitativeAssessment(
        kp_id,
        true,
        'good explanation',
      );
      expect(result.mastered).toBe(true);
    });

    it('should not master concept when qualitative fails', () => {
      const { kp_id } = registerKnowledgePoint('polymorphism', 'concept');
      const result = recordQualitativeAssessment(kp_id, false, 'incomplete');
      expect(result.mastered).toBe(false);
    });
  });

  describe('getDueReviews', () => {
    it('should return empty when nothing is due (concept type has 3-day initial interval)', () => {
      registerKnowledgePoint('graphs', 'concept');
      expect(getDueReviews()).toHaveLength(0);
    });

    it('should return due items for memory type (0-day initial interval)', () => {
      registerKnowledgePoint('immediate-fact', 'memory');
      const due = getDueReviews();
      expect(due.length).toBeGreaterThan(0);
      expect(due[0].concept).toBe('immediate-fact');
    });
  });

  describe('incrementReplan / getReplanStatus', () => {
    it('should track replan count and enforce max 2', () => {
      const { session_id } = startSession('solve', 'test problem');

      const r1 = incrementReplan(session_id);
      expect(r1.replan_count).toBe(1);
      expect(r1.can_continue).toBe(true);

      const r2 = incrementReplan(session_id);
      expect(r2.replan_count).toBe(2);
      expect(r2.can_continue).toBe(false);

      const status = getReplanStatus(session_id);
      expect(status.replan_count).toBe(2);
      expect(status.can_continue).toBe(false);
      expect(status.max_rounds).toBe(2);
    });
  });
});
