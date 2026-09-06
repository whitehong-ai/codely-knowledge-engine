/**
 * Learner Profile types — 𝒟_s (sessions), 𝒟_w (weak concepts), 𝒟_r (reflections).
 */

export interface SessionRecord {
  session_id: string;
  task_type: string;
  topic: string;
  summary: string;
  started_at: string;
  ended_at: string | null;
  outcome: 'active' | 'success' | 'partial' | 'failed';
}

export interface WeakConcept {
  concept: string;
  state: 'active' | 'reviewing' | 'resolved';
  first_seen: string;
  last_seen: string;
  resolved_at: string | null;
  evidence_count: number;
}

export interface ConceptEvidence {
  id: number;
  concept: string;
  trace_node_id: string | null;
  evidence_type: string;
  detail: string;
  timestamp: string;
}

export interface Reflection {
  reflection_id: string;
  session_id: string;
  topic: string;
  what_worked: string;
  what_failed: string;
  recommendation: string;
  created_at: string;
}

export interface LearnerProfile {
  sessions: SessionRecord[];
  weak_concepts: WeakConcept[];
  reflections: Reflection[];
}

export type MemoryPromptType = 'summary' | 'reflection' | 'none';

export interface MemoryPrompt {
  should_summarize: boolean;
  summary_prompt?: string;
  should_reflect: boolean;
  reflection_prompt?: string;
}
