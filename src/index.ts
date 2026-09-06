#!/usr/bin/env node
/**
 * Knowledge Engine MCP Server
 *
 * Provides memory system (Trace Forest + Learner Profile) and context assembly
 * for DeepTutor-equivalent capabilities. Does NOT call any LLM — all generation
 * is handled by Codely Agent via Skills.
 */
import { FastMCP } from 'fastmcp';
import { z } from 'zod';

import { getConfig } from './config.js';
import {
  addTrace,
  searchTrace,
  listTraces,
  readTraceNodes,
} from './trace-forest/store.js';
import { TraceLevel } from './trace-forest/types.js';
import {
  startSession,
  endSession,
  getSessions,
  getSession,
  recordWeakness,
  resolveWeakness,
  reviewConcept,
  getWeakConcepts,
  getEvidence,
  addReflection,
  getReflections,
  getLearnerProfile,
  checkMemoryPrompts,
  registerKnowledgePoint,
  recordQuizAttempt,
  recordQualitativeAssessment,
  getDueReviews,
  getMasteryStatus,
  incrementReplan,
  getReplanStatus,
} from './learner-profile/store.js';
import { assembleMemoryContext } from './context-assembly.js';

const config = getConfig();

const server = new FastMCP({
  name: 'knowledge-engine',
  version: '0.1.0',
});

// ── Trace Forest Tools ────────────────────────────────────

server.addTool({
  name: 'add_trace',
  description:
    'Add a trace node to the Trace Forest. L1 = raw events (tool calls, Q&A), L2 = session summaries, L3 = cross-session synthesis. Skills call this after each interaction to build memory.',
  parameters: z.object({
    level: z
      .enum(['l1_raw', 'l2_summary', 'l3_synthesis'])
      .describe('Trace level'),
    session_id: z.string().describe('Session ID this trace belongs to'),
    task_type: z
      .enum(['quiz', 'learning_plan', 'research', 'solve', 'chat'])
      .describe('Task type'),
    topic: z.string().optional().describe('Topic of the trace'),
    content: z
      .string()
      .describe('Trace content (event, summary, or synthesis)'),
    parent_id: z
      .string()
      .optional()
      .describe('Parent trace node ID (for L2→L1 or L3→L2 hierarchy)'),
    metadata: z
      .record(z.any())
      .optional()
      .describe('Additional metadata (score, concepts, sources...)'),
  }),
  execute: async (args) => {
    const result = addTrace({
      level: args.level as TraceLevel,
      session_id: args.session_id,
      task_type: args.task_type,
      topic: args.topic,
      content: args.content,
      parent_id: args.parent_id,
      metadata: args.metadata,
    });
    return JSON.stringify(result);
  },
});

server.addTool({
  name: 'search_trace',
  description:
    'Semantic search on the Trace Forest. Returns matching trace nodes ranked by relevance. Useful for retrieving past learning context before starting a new task.',
  parameters: z.object({
    query: z.string().describe('Search query'),
    top_k: z.number().optional().describe('Number of results (default 5)'),
    level: z
      .enum(['l1_raw', 'l2_summary', 'l3_synthesis'])
      .optional()
      .describe('Filter by trace level'),
    task_type: z.string().optional().describe('Filter by task type'),
    topic: z.string().optional().describe('Filter by topic (fuzzy match)'),
  }),
  execute: async (args) => {
    const results = await searchTrace(args.query, {
      top_k: args.top_k,
      level: args.level as TraceLevel | undefined,
      task_type: args.task_type,
      topic: args.topic,
    });
    return JSON.stringify(results);
  },
});

server.addTool({
  name: 'list_traces',
  description:
    'List trace nodes by filter (session, level, task type, topic, time range). Useful for enumerating what happened in a session.',
  parameters: z.object({
    session_id: z.string().optional().describe('Filter by session ID'),
    level: z
      .enum(['l1_raw', 'l2_summary', 'l3_synthesis'])
      .optional()
      .describe('Filter by trace level'),
    task_type: z.string().optional().describe('Filter by task type'),
    topic: z.string().optional().describe('Filter by topic (fuzzy)'),
    since: z.string().optional().describe('ISO timestamp, inclusive'),
    until: z.string().optional().describe('ISO timestamp, inclusive'),
  }),
  execute: async (args) => {
    const results = listTraces({
      session_id: args.session_id,
      level: args.level as TraceLevel | undefined,
      task_type: args.task_type,
      topic: args.topic,
      since: args.since,
      until: args.until,
    });
    return JSON.stringify(results);
  },
});

server.addTool({
  name: 'read_trace_nodes',
  description:
    'Read full trace nodes by ID, including ancestor chain. Useful for understanding the full context of a trace event.',
  parameters: z.object({
    node_ids: z.array(z.string()).describe('Trace node IDs to read'),
  }),
  execute: async (args) => {
    const results = readTraceNodes(args.node_ids);
    return JSON.stringify(results);
  },
});

// ── Learner Profile Tools ─────────────────────────────────

