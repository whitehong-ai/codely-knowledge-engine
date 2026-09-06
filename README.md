# Codely Knowledge Engine MCP Server

Memory system (Trace Forest + Learner Profile), hybrid retrieval, and personalization for DeepTutor-equivalent capabilities. Standalone MCP server, physically migrated from the `codely-cli` monorepo (`packages/knowledge-engine`) with zero functional changes.

## Requirements

- Node.js >= 20 (`better-sqlite3` native module compiles against the running Node ABI)

## Install & Build

```bash
npm install
npm run build      # outputs dist/index.js (MCP server entry)
npm run typecheck  # tsc --noEmit, expect 0 errors
npm run test       # vitest, all tests use isolated /tmp data dirs
```

## Mount as MCP Server

Add to `~/.codely-cli/settings.json`:

```json
{
  "mcpServers": {
    "knowledge-engine": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/hongfeng/code/codely-knowledge-engine/dist/index.js"],
      "env": {
        "KNOWLEDGE_ENGINE_HOME": "~/.codely-knowledge"
      }
    }
  }
}
```

## Configuration

- `KNOWLEDGE_ENGINE_HOME` — data directory (default `~/.codely-knowledge`). Contains:
  - `knowledge.db` — learner profile / mastery / sessions (SQLite)
  - `fts.db` — keyword search (SQLite FTS5)
  - `lancedb/` — vector storage

Existing data is picked up as-is; switching the MCP mount path does not migrate or touch data.

## Tools (21)

| Area | Tools |
|------|-------|
| Trace Forest | `add_trace`, `search_trace`, `list_traces`, `read_trace_nodes` |
| Sessions | `start_session`, `end_session`, `check_memory_prompts` |
| Learner Profile | `get_learner_profile`, `record_weakness`, `resolve_weakness`, `review_concept`, `get_weak_concepts`, `add_reflection` |
| Context Assembly | `get_memory_context` |
| Mastery Path | `register_knowledge_point`, `record_quiz_attempt`, `record_qualitative`, `get_due_reviews`, `get_mastery_status`, `increment_replan`, `get_replan_status` |
