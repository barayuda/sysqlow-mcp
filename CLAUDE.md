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

# Offline coherence audit (no MCP server needed) — prints structural / semantic / re-discovery report
bun audit
```

## Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `TURSO_DATABASE_URL` | Optional | `libsql://...` URL enables Turso embedded replica sync. Omit for local-only SQLite. |
| `TURSO_AUTH_TOKEN` | If Turso URL set | Auth token for Turso cloud |
| `SYSQLOW_DB_REMOTE_ONLY` | Optional | Set to `1` to connect directly to Turso with no local SQLite file. Required for ephemeral-disk hosts (Render free, Fly machines without volumes). Fails loud at boot if `TURSO_DATABASE_URL` (libsql/https) or `TURSO_AUTH_TOKEN` is missing. Tradeoff: every read is a network round-trip — see [`docs/deploying-to-render.md`](docs/deploying-to-render.md). |
| `GEMINI_API_KEY` | Required for LLM features | Powers Sentinel validation, embeddings (model: `gemini-2.5-flash` / `gemini-embedding-001`). The only supported LLM provider (Gemini-only, per ADR-0001). |
| `OPENROUTER_API_KEY` | Optional | Enables chat-completion fallback when Gemini's daily quota is exhausted. See [ADR-0002](docs/adr/0002-resilience-fallbacks.md). |
| `OPENROUTER_FALLBACK_MODEL` | Optional | Override the default OpenRouter model (default: `google/gemma-4-31b-it:free`). |
| `SYSQLOW_FALLBACK_ENABLED` | Optional | Default `true` when `OPENROUTER_API_KEY` is set. Set `false` to disable the fallback even when keyed. |
| `TAVILY_API_KEY` | Optional | Web search for Sentinel via [Tavily](https://tavily.com) (free tier: 1,000 searches/month, no card). Falls back to DuckDuckGo HTML scraper if absent — note the DDG scraper is often blocked from Docker/data-center egress IPs. |
| `SEARXNG_URL` | Optional | Self-hosted SearXNG instance URL (tier-3 search fallback). No quota, no key — most durable choice for Docker deployments. |
| `SYSQLOW_DDG_FALLBACK` | Optional | Default `true`. Set to `false` to disable the last-resort DDG-HTML scraper — recommended for hosts whose egress IP is blocked by DDG. |
| `LOCAL_DB_PATH` | Optional | Override SQLite file path (default: `sysqlow.db` in cwd). Ignored when `SYSQLOW_DB_REMOTE_ONLY=1`. |
| `MCP_TRANSPORT` | Optional | Set to `sse` for HTTP/SSE + dashboard mode; otherwise stdio |
| `PORT` | Optional | HTTP port for SSE mode (default: `50741`) |
| `SYSQLOW_WORKSPACE_ROOTS` | Optional (Docker only) | Comma-separated list of extra host paths to bind-mount into the container (e.g. `~/Projects,~/work`). The default mount scope is the sysqlow-mcp checkout plus `$PWD` only — no `$HOME` exposure. Use this when you need the coherence engine to see workspaces outside those two paths. `~` is expanded, nested paths collapse to the shortest ancestor, non-existent entries are skipped with a warning. |

> LLM budget caps (flash/embedding daily limits, daemon reserve, catch-up size) are stored in the `llm_budget_config` table and tuned at runtime via the `set_llm_budget` MCP tool — not via environment variables.

## Architecture

### Transport modes

The server has two distinct runtime personalities, controlled by `MCP_TRANSPORT`:

- **stdio** (default): pure JSON-RPC pipe, one client, no HTTP. Used by Claude Desktop, Cursor, etc.
- **httpStream / SSE**: HTTP server on port `50741` exposing `/sse` for MCP clients, a web dashboard at `/`, and REST endpoints (`/api/graph`, `/api/validate/:id`, `/api/logs`, `/api/env`). Also activates the background Sentinel audit daemon (every 12 h).

### Module map

| File | Role |
|---|---|
| `src/index.ts` | Entry point. Defines all 17 FastMCP tools, Hono HTTP routes (`/api/graph`, `/api/validate/:id`, `/api/logs`, `/api/env`, `/api/budget`, `/api/outdated`), auto-hook on client `connect`, background Sentinel cron, and the console log ring buffer for the dashboard. |
| `src/db.ts` | Turso/libSQL client factory. Selects embedded-replica vs local-only mode based on `TURSO_DATABASE_URL`. Runs schema DDL and auto-migrations on startup (parent_id, project_id, embeddings table, projects, knowledge_relations + isolation trigger, llm_quota_log, `last_validation_reasoning` + `last_suggested_diff` columns). |
| `src/sentinel.ts` | `validateKnowledgeItem(id)` — fetches snippet, runs web search, calls LLM, writes validation metadata back to DB. Persists LLM reasoning + suggested diff on outdated/incorrect verdicts; clears them on `up_to_date` recovery so `list_outdated_knowledge` always reflects the latest state. |
| `src/llm.ts` | All LLM calls: `validateContentWithLLM`, `analyzeCodebaseWithLLM`, `extractDocumentationWithLLM`, `generateEmbedding`. Gemini-primary (ADR-0001); chat-completion calls are wrapped in `routeWithFallback` so `QuotaExhaustedError` routes to OpenRouter when configured (ADR-0002). Throws if GEMINI_API_KEY is unset. Includes `cleanLLMJson()` regex repair for stray backslashes in LLM JSON output. |
| `src/llm-providers.ts` | `LLMProvider` interface + `OpenRouterProvider` + `routeWithFallback()` — engages OpenRouter when Gemini throws `QuotaExhaustedError`, no-op otherwise. |
| `src/search.ts` | `webSearch()` (Tavily → DuckDuckGo HTML scraper fallback; configurable via `TAVILY_API_KEY`) and `cosineSimilarity()` (in-process vector math). |
| `src/learn.ts` | `learnCodebase(path)` — scans project root for config/manifest files, collects content, calls `analyzeCodebaseWithLLM`, stores results as "Project Context" snippets. |
| `src/dashboard-html.ts` | Single large string export: the full HTML/JS for the Vis.js knowledge graph dashboard. |
| `schema.sql` | SQLite DDL imported via `with { type: "text" }` at build time. Defines `technical_knowledge` (with `last_validation_reasoning` + `last_suggested_diff` columns for daemon-marked outdated triage), FTS5 virtual table `technical_knowledge_fts`, three sync triggers, `technical_knowledge_embeddings`, `projects`, and `knowledge_relations` (with `enforce_relation_isolation` trigger). |

### Database

Three tables (all in a single SQLite file):

1. **`technical_knowledge`** — primary store. UUIDs as PKs, `parent_id` self-reference for hierarchy, `is_validated` / `confidence_score` / `source_url` managed by Sentinel.
2. **`technical_knowledge_fts`** — FTS5 virtual table kept in sync via INSERT/UPDATE/DELETE triggers. Used as primary search index before falling back to `LIKE`.
3. **`technical_knowledge_embeddings`** — stores Gemini vector embeddings as JSON-serialized `TEXT`. Cosine similarity is computed in TypeScript, not in the database.

When `TURSO_DATABASE_URL` is a `libsql://` URL, the client runs as an embedded replica: reads are local (microsecond), writes are committed locally then async-synced to Turso cloud. The `isEmbeddedReplica` flag in `db.ts` gates all `client.sync()` calls.

### Search fallback chain

`recall_knowledge` and `semantic_search` both follow a degradation chain:

1. FTS5 `MATCH` on `technical_knowledge_fts`
2. SQL `LIKE` on topic/content/category
3. (semantic only) Cosine similarity on `technical_knowledge_embeddings`
4. (semantic only) Falls back to FTS5/LIKE if embedding generation fails

### Sentinel triage

Every `validateKnowledgeItem` call persists the LLM's `reasoning` and `suggested_diff` to the `last_validation_reasoning` and `last_suggested_diff` columns. On `up_to_date` verdicts both are NULLed (so a recovered row doesn't carry stale advice forever). Daemon-driven and interactive validations are symmetric in this — the LLM's cognitive output never silently dies in a log line again.

Surface the backlog via:
- **MCP:** `list_outdated_knowledge { limit?, projectId? }` → `{ count, items: [{ id, topic, reasoning, suggested_diff, source_url, confidence_score, last_validated_at }] }`
- **HTTP (SSE mode):** `GET /api/outdated?limit=20&project_id=<uuid>` → same shape

A snippet with `is_validated=0 AND last_validated_at IS NOT NULL` was *checked and rejected* by the validator; `is_validated=0 AND last_validated_at IS NULL` is "never checked yet" (different state, different action).

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

**Auto-schedule:** `runBackgroundCoherence("startup")` fires once 30 s after server start in both transports (stdio and SSE) — runs phase 1 + phase 3. In SSE mode it also piggybacks on the existing 12 h Sentinel cron. Phase 2 stays manual (judgment calls). Under Docker, `run-docker.sh` captures the host's invocation `$PWD` and passes it as `SYSQLOW_WORKSPACE_DIR` so `detectCurrentProject()` resolves to the user's workspace rather than `/app`.

**End-user usage guide:** [`docs/coherence-usage.md`](docs/coherence-usage.md) covers the daily-use workflows, the four MCP tools, the offline `bun audit` script, and a troubleshooting table.