server.addTool({
  name: 'start_session',
  description:
    'Start a new learning session. Returns session_id. Call at the beginning of any deep-solve/deep-question/deep-research/mastery-path workflow.',
  parameters: z.object({
    task_type: z
      .enum(['quiz', 'learning_plan', 'research', 'solve', 'chat'])
      .describe('Task type'),
    topic: z.string().describe('Session topic'),
  }),
  execute: async (args) => {
    return JSON.stringify(startSession(args.task_type, args.topic));
  },
});

server.addTool({
  name: 'end_session',
  description:
    'End a learning session with an outcome. Call at the end of any workflow.',
  parameters: z.object({
    session_id: z.string().describe('Session ID to end'),
    outcome: z
      .enum(['success', 'partial', 'failed'])
      .describe('Session outcome'),
    summary: z.string().optional().describe('Optional session summary'),
  }),
  execute: async (args) => {
    return JSON.stringify(
      endSession(args.session_id, args.outcome, args.summary),
    );
  },
});

server.addTool({
  name: 'get_learner_profile',
  description:
    'Get the full learner profile: session history (𝒟_s), weak concepts (𝒟_w), and reflections (𝒟_r). Used to personalize any interaction.',
  parameters: z.object({
    section: z
      .enum(['sessions', 'weak_concepts', 'reflections', 'all'])
      .optional()
      .describe('Profile section (default all)'),
  }),
  execute: async (args) => {
    const section = args.section ?? 'all';
    if (section === 'sessions')
      return JSON.stringify({ sessions: getSessions() });
    if (section === 'weak_concepts')
      return JSON.stringify({ weak_concepts: getWeakConcepts() });
    if (section === 'reflections')
      return JSON.stringify({ reflections: getReflections() });
    return JSON.stringify(getLearnerProfile());
  },
});

server.addTool({
  name: 'record_weakness',
  description:
    'Record a weakness concept with evidence. Automatically creates or updates the concept state. Call after quiz misses, step struggles, or low scores.',
  parameters: z.object({
    concept: z.string().describe('Weakness concept name'),
    evidence_type: z
      .enum(['quiz_miss', 'step_struggle', 'low_score', 'repeated_error'])
      .describe('Evidence type'),
    detail: z.string().describe('Evidence detail'),
    trace_node_id: z.string().optional().describe('Associated trace node ID'),
  }),
  execute: async (args) => {
    return JSON.stringify(
      recordWeakness(
        args.concept,
        args.evidence_type,
        args.detail,
        args.trace_node_id,
      ),
    );
  },
});

server.addTool({
  name: 'resolve_weakness',
  description:
    'Mark a weakness concept as resolved. Call when the user demonstrates mastery.',
  parameters: z.object({
    concept: z.string().describe('Concept to resolve'),
  }),
  execute: async (args) => {
    return JSON.stringify(resolveWeakness(args.concept));
  },
});

server.addTool({
  name: 'review_concept',
  description:
    "Transition a weak concept from 'active' to 'reviewing' state. Call when scheduling a concept for spaced-repetition review (e.g. in mastery-path).",
  parameters: z.object({
    concept: z.string().describe('Concept to mark as reviewing'),
  }),
  execute: async (args) => {
    return JSON.stringify(reviewConcept(args.concept));
  },
});

server.addTool({
  name: 'get_weak_concepts',
  description:
    'Get weak concepts filtered by state. Default returns active weaknesses only.',
  parameters: z.object({
    state: z
      .enum(['active', 'reviewing', 'resolved'])
      .optional()
      .describe('Filter by state (default: active)'),
  }),
  execute: async (args) => {
    return JSON.stringify(getWeakConcepts(args.state));
  },
});

server.addTool({
  name: 'add_reflection',
  description:
    'Record a teaching reflection (𝒟_r). Call after a session ends with weakness changes, prompted by check_memory_prompts.',
  parameters: z.object({
    session_id: z.string().describe('Session ID'),
    topic: z.string().describe('Reflection topic'),
    what_worked: z.string().describe('What worked well'),
    what_failed: z.string().describe('What failed'),
    recommendation: z.string().describe('Recommendation for future sessions'),
  }),
  execute: async (args) => {
    return JSON.stringify(
      addReflection(
        args.session_id,
        args.topic,
        args.what_worked,
        args.what_failed,
        args.recommendation,
      ),
    );
  },
});

server.addTool({
  name: 'check_memory_prompts',
  description:
    'Check if the LLM should generate a session summary (L2 trace) or reflection. Returns prompts for the Codely LLM to execute. Call after ending a session.',
  parameters: z.object({
    session_id: z.string().describe('Session ID to check'),
  }),
  execute: async (args) => {
    return JSON.stringify(checkMemoryPrompts(args.session_id));
  },
});

// ── Context Assembly Tool ─────────────────────────────────

