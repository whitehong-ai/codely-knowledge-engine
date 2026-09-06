/**
 * Personalization Context Assembly — 𝒞_mem
 *
 * Assembles memory context from Trace Forest + Learner Profile
 * before each Agent step.
 */
import { searchTrace } from './trace-forest/store.js';
import { getWeakConcepts, getReflections } from './learner-profile/store.js';
import { TraceLevel } from './trace-forest/types.js';

export interface MemoryContext {
  trace_context: {
    node_id: string;
    content: string;
    level: string;
    topic: string;
    score: number;
  }[];
  weak_concepts: { concept: string; state: string; evidence_count: number }[];
  relevant_reflections: {
    topic: string;
    what_worked: string;
    what_failed: string;
    recommendation: string;
  }[];
  context_text: string;
}

export async function assembleMemoryContext(
  query: string,
  task_type: string,
  session_id: string,
): Promise<MemoryContext> {
  // 1. Semantic search trace forest for relevant L2/L3 nodes
  const traces = await searchTrace(query, {
    top_k: 5,
    level: TraceLevel.L2_SUMMARY,
    task_type,
  });

  // Also search L3 synthesis if available
  const synthesis = await searchTrace(query, {
    top_k: 3,
    level: TraceLevel.L3_SYNTHESIS,
  });

  const allTraces = [...traces, ...synthesis];

  // 2. Get active weak concepts
  const weakConcepts = getWeakConcepts('active');

  // 3. Get recent reflections related to the topic
  const reflections = getReflections(10);

  // 4. Build context text
  const parts: string[] = [];

  if (allTraces.length > 0) {
    parts.push('=== Past Learning Context ===');
    for (const t of allTraces) {
      parts.push(`[${t.level}] ${t.topic}: ${t.content}`);
    }
  }

  if (weakConcepts.length > 0) {
    parts.push('\n=== Active Weak Concepts ===');
    for (const wc of weakConcepts) {
      parts.push(`- ${wc.concept} (${wc.evidence_count} evidence)`);
    }
  }

  if (reflections.length > 0) {
    parts.push('\n=== Recent Reflections ===');
    for (const r of reflections.slice(0, 5)) {
      parts.push(`- ${r.topic}: ${r.recommendation}`);
    }
  }

  return {
    trace_context: allTraces.map((t) => ({
      node_id: t.node_id,
      content: t.content,
      level: t.level,
      topic: t.topic,
      score: t.score,
    })),
    weak_concepts: weakConcepts.map((wc) => ({
      concept: wc.concept,
      state: wc.state,
      evidence_count: wc.evidence_count,
    })),
    relevant_reflections: reflections.slice(0, 5).map((r) => ({
      topic: r.topic,
      what_worked: r.what_worked,
      what_failed: r.what_failed,
      recommendation: r.recommendation,
    })),
    context_text: parts.join('\n'),
  };
}
