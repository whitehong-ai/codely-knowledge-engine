/**
 * Trace Forest types — 3-level hierarchical memory.
 */

export enum TraceLevel {
  L1_RAW = 'l1_raw',
  L2_SUMMARY = 'l2_summary',
  L3_SYNTHESIS = 'l3_synthesis',
}

export interface TraceNode {
  node_id: string;
  level: TraceLevel;
  parent_id: string | null;
  session_id: string;
  task_type: string;
  topic: string;
  content: string;
  metadata: Record<string, any>;
  created_at: string;
  children_ids: string[];
}

export interface TraceSearchResult {
  node_id: string;
  content: string;
  level: TraceLevel;
  topic: string;
  task_type: string;
  score: number;
}

export interface TraceListFilter {
  session_id?: string;
  level?: TraceLevel;
  task_type?: string;
  topic?: string;
  since?: string;
  until?: string;
}

export interface TraceListEntry {
  node_id: string;
  level: TraceLevel;
  session_id: string;
  task_type: string;
  topic: string;
  created_at: string;
}

export interface TraceNodeWithAncestors extends TraceNode {
  ancestors: {
    node_id: string;
    level: TraceLevel;
    topic: string;
    content: string;
  }[];
}