server.addTool({
  name: 'get_memory_context',
  description:
    'Assemble personalized memory context (𝒞_mem) for a query. Returns relevant traces, active weak concepts, and recent reflections. Call before any Agent step to personalize the interaction.',
  parameters: z.object({
    query: z.string().describe('User query or task'),
    task_type: z
      .string()
      .describe('Task type (quiz/learning_plan/research/solve/chat)'),
    session_id: z.string().describe('Current session ID'),
  }),
  execute: async (args) => {
    const context = await assembleMemoryContext(
      args.query,
      args.task_type,
      args.session_id,
    );
    return JSON.stringify(context);
  },
});

// ── Mastery Tools (DeepTutor-aligned) ──────────────────────

server.addTool({
  name: 'register_knowledge_point',
  description:
    'Register a knowledge point for mastery tracking. Each KP has a type: memory (facts), procedure (step-by-step), concept (ideas, qualitative gate), design (open-ended, qualitative gate). Call when building a mastery path.',
  parameters: z.object({
    concept: z.string().describe('Concept/knowledge point name'),
    kp_type: z
      .enum(['memory', 'procedure', 'concept', 'design'])
      .optional()
      .describe('Knowledge type (default: concept)'),
    session_id: z.string().optional().describe('Session ID'),
  }),
  execute: async (args) => {
    return JSON.stringify(
      registerKnowledgePoint(
        args.concept,
        args.kp_type ?? 'concept',
        args.session_id,
      ),
    );
  },
});

server.addTool({
  name: 'record_quiz_attempt',
  description:
    'Record a quiz attempt for a knowledge point. Updates mastery score (recency-weighted accuracy with confidence cap), advances spaced repetition, and auto-resolves weak concepts when mastery gate is met. MEMORY/PROCEDURE gate: mastery ≥ 0.9. CONCEPT/DESIGN: use record_qualitative instead.',
  parameters: z.object({
    kp_id: z.string().describe('Knowledge point ID'),
    is_correct: z.boolean().describe('Whether the answer was correct'),
    question_type: z
      .string()
      .optional()
      .describe('Question type (choice/short/open)'),
    answer: z.string().optional().describe("User's answer"),
  }),
  execute: async (args) => {
    return JSON.stringify(
      recordQuizAttempt(
        args.kp_id,
        args.is_correct,
        args.question_type ?? 'short',
        args.answer ?? '',
      ),
    );
  },
});

server.addTool({
  name: 'record_qualitative',
  description:
    'Record a qualitative assessment (Feynman-style check) for a CONCEPT or DESIGN knowledge point. This is the gate for qualitative types — pass=true means mastery demonstrated.',
  parameters: z.object({
    kp_id: z.string().describe('Knowledge point ID'),
    passed: z
      .boolean()
      .describe('Whether the explanation demonstrates mastery'),
    evidence: z
      .string()
      .optional()
      .describe('Note on what was strong or missing'),
  }),
  execute: async (args) => {
    return JSON.stringify(
      recordQualitativeAssessment(args.kp_id, args.passed, args.evidence ?? ''),
    );
  },
});

server.addTool({
  name: 'get_due_reviews',
  description:
    'Get spaced-repetition review tasks that are due now. Returns knowledge points whose next_review_at has passed, sorted by priority (error KPs first, then memory > concept > procedure > design).',
  parameters: z.object({
    max_tasks: z.number().optional().describe('Max results (default 5)'),
  }),
  execute: async (args) => {
    return JSON.stringify(getDueReviews(args.max_tasks ?? 5));
  },
});

server.addTool({
  name: 'get_mastery_status',
  description:
    'Get mastery status for a knowledge point: current mastery score, threshold, mastered flag, attempt count, and correct count.',
  parameters: z.object({
    kp_id: z.string().describe('Knowledge point ID'),
  }),
  execute: async (args) => {
    return JSON.stringify(getMasteryStatus(args.kp_id));
  },
});

server.addTool({
  name: 'increment_replan',
  description:
    'Increment the replan count for a deep-solve session. Returns whether another replan is allowed (max 2 rounds). Call when the Solver phase fails and needs to go back to the Planner.',
  parameters: z.object({
    session_id: z.string().describe('Session ID'),
  }),
  execute: async (args) => {
    return JSON.stringify(incrementReplan(args.session_id));
  },
});

server.addTool({
  name: 'get_replan_status',
  description:
    'Check the current replan status for a deep-solve session: how many replans have occurred and whether another is allowed.',
  parameters: z.object({
    session_id: z.string().describe('Session ID'),
  }),
  execute: async (args) => {
    return JSON.stringify(getReplanStatus(args.session_id));
  },
});

// ── Start Server ──────────────────────────────────────────

const transport = process.argv.includes('--http') ? 'httpStream' : 'stdio';

if (transport === 'stdio') {
  await server.start({ transportType: 'stdio' });
} else {
  const port = parseInt(
    process.argv[process.argv.indexOf('--http') + 1] ?? '8766',
    10,
  );
  await server.start({
    transportType: 'httpStream',
    httpStream: { port, host: '127.0.0.1' },
  });
}
