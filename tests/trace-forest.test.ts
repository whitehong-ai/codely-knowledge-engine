import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  addTrace,
  searchTrace,
  listTraces,
  readTraceNodes,
  countL1Traces,
} from '../src/trace-forest/store.js';
import { TraceLevel } from '../src/trace-forest/types.js';
import { getDb, closeDb } from '../src/db.js';
import { resetConfig } from '../src/config.js';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

describe('Trace Forest', () => {
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

  describe('addTrace', () => {
    it('should create an L1 trace node with a valid node_id', () => {
      const result = addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 'sess_test1',
        task_type: 'solve',
        topic: 'binary search',
        content: 'User asked about binary search algorithm',
      });
      expect(result.node_id).toMatch(/^trace_/);
    });

    it('should store metadata as JSON', () => {
      const { node_id } = addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 'sess_test2',
        task_type: 'quiz',
        topic: 'JWT',
        content: 'Quiz on JWT tokens',
        metadata: { score: 85, concepts: ['JWT', 'payload'] },
      });
      const db = getDb();
      const row = db
        .prepare('SELECT metadata FROM trace_nodes WHERE node_id = ?')
        .get(node_id) as any;
      expect(JSON.parse(row.metadata)).toEqual({
        score: 85,
        concepts: ['JWT', 'payload'],
      });
    });
  });

  describe('listTraces', () => {
    it('should list traces filtered by session_id', () => {
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 'sess_a',
        task_type: 'solve',
        content: 'event 1',
      });
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 'sess_a',
        task_type: 'solve',
        content: 'event 2',
      });
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 'sess_b',
        task_type: 'quiz',
        content: 'event 3',
      });

      const traces = listTraces({ session_id: 'sess_a' });
      expect(traces).toHaveLength(2);
      expect(traces.every((t) => t.session_id === 'sess_a')).toBe(true);
    });

    it('should filter by level', () => {
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 's1',
        task_type: 'solve',
        content: 'raw',
      });
      addTrace({
        level: TraceLevel.L2_SUMMARY,
        session_id: 's1',
        task_type: 'solve',
        content: 'summary',
      });

      const l2Traces = listTraces({ level: TraceLevel.L2_SUMMARY });
      expect(l2Traces).toHaveLength(1);
      expect(l2Traces[0].level).toBe(TraceLevel.L2_SUMMARY);
    });
  });

  describe('readTraceNodes', () => {
    it('should return node with ancestor chain', () => {
      const l1 = addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 's1',
        task_type: 'solve',
        content: 'raw event',
      });
      const l2 = addTrace({
        level: TraceLevel.L2_SUMMARY,
        session_id: 's1',
        task_type: 'solve',
        content: 'summary',
        parent_id: l1.node_id,
      });

      const nodes = readTraceNodes([l2.node_id]);
      expect(nodes).toHaveLength(1);
      expect(nodes[0].ancestors).toHaveLength(1);
      expect(nodes[0].ancestors[0].node_id).toBe(l1.node_id);
    });
  });

  describe('countL1Traces', () => {
    it('should count L1 traces in a session', () => {
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 's1',
        task_type: 'solve',
        content: 'e1',
      });
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 's1',
        task_type: 'solve',
        content: 'e2',
      });
      addTrace({
        level: TraceLevel.L2_SUMMARY,
        session_id: 's1',
        task_type: 'solve',
        content: 'summary',
      });

      expect(countL1Traces('s1')).toBe(2);
    });
  });

  describe('searchTrace', () => {
    it('should return matching traces sorted by score', async () => {
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 's1',
        task_type: 'solve',
        content:
          'Binary search is an efficient algorithm for finding elements in a sorted array',
      });
      addTrace({
        level: TraceLevel.L1_RAW,
        session_id: 's1',
        task_type: 'solve',
        content: 'Quick sort uses divide and conquer',
      });

      const results = await searchTrace('binary search algorithm', {
        top_k: 2,
      });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].content).toContain('Binary search');
    });
  });
});
