/**
 * Trace Forest store — SQLite persistence + in-memory vector search.
 */
import { randomUUID } from 'node:crypto';
import { getDb, getFtsDb } from '../db.js';
import { embed, cosineSimilarity } from '../embeddings.js';
import type {
  TraceNode,
  TraceSearchResult,
  TraceListFilter,
  TraceListEntry,
  TraceNodeWithAncestors,
} from './types.js';
import { TraceLevel } from './types.js';

// In-memory vector cache (node_id → vector) — backed by SQLite trace_vectors
const _vectorCache = new Map<string, number[]>();

export function addTrace(params: {
  level: TraceLevel;
  session_id: string;
  task_type: string;
  topic?: string;
  content: string;
  parent_id?: string | null;
  metadata?: Record<string, any>;
}): { node_id: string } {
  const db = getDb();
  const node_id = `trace_${randomUUID().slice(0, 16)}`;
  const now = new Date().toISOString();

  db.prepare(
    `INSERT INTO trace_nodes (node_id, level, parent_id, session_id, task_type, topic, content, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    node_id,
    params.level,
    params.parent_id ?? null,
    params.session_id,
    params.task_type,
    params.topic ?? '',
    params.content,
    JSON.stringify(params.metadata ?? {}),
    now,
  );

  // Index in FTS5 for keyword search
  try {
    const ftsDb = getFtsDb();
    ftsDb
      .prepare('INSERT INTO trace_fts (content, node_id) VALUES (?, ?)')
      .run(params.content, node_id);
  } catch {
    // FTS is optional
  }

  // Embed + persist to SQLite (fire-and-forget — will be available for next search)
  void embed(params.content).then((result) => {
    _vectorCache.set(node_id, result.vector);
    try {
      getDb()
        .prepare(
          'INSERT OR REPLACE INTO trace_vectors (node_id, vector) VALUES (?, ?)',
        )
        .run(node_id, JSON.stringify(result.vector));
    } catch {
      // persistence is best-effort
    }
  });

  return { node_id };
}

export async function searchTrace(
  query: string,
  options: {
    top_k?: number;
    level?: TraceLevel;
    task_type?: string;
    topic?: string;
  } = {},
): Promise<TraceSearchResult[]> {
  const top_k = options.top_k ?? 5;
  const db = getDb();

  // Build filter clause for candidate set
  const conditions: string[] = [];
  const params: any[] = [];
  if (options.level) {
    conditions.push('level = ?');
    params.push(options.level);
  }
  if (options.task_type) {
    conditions.push('task_type = ?');
    params.push(options.task_type);
  }
  if (options.topic) {
    conditions.push('topic LIKE ?');
    params.push(`%${options.topic}%`);
  }
  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db
    .prepare(
      `SELECT * FROM trace_nodes ${where} ORDER BY created_at DESC LIMIT 500`,
    )
    .all(...params) as any[];

  if (rows.length === 0) return [];

  // --- Dense search (cosine similarity via embeddings) ---
  const queryVec = await embed(query);
  const denseScored: Map<string, number> = new Map();
  for (const row of rows) {
    let vec: number[] | undefined = _vectorCache.get(row.node_id);
    if (!vec) {
      // Try loading from SQLite persistence
      try {
        const vrow = db
          .prepare('SELECT vector FROM trace_vectors WHERE node_id = ?')
          .get(row.node_id) as any;
        if (vrow) {
          vec = JSON.parse(vrow.vector) as number[];
          _vectorCache.set(row.node_id, vec);
        }
      } catch {
        // fall through to lazy embed
      }
    }
    if (!vec) {
      // Lazy-load embedding (last resort)
      const result = await embed(row.content);
      vec = result.vector;
      _vectorCache.set(row.node_id, vec);
      try {
        db.prepare(
          'INSERT OR REPLACE INTO trace_vectors (node_id, vector) VALUES (?, ?)',
        ).run(row.node_id, JSON.stringify(vec));
      } catch {
        /* best-effort */
      }
    }
    denseScored.set(row.node_id, cosineSimilarity(queryVec.vector, vec!));
  }
  // Dense ranking (sorted desc by score)
  const denseRanked = [...denseScored.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);

  // --- BM25 search via FTS5 ---
  const bm25Ranked: string[] = [];
  try {
    const ftsDb = getFtsDb();
    // Escape FTS5 query: wrap in double quotes for phrase match
    const ftsQuery = query.replace(/"/g, '""');
    const ftsRows = ftsDb
      .prepare(
        `SELECT node_id, rank FROM trace_fts WHERE trace_fts MATCH ? ORDER BY bm25(trace_fts) LIMIT ?`,
      )
      .all(`"${ftsQuery}"`, top_k * 2) as any[];
    for (const r of ftsRows) {
      // Only include if the node also passes the filter (exists in our rows set)
      if (rows.some((row) => row.node_id === r.node_id)) {
        bm25Ranked.push(r.node_id);
      }
    }
  } catch {
    // FTS is optional — fall back to dense-only
  }

  // --- RRF fusion (Reciprocal Rank Fusion, k=60) ---
  const k = 60;
  const rrfScores = new Map<string, number>();
  // Dense contribution (weight 0.7)
  denseRanked.forEach((nodeId, rank) => {
    rrfScores.set(nodeId, (rrfScores.get(nodeId) ?? 0) + 0.7 / (k + rank + 1));
  });
  // BM25 contribution (weight 0.3)
  bm25Ranked.forEach((nodeId, rank) => {
    rrfScores.set(nodeId, (rrfScores.get(nodeId) ?? 0) + 0.3 / (k + rank + 1));
  });

  // Build result objects from rows
  const rowMap = new Map(rows.map((r) => [r.node_id, r]));
  const scored: TraceSearchResult[] = [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, top_k)
    .map(([nodeId, rrfScore]) => {
      const row = rowMap.get(nodeId)!;
      return {
        node_id: row.node_id,
        content: row.content,
        level: row.level as TraceLevel,
        topic: row.topic,
        task_type: row.task_type,
        score: Math.round(rrfScore * 1000) / 1000,
      };
    });

  return scored;
}

export function listTraces(filter: TraceListFilter = {}): TraceListEntry[] {
  const db = getDb();
  const conditions: string[] = [];
  const params: any[] = [];

  if (filter.session_id) {
    conditions.push('session_id = ?');
    params.push(filter.session_id);
  }
  if (filter.level) {
    conditions.push('level = ?');
    params.push(filter.level);
  }
  if (filter.task_type) {
    conditions.push('task_type = ?');
    params.push(filter.task_type);
  }
  if (filter.topic) {
    conditions.push('topic LIKE ?');
    params.push(`%${filter.topic}%`);
  }
  if (filter.since) {
    conditions.push('created_at >= ?');
    params.push(filter.since);
  }
  if (filter.until) {
    conditions.push('created_at <= ?');
    params.push(filter.until);
  }

  const where =
    conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT node_id, level, session_id, task_type, topic, created_at FROM trace_nodes ${where} ORDER BY created_at DESC LIMIT 200`,
    )
    .all(...params) as any[];

  return rows.map((r) => ({
    node_id: r.node_id,
    level: r.level as TraceLevel,
    session_id: r.session_id,
    task_type: r.task_type,
    topic: r.topic,
    created_at: r.created_at,
  }));
}

