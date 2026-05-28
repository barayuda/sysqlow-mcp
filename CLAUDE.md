# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Install dependencies
bun install

# Run in development (watch mode, stdio transport)
bun dev

# Run in SSE/dashboard mode
MCP_TRANSPORT=sse PORT=50741 bun start

# Type-check without emitting
bun run typecheck

# Build to dist/ (keeps external deps unbundled)
bun run build

# Compile to a standalone binary at dist/sysqlow-mcp
bun run compile

# Run workflow integration test
bun run test:workflow
```

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL` | Optional | `libsql://...` URL enables Turso embedded replica sync. Omit for local-only SQLite. |
| `TURSO_AUTH_TOKEN` | If Turso URL set | Auth token for Turso cloud |
| `GEMINI_API_KEY` | Optional | Powers Sentinel validation, embeddings (model: `gemini-2.5-flash` / `gemini-embedding-001`) |
| `OPENAI_API_KEY` | Optional fallback | Used if `GEMINI_API_KEY` absent (model: `gpt-4o-mini` / `text-embedding-3-small`) |
| `BRAVE_API_KEY` | Optional | Web search for Sentinel; falls back to DuckDuckGo HTML scraper if absent |
| `LOCAL_DB_PATH` | Optional | Override SQLite file path (default: `sysqlow.db` in cwd) |
| `MCP_TRANSPORT` | Optional | Set to `sse` for HTTP/SSE + dashboard mode; otherwise stdio |
| `PORT` | Optional | HTTP port for SSE mode (default: `50741`) |

## Architecture

### Transport modes

The server has two distinct runtime personalities, controlled by `MCP_TRANSPORT`:

- **stdio** (default): pure JSON-RPC pipe, one client, no HTTP. Used by Claude Desktop, Cursor, etc.
- **httpStream / SSE**: HTTP server on port `50741` exposing `/sse` for MCP clients, a web dashboard at `/`, and REST endpoints (`/api/graph`, `/api/validate/:id`, `/api/logs`, `/api/env`). Also activates the background Sentinel audit daemon (every 12 h).

### Module map

| File | Role |
|---|---|
| `src/index.ts` | Entry point. Defines all 11 FastMCP tools, Hono HTTP routes, auto-hook on client `connect`, background Sentinel cron, and the console log ring buffer for the dashboard. |
| `src/db.ts` | Turso/libSQL client factory. Selects embedded-replica vs local-only mode based on `TURSO_DATABASE_URL`. Runs schema DDL and auto-migrations on startup. |
| `src/sentinel.ts` | `validateKnowledgeItem(id)` — fetches snippet, runs web search, calls LLM, writes validation metadata back to DB. |
| `src/llm.ts` | All LLM calls: `validateContentWithLLM`, `analyzeCodebaseWithLLM`, `extractDocumentationWithLLM`, `generateEmbedding`. Gemini is primary; OpenAI is fallback. Includes `cleanLLMJson()` regex repair for stray backslashes in LLM JSON output. |
| `src/search.ts` | `webSearch()` (Brave → DuckDuckGo HTML scraper fallback) and `cosineSimilarity()` (in-process vector math). |
| `src/learn.ts` | `learnCodebase(path)` — scans project root for config/manifest files, collects content, calls `analyzeCodebaseWithLLM`, stores results as "Project Context" snippets. |
| `src/dashboard-html.ts` | Single large string export: the full HTML/JS for the Vis.js knowledge graph dashboard. |
| `schema.sql` | SQLite DDL imported via `with { type: "text" }` at build time. Defines `technical_knowledge`, FTS5 virtual table `technical_knowledge_fts`, three sync triggers, and `technical_knowledge_embeddings`. |

### Database

Three tables (all in a single SQLite file):

1. **`technical_knowledge`** — primary store. UUIDs as PKs, `parent_id` self-reference for hierarchy, `is_validated` / `confidence_score` / `source_url` managed by Sentinel.
2. **`technical_knowledge_fts`** — FTS5 virtual table kept in sync via INSERT/UPDATE/DELETE triggers. Used as primary search index before falling back to `LIKE`.
3. **`technical_knowledge_embeddings`** — stores Gemini/OpenAI vector embeddings as JSON-serialized `TEXT`. Cosine similarity is computed in TypeScript, not in the database.

When `TURSO_DATABASE_URL` is a `libsql://` URL, the client runs as an embedded replica: reads are local (microsecond), writes are committed locally then async-synced to Turso cloud. The `isEmbeddedReplica` flag in `db.ts` gates all `client.sync()` calls.

### Search fallback chain

`recall_knowledge` and `semantic_search` both follow a degradation chain:

1. FTS5 `MATCH` on `technical_knowledge_fts`
2. SQL `LIKE` on topic/content/category
3. (semantic only) Cosine similarity on `technical_knowledge_embeddings`
4. (semantic only) Falls back to FTS5/LIKE if embedding generation fails

### LLM JSON repair

`cleanLLMJson()` in `src/llm.ts` handles two failure modes from LLMs: markdown code fences wrapping the JSON, and unescaped lone backslashes (e.g., PHP namespaces like `Illuminate\Support`). The regex `/(?<!\\)\\(?!["\\/bfnrtu])/g` uses negative lookbehind/lookahead to target only illegal backslashes without double-processing already-escaped ones.

### Category normalization

All categories are normalized through `normalizeCategory()` in `src/index.ts` before storage. Canonical values: `Backend`, `Frontend`, `DevOps`, `Project Context`, `Database`, `Testing`, `Tooling`. Aliases like `api`, `server`, `db`, `infra` are mapped automatically.

### Coherence

`src/coherence.ts` owns project identity and the context isolation invariant:
- `detectCurrentProject()` walks up from `process.cwd()` to find a manifest (package.json, composer.json, etc.), then looks up or creates a row in `projects` keyed by `root_path`. Proto-projects (NULL `root_path`) are adopted in place when their workspace is first opened.
- `canRelate(a, b)` returns true iff at least one side is generic (NULL) or both share the same project_id. Mirrored at the DB layer by the `enforce_relation_isolation` trigger.
- `discoverRelations()` materializes edges into `knowledge_relations`; `/api/graph` reads from this table directly.
- `audit_coherence` MCP tool runs three phases: structural (auto-applies safe fixes), semantic (returns suggestions to apply selectively), relation re-discovery.

`store_knowledge` writes a non-NULL `project_id` for `Project Context` snippets; everything else stays generic.

`recall_knowledge` and `semantic_search` accept a `projectScope` parameter (`"current"` default = current project ∪ generic, `"all"`, `"generic"`, or a project UUID).
