import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  startSession,
  endSession,
  getSessions,
  getSession,
  recordWeakness,
  resolveWeakness,
  reviewConcept,
  getWeakConcepts,
  addReflection,
  getReflections,
  getLearnerProfile,
  checkMemoryPrompts,
} from '../src/learner-profile/store.js';
import { addTrace } from '../src/trace-forest/store.js';
import { TraceLevel } from '../src/trace-forest/types.js';
import { closeDb } from '../src/db.js';
import { resetConfig } from '../src/config.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

describe('Learner Profile', () => {
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

  describe('Sessions (𝒟_s)', () => {
    it('should create and end a session', () => {
      const { session_id } = startSession('solve', 'binary search');
      expect(session_id).toMatch(/^sess_/);

      const result = endSession(session_id, 'success', 'Solved the problem');
      expect(result.success).toBe(true);

      const session = getSession(session_id);
      expect(session?.outcome).toBe('success');
      expect(session?.summary).toBe('Solved the problem');
      expect(session?.ended_at).toBeTruthy();
    });

    it('should list sessions', () => {
      startSession('quiz', 'JWT');
      startSession('research', 'attention');

      const sessions = getSessions();
      expect(sessions).toHaveLength(2);
    });
  });

  describe('Weak Concepts (𝒟_w)', () => {
    it('should record weakness and auto-create concept', () => {
      const result = recordWeakness(
        'JWT',
        'quiz_miss',
        'Score 40/100 on JWT quiz',
      );
      expect(result.concept).toBe('JWT');
      expect(result.state).toBe('active');

      const weak = getWeakConcepts('active');
      expect(weak).toHaveLength(1);
      expect(weak[0].concept).toBe('JWT');
      expect(weak[0].evidence_count).toBe(1);
    });

    it('should accumulate evidence on same concept', () => {
      recordWeakness('RBAC', 'quiz_miss', 'missed 1');
      recordWeakness('RBAC', 'low_score', 'score 50');

      const weak = getWeakConcepts('active');
      expect(weak).toHaveLength(1);
      expect(weak[0].evidence_count).toBe(2);
    });

    it('should resolve weakness', () => {
      recordWeakness('recursion', 'quiz_miss', 'failed recursion quiz');
      resolveWeakness('recursion');

      const active = getWeakConcepts('active');
      expect(active).toHaveLength(0);

      const resolved = getWeakConcepts('resolved');
      expect(resolved).toHaveLength(1);
      expect(resolved[0].concept).toBe('recursion');
      expect(resolved[0].resolved_at).toBeTruthy();
    });

    it('should reactivate resolved concept when new weakness recorded', () => {
      recordWeakness('sorting', 'quiz_miss', 'first miss');
      resolveWeakness('sorting');
      recordWeakness('sorting', 'quiz_miss', 'second miss');

      const active = getWeakConcepts('active');
      expect(active).toHaveLength(1);
      expect(active[0].concept).toBe('sorting');
    });

    it('should transition active→reviewing via reviewConcept', () => {
      recordWeakness('graphs', 'quiz_miss', 'missed graph traversal');
      const result = reviewConcept('graphs');
      expect(result.success).toBe(true);
      expect(result.state).toBe('reviewing');

      const reviewing = getWeakConcepts('reviewing');
      expect(reviewing).toHaveLength(1);
      expect(reviewing[0].concept).toBe('graphs');

      // active should no longer contain it
      const active = getWeakConcepts('active');
      expect(active.find((w) => w.concept === 'graphs')).toBeUndefined();
    });

    it('should not transition resolved→reviewing via reviewConcept', () => {
      recordWeakness('trees', 'quiz_miss', 'missed tree question');
      resolveWeakness('trees');
      const result = reviewConcept('trees');
      expect(result.success).toBe(false);
      // Still resolved
      expect(result.state).toBe('resolved');
    });
  });

  describe('Reflections (𝒟_r)', () => {
    it('should add and list reflections', () => {
      const { session_id } = startSession('solve', 'DP');
      addReflection(
        session_id,
        'DP',
        'visual approach worked',
        'recursion confused user',
        'use tables next time',
      );

      const reflections = getReflections();
      expect(reflections).toHaveLength(1);
      expect(reflections[0].what_worked).toBe('visual approach worked');
    });
  });

  describe('checkMemoryPrompts', () => {
    it('should suggest summary when session has ≥3 L1 traces', () => {
      const { session_id } = startSession('solve', 'binary search');
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id,
        task_type: 'solve',
        content: 'event 1',
      });
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id,
        task_type: 'solve',
        content: 'event 2',
      });
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id,
        task_type: 'solve',
        content: 'event 3',
      });
      endSession(session_id, 'success');

      const prompts = checkMemoryPrompts(session_id);
      expect(prompts.should_summarize).toBe(true);
      expect(prompts.summary_prompt).toBeTruthy();
    });

    it('should suggest reflection when weakness evidence exists', () => {
      const { session_id } = startSession('quiz', 'JWT');
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id,
        task_type: 'quiz',
        content: 'quiz event',
      });
      recordWeakness('JWT', 'quiz_miss', 'missed JWT question');
      endSession(session_id, 'partial');

      const prompts = checkMemoryPrompts(session_id);
      expect(prompts.should_reflect).toBe(true);
      expect(prompts.reflection_prompt).toBeTruthy();
    });

    it('should not suggest anything for active sessions', () => {
      const { session_id } = startSession('solve', 'test');
      const prompts = checkMemoryPrompts(session_id);
      expect(prompts.should_summarize).toBe(false);
      expect(prompts.should_reflect).toBe(false);
    });
  });

  describe('getLearnerProfile', () => {
    it('should return all profile sections', () => {
      startSession('quiz', 'test');
      recordWeakness('concept1', 'quiz_miss', 'detail');

      const profile = getLearnerProfile();
      expect(profile.sessions).toHaveLength(1);
      expect(profile.weak_concepts).toHaveLength(1);
      expect(profile.reflections).toHaveLength(0);
    });
  });
});