export function readTraceNodes(node_ids: string[]): TraceNodeWithAncestors[] {
  const db = getDb();
  const results: TraceNodeWithAncestors[] = [];

  for (const node_id of node_ids) {
    const row = db
      .prepare('SELECT * FROM trace_nodes WHERE node_id = ?')
      .get(node_id) as any;
    if (!row) continue;

    const children = db
      .prepare(
        'SELECT node_id FROM trace_nodes WHERE parent_id = ? ORDER BY created_at',
      )
      .all(node_id) as any[];

    // Walk ancestor chain
    const ancestors: {
      node_id: string;
      level: TraceLevel;
      topic: string;
      content: string;
    }[] = [];
    let currentParent = row.parent_id;
    while (currentParent) {
      const parent = db
        .prepare('SELECT * FROM trace_nodes WHERE node_id = ?')
        .get(currentParent) as any;
      if (!parent) break;
      ancestors.unshift({
        node_id: parent.node_id,
        level: parent.level as TraceLevel,
        topic: parent.topic,
        content: parent.content,
      });
      currentParent = parent.parent_id;
    }

    results.push({
      node_id: row.node_id,
      level: row.level as TraceLevel,
      parent_id: row.parent_id,
      session_id: row.session_id,
      task_type: row.task_type,
      topic: row.topic,
      content: row.content,
      metadata: JSON.parse(row.metadata || '{}'),
      created_at: row.created_at,
      children_ids: children.map((c) => c.node_id),
      ancestors,
    });
  }

  return results;
}

export function countL1Traces(session_id: string): number {
  const db = getDb();
  const row = db
    .prepare(
      'SELECT COUNT(*) as cnt FROM trace_nodes WHERE session_id = ? AND level = ?',
    )
    .get(session_id, TraceLevel.L1_RAW) as any;
  return row?.cnt ?? 0;
}

export function getTracesBySession(session_id: string): TraceNode[] {
  const db = getDb();
  const rows = db
    .prepare(
      'SELECT * FROM trace_nodes WHERE session_id = ? ORDER BY created_at',
    )
    .all(session_id) as any[];

  return rows.map((r) => ({
    node_id: r.node_id,
    level: r.level as TraceLevel,
    parent_id: r.parent_id,
    session_id: r.session_id,
    task_type: r.task_type,
    topic: r.topic,
    content: r.content,
    metadata: JSON.parse(r.metadata || '{}'),
    created_at: r.created_at,
    children_ids: [],
  }));
}
