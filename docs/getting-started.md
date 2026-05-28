# Getting Started with SysQlow-MCP

> A first-time user's guide. By the end you'll have the server running, connected to your AI assistant, with your first snippets stored and a clear mental model of what the system does.

**Reading time:** ~15 minutes · **Time to working setup:** ~10 minutes

---

## Table of Contents

1. [What you're installing](#1-what-youre-installing)
2. [Prerequisites](#2-prerequisites)
3. [5-minute quick start (zero-config local)](#3-5-minute-quick-start-zero-config-local)
4. [Configuration deep dive](#4-configuration-deep-dive)
5. [Choosing your transport mode](#5-choosing-your-transport-mode)
6. [Connecting your MCP client](#6-connecting-your-mcp-client)
7. [Your first snippet (end-to-end walkthrough)](#7-your-first-snippet-end-to-end-walkthrough)
8. [The 11 MCP tools — when to use which](#8-the-11-mcp-tools--when-to-use-which)
9. [The Coherence Engine (project scoping)](#9-the-coherence-engine-project-scoping)
10. [The dashboard (SSE mode)](#10-the-dashboard-sse-mode)
11. [Background daemons (Sentinel + Coherence)](#11-background-daemons-sentinel--coherence)
12. [Common tasks playbook](#12-common-tasks-playbook)
13. [Troubleshooting](#13-troubleshooting)
14. [What to read next](#14-what-to-read-next)

---

## 1. What you're installing

**SysQlow-MCP** is a local-first, self-validating engineering knowledge base, exposed to your AI assistant over the [Model Context Protocol](https://modelcontextprotocol.io/). Think of it as a personal knowledge graph that:

- **Stores technical snippets** (code, configs, commands, architecture notes) in SQLite — either standalone or as a [Turso](https://turso.tech) embedded replica synced to the cloud.
- **Auto-detects which project** you're in and scopes project-specific notes to that workspace (the [Coherence Engine](./coherence-usage.md)).
- **Validates snippets** against live web docs using Google Gemini (or OpenAI) + Brave Search (or DuckDuckGo) — the **Sentinel** daemon.
- **Visualizes** the knowledge graph in a browser dashboard.
- **Learns your codebase** by scanning manifests (`package.json`, `composer.json`, `go.mod`, etc.) and storing architectural summaries.

It runs as one of two transports:

- **stdio** — the MCP client (Cursor, Claude Desktop, Antigravity, Windsurf, etc.) spawns the server per session.
- **SSE / HTTP** — a long-running HTTP server with a `/sse` endpoint, a dashboard at `/`, and background daemons.

You can have both at once (different clients connecting to whichever fits).

## 2. Prerequisites

### Required

- **[Bun](https://bun.sh)** v1.2+ (the JavaScript runtime; `curl -fsSL https://bun.sh/install | bash`)
- **An MCP-aware client** — any one of: Cursor, Claude Desktop, Antigravity, Windsurf, the Claude.ai web app's MCP feature, or any custom MCP client.

### Optional (but recommended)

- **[Turso](https://turso.tech)** account — for cloud-synced cross-device snippets. Free tier is sufficient. Skip this to run purely local (a plain SQLite file).
- **[Google AI Studio](https://aistudio.google.com)** API key — unlocks the Sentinel validator, semantic search embeddings, and `import_documentation` LLM extraction.
- **[OpenAI](https://platform.openai.com)** API key — fallback if Gemini isn't set.
- **[Brave Search](https://brave.com/search/api/)** API key — better web search results for Sentinel. Optional; DuckDuckGo HTML scraper is the keyless fallback.
- **Docker** — only if you prefer containerized deployment.

### What works with what

| You have | You unlock |
|---|---|
| Just Bun | Local SQLite, store/recall via FTS5 + LIKE, no validator, no embeddings |
| + Turso URL & token | Multi-device sync via embedded replica |
| + GEMINI_API_KEY (or OPENAI_API_KEY) | Sentinel validator + semantic search + `import_documentation` LLM extraction |
| + BRAVE_API_KEY | Higher-quality web search for Sentinel (vs. DuckDuckGo HTML scraping) |

## 3. 5-minute quick start (zero-config local)

This gets you a working stdio-mode server backed by a local SQLite file, no cloud, no API keys. You'll be able to store and recall snippets but not validate or do semantic search.

```bash
# 1. Clone
git clone https://github.com/barayuda/sysqlow-mcp.git
cd sysqlow-mcp

# 2. Install dependencies
bun install

# 3. Run the server once to verify it starts and creates the DB
bun run src/index.ts < /dev/null
# Expect: "Configuring database... TURSO_DATABASE_URL environment variable is not defined.
#          Using standalone local SQLite database: file:sysqlow.db"
# Press Ctrl-C to stop. A sysqlow.db file is now in your cwd.

# 4. (Optional) Build the standalone native binary for fast cold starts
bun run compile
# → dist/sysqlow-mcp (single ~50 MB executable, no runtime needed)
```

Now point your MCP client at it (see [Section 6](#6-connecting-your-mcp-client)). When the client launches the server, you'll see migrations run and the coherence daemon kick in 30 seconds later:

```
[DB Migration] Verified projects table.
[DB Migration] Verified knowledge_relations table and isolation trigger.
[DB Migration] Backfilled proto-projects from topic prefixes.
[Coherence Daemon] (startup) Phase 1 (structural)…
[Coherence Daemon] (startup) Phase 3 (re-discovery)…
```

That's a fully functional baseline. The rest of this guide layers in capability.

## 4. Configuration deep dive

All configuration is via environment variables. Create a `.env` file in the repo root (or set them in your MCP client's `env` block):

```ini
# Turso cloud sync (omit both to run purely local)
TURSO_DATABASE_URL="libsql://your-db-name.turso.io"
TURSO_AUTH_TOKEN="eyJhbGc..."

# LLM provider — Gemini is primary, OpenAI is fallback
GEMINI_API_KEY="AIzaSy..."
OPENAI_API_KEY="sk-..."

# Web search for Sentinel validator (optional, DDG is the keyless fallback)
BRAVE_API_KEY="..."

# Override local SQLite path. Default: sysqlow.db in cwd.
LOCAL_DB_PATH="data/sysqlow.db"

# Transport. Default: stdio. Set to "sse" for HTTP/SSE + dashboard mode.
MCP_TRANSPORT="sse"
PORT="50741"
```

Full reference: see [CLAUDE.md](../CLAUDE.md#environment-variables).

### How to get each value

| Variable | How |
|---|---|
| `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` | Sign up at [turso.tech](https://turso.tech), `turso db create sysqlow`, `turso db show sysqlow --url`, `turso db tokens create sysqlow` |
| `GEMINI_API_KEY` | [aistudio.google.com](https://aistudio.google.com) → Get API key → Create |
| `OPENAI_API_KEY` | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) → Create new secret key |
| `BRAVE_API_KEY` | [api.search.brave.com](https://api.search.brave.com) → free tier 2K queries/month |

### What the LLM keys are used for

- **Gemini** (`gemini-2.5-flash`): Sentinel validation reasoning, codebase analysis, documentation extraction.
- **Gemini embeddings** (`gemini-embedding-001`): semantic search vectors. Stored as JSON in `technical_knowledge_embeddings`.
- **OpenAI fallback**: same workloads if Gemini is absent (`gpt-4o-mini`, `text-embedding-3-small`).

No LLM key → store/recall still work, just no validation/embeddings.

## 5. Choosing your transport mode

| Aspect | stdio | SSE/HTTP |
|---|---|---|
| **Best for** | Cursor, Claude Desktop, Antigravity, one IDE | Always-on server, multiple clients, dashboard access |
| **Lifecycle** | Spawned per MCP-client session | Long-lived daemon |
| **Dashboard** | ❌ | ✅ at `http://localhost:50741/` |
| **REST endpoints** | ❌ | `/api/graph`, `/api/logs`, `/api/env`, `/api/validate/:id` |
| **Sentinel cron** | ❌ (session too short) | ✅ every 12 h |
| **Coherence startup audit** | ✅ once per session (30 s in) | ✅ once on boot + every 12 h |
| **Workspace cwd detection** | Automatic (`process.cwd()` from client spawn) | Set `SYSQLOW_WORKSPACE_DIR` per-launch, or run from project dir |
| **Concurrent clients** | 1 | Many |
| **Startup cost** | ~5–20 s (Turso sync) | One-time |

**Most users want stdio** for IDE integration, and a separate SSE instance for the dashboard. The two replicas sync through Turso, so both see the same data.

### Launch commands

```bash
# Stdio (typically launched by your MCP client, not by you directly)
bun run src/index.ts

# SSE mode + dashboard
MCP_TRANSPORT=sse PORT=50741 bun start

# Native binary (stdio, fastest cold start, no Bun needed on the host)
bun run compile
./dist/sysqlow-mcp

# Docker (SSE, mounts $HOME for cross-workspace path parity)
./run-docker.sh --sse
```

## 6. Connecting your MCP client

The MCP standard lets clients spawn a server (stdio) or connect to one (SSE). Pick the section that matches your client.

### 6a. Cursor

Open your Cursor settings file (`Cmd+Shift+P → "Cursor Settings"` → MCP), and add:

```json
{
  "mcpServers": {
    "sysqlow-mcp": {
      "command": "bun",
      "args": ["run", "/absolute/path/to/sysqlow-mcp/src/index.ts"],
      "env": {
        "TURSO_DATABASE_URL": "libsql://your-db.turso.io",
        "TURSO_AUTH_TOKEN": "eyJhbGc...",
        "GEMINI_API_KEY": "AIzaSy..."
      }
    }
  }
}
```

Restart Cursor. The MCP indicator should show `sysqlow-mcp` connected. In the chat panel, type *"What MCP tools do I have?"* — you should see all 14 tools listed (including the new `audit_coherence`, `merge_projects`, `reassign_project`).

### 6b. Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) — same JSON shape as Cursor above. Restart the Claude Desktop app.

### 6c. Antigravity IDE (SSE via mcp-remote)

Antigravity uses a separate process to bridge to SSE servers:

```json
{
  "mcpServers": {
    "sysqlow-mcp": {
      "$typeName": "exa.cascade_plugins_pb.CascadePluginCommandTemplate",
      "command": "npx",
      "args": ["mcp-remote", "http://localhost:50741/sse"],
      "env": {
        "TURSO_DATABASE_URL": "libsql://your-db.turso.io",
        "TURSO_AUTH_TOKEN": "eyJhbGc...",
        "GEMINI_API_KEY": "AIzaSy..."
      }
    }
  }
}
```

Make sure the SSE server is running (`./run-docker.sh --sse` or `MCP_TRANSPORT=sse bun start`) before Antigravity tries to connect.

### 6d. Windsurf, VSCode MCP extension, others

Most stdio-spawning clients accept the same shape as Cursor. Refer to your client's MCP docs.

### 6e. Verifying the connection

In your client's chat, ask:

> *"Use sysqlow-mcp to list all knowledge snippets."*

If the agent calls `recall_knowledge` and returns even an empty list, you're connected.

## 7. Your first snippet (end-to-end walkthrough)

Try this five-step flow in your AI chat. It exercises store → recall → semantic search → validate → commit.

### Step 1 — Save

> *"Save this technical snippet under category Backend. Topic: 'Laravel 11 Rate Limiting'. Content: In Laravel 11, define limiters inside bootstrap/app.php using RateLimiter::for(...)."*

The agent calls `store_knowledge`. You get back a UUID.

### Step 2 — Recall by keyword

> *"Find my notes about rate limit."*

The agent calls `recall_knowledge`. FTS5 returns the snippet you just saved.

### Step 3 — Semantic search

> *"Search semantically for throttling and request quotas."*

The agent calls `semantic_search`. If `GEMINI_API_KEY` is set, this uses cosine similarity over embeddings; otherwise it falls back to FTS5. Your rate-limiting snippet should still surface.

### Step 4 — Validate against live docs

> *"Audit that rate limiting snippet against current Laravel docs."*

The agent calls `validate_knowledge` with the UUID. Sentinel searches the web, asks the LLM to compare your snippet to live docs, and returns a structured report with a `status` (`valid` / `needs_update` / `incorrect`), a `confidence_score`, a `source_url`, a `reasoning`, and a `suggested_diff`. **Nothing is auto-written.**

### Step 5 — Commit the suggested fix

> *"That report looks right — apply the suggested fix."*

The agent calls `commit_update`. By default it re-runs validation, then writes the new content, marks the snippet validated, and bumps `last_validated_at`.

If you watch the dashboard during this, the node's color shifts from amber (pending) to emerald (validated).

## 8. The 11 MCP tools — when to use which

| Tool | Trigger phrases | What it does |
|---|---|---|
| `learn_codebase` | "analyze this workspace", "learn the project stack" | Scans your project root for manifests, asks LLM to summarize, stores as `Project Context` snippets |
| `store_knowledge` | "save this snippet", "remember that…" | Writes a row to `technical_knowledge`; auto-sets `project_id` for `Project Context` |
| `recall_knowledge` | "find notes about…", "list all snippets" | FTS5 keyword search with LIKE fallback; scoped to current project ∪ generic |
| `semantic_search` | "search semantically for…", "concept search" | Cosine similarity over embeddings, with FTS5/LIKE fallback |
| `validate_knowledge` | "audit snippet X", "validate against docs" | Sentinel reads the snippet, searches the web, returns LLM-reasoned report (read-only) |
| `commit_update` | "apply that update", "commit the diff" | Persists an approved update + re-validates by default |
| `knowledge_workflow` | high-level intent prompts | Router for save/search/validate/apply/delete/merge/semantic/import |
| `import_documentation` | "scrape and save these docs" | Fetches a URL, LLM-extracts as Markdown, stores |
| `audit_coherence` *(new)* | "audit the databank", "run coherence checks" | Three-phase audit: structural / semantic / relation re-discovery |
| `merge_projects` *(new)* | "merge project A into B" | Reassigns all snippets, deletes drop project |
| `reassign_project` *(new)* | "move snippet X to project Y", "promote to generic" | Single-snippet correction with auto edge pruning |

### Pattern: knowledge_workflow as the easy entry point

If you don't remember tool names, just say what you want to do:

> *"Save under Backend: Vue 3 reactivity caveat about destructuring refs."*

The agent recognizes the intent and calls `knowledge_workflow(intent="save", ...)` — which routes internally to `store_knowledge`.

## 9. The Coherence Engine (project scoping)

This is the big new capability. Read the full guide at **[docs/coherence-usage.md](./coherence-usage.md)**, but here's the elevator pitch:

- Every `Project Context` snippet is auto-tagged with the project you stored it from.
- Other categories stay generic — shared across all your projects.
- Recall defaults to *current project ∪ generic*, so you don't see other projects' clutter.
- The dashboard graph never shows cross-project edges (enforced by a SQLite trigger).
- The server self-audits on every startup, with deeper on-demand inspection via `audit_coherence`.

**Practical implication**: stop prefixing your topics with project names ("MarkBoard: ..."). Just write naturally. The server figures it out from your workspace.

## 10. The dashboard (SSE mode)

Start the server in SSE mode and open `http://localhost:50741/` in your browser. You get:

- **Knowledge graph** powered by Vis.js — drag nodes, zoom, recenter.
- **Project filter dropdown** — show only one workspace's subgraph plus generic nodes.
- **Category filter checkboxes** — toggle Backend / Frontend / etc.
- **Theme switcher** — light / dark / system.
- **Click any node** → side panel with content, validation status, suggested diffs, manual "Trigger Sentinel Audit" button.
- **Real-time log terminal** at the bottom — see `[Sentinel Daemon]` and `[Coherence Daemon]` activity live.
- **Environment viewer** — confirms which env vars the server sees (secrets masked).

Node colors:

- **Emerald** = validated
- **Amber** = pending / outdated / never validated
- **Blue** = `Project Context` (auto-generated by `learn_codebase`)

Edges:

- **Solid directed arrows** = semantic neighbors from `knowledge_relations` (gated by isolation invariant)
- **Dashed lines** = `parent_id` hierarchy links

## 11. Background daemons (Sentinel + Coherence)

Two daemons run in the background. Both log to stderr (visible in the dashboard's terminal panel or your MCP client's log file).

### Sentinel — knowledge freshness

- **When**: SSE mode only. Boot + every 12 hours.
- **What**: Picks 3 oldest unvalidated-or-stale snippets, runs `validate_knowledge` on each. Sleeps 3 seconds between LLM calls to avoid rate limits.
- **Output**: `[Sentinel Daemon] Auditing snippet: "…"` lines.

### Coherence — graph integrity

- **When**: Both stdio and SSE. 30 s after server start (every session in stdio, once at SSE boot). SSE also piggybacks on the 12 h Sentinel cycle.
- **What**: Runs Phase 1 (auto-fix structural issues) + Phase 3 (re-materialize `knowledge_relations` edges, gated by the isolation invariant). Skips Phase 2 (semantic suggestions need your judgment).
- **Output**: `[Coherence Daemon] (startup) Phase 1 done: …` / `Phase 3 done: inserted=N, skipped_by_invariant=N`.

The `skipped_by_invariant` counter is your forensic signal that the engine is actively rejecting cross-project pollution. If it stays at 0, either you only have one project or something has bypassed the invariant.

## 12. Common tasks playbook

### "Learn this project"

Once per workspace (or whenever the stack changes):

> *"Use learn_codebase on this project."*

The agent invokes `learn_codebase()`. The server scans your manifests, the LLM summarizes architecture/conventions/dependencies, and 3–7 `Project Context` snippets land in your databank — all scoped to the current project.

### "Save a technical pattern"

Daily use:

> *"Save under Database: PostgreSQL EXPLAIN ANALYZE flag — use `(FORMAT JSON, BUFFERS)` for detailed execution insight."*

`store_knowledge` writes a row with `category = "Database"` and `project_id = NULL` (generic).

### "Pull external documentation in"

When official docs are worth caching:

> *"Import documentation from https://nextjs.org/docs/app/api-reference/file-conventions/route — store under Frontend."*

`import_documentation` fetches, LLM-extracts to clean Markdown, stores.

### "Inspect & clean the databank"

Weekly or after a `learn_codebase` batch:

> *"Run audit_coherence with phase=all."*

See Phase 1's auto-applied fixes, Phase 2's suggestion list (you decide what to apply), Phase 3's new edge count.

To apply selective Phase 2 suggestions:

> *"Apply suggestions s1 and s3 from run abc-123."*

The agent re-calls `audit_coherence` with `suggestion_run_id` and `apply_suggestions`.

### "Move a snippet to the right project"

> *"Reassign snippet `<uuid>` to project `<project-uuid>`."*

Or:

> *"Promote snippet `<uuid>` to generic."* (= `new_project_id = null`)

### "Merge two duplicate projects"

> *"Merge project drop_id `<uuid-B>` into keep_id `<uuid-A>`."*

`merge_projects` moves all snippets, deletes the empty project row.

### "Run an offline audit (no MCP server)"

```bash
bun audit
```

Same three phases, printed to stdout, no FastMCP roundtrip. Useful for CI hooks or pre-deployment checks.

## 13. Troubleshooting

### The server won't start

**Symptom**: `bun run src/index.ts` exits immediately or errors.

| Cause | Fix |
|---|---|
| Bun version too old | `bun upgrade` (need 1.2+) |
| `.env` malformed | Ensure no trailing whitespace, quotes only around values with spaces |
| Turso URL/token mismatch | `turso db tokens create <db>` again, confirm URL with `turso db show <db> --url` |
| Port 50741 already in use (SSE mode) | `lsof -i :50741`, kill the squatter, or set a different `PORT` |

### MCP client says "no tools"

| Cause | Fix |
|---|---|
| Wrong absolute path in `args` | Cursor/Claude Desktop need the *absolute* path to `src/index.ts` (or the compiled binary) |
| Env vars not propagated | Put them in the client's `env` block, not just in `.env` — clients spawn the server without inheriting your shell environment |
| Stdout pollution | Don't `console.log` anything in custom code; FastMCP uses stdout for JSON-RPC. Use `console.error` |

### "Cannot find module '@libsql/client'"

```bash
bun install
```

### Validation always says "needs_update"

| Cause | Fix |
|---|---|
| No `GEMINI_API_KEY` / `OPENAI_API_KEY` | Set one; validator can't reason without an LLM |
| Rate limit hit | Wait 1 minute (Gemini free tier: ~15 RPM) |
| Brave API exhausted | DDG fallback kicks in automatically; results may be lower quality |

### Project Context snippets all land in one phantom project

You're running under Docker without `SYSQLOW_WORKSPACE_DIR` being captured. Confirm `run-docker.sh` is the launcher used by your MCP client — it sets the env var before exec. Fix existing rows with `reassign_project` or `merge_projects` after the engine is wired correctly.

### The Coherence Daemon doesn't log

It fires 30 seconds after `initDatabase()` completes. If your client kills the server too fast (e.g., a smoke test), you won't see it. Run the server interactively for 60+ seconds to confirm.

### `audit_coherence` returns `"phase2": { "suggestions": [] }`

You don't have enough cross-project semantic signal yet, or your embeddings table is empty. Check:

```bash
sqlite3 sysqlow.db "SELECT COUNT(*) FROM technical_knowledge_embeddings;"
```

If 0, you need an LLM key — embeddings only get written when one is configured.

## 14. What to read next

| Doc | Why |
|---|---|
| **[docs/coherence-usage.md](./coherence-usage.md)** | Deep dive on the project scoping engine, with troubleshooting & the AI-agent cheat sheet |
| **[docs/superpowers/specs/2026-05-28-knowledge-coherence-engine-design.md](./superpowers/specs/2026-05-28-knowledge-coherence-engine-design.md)** | Architecture spec — read this if you're extending the engine |
| **[CLAUDE.md](../CLAUDE.md)** | Quick operator reference: commands, env vars, module map, key implementation patterns |
| **[LITERATURES.md](../LITERATURES.md)** | The academic foundation — PKGs, MCS, PROV-O, Zettelkasten, Memex — for the design-curious |
| **[README.md](../README.md)** | Feature reference + IDE setup snippets (Cursor/Antigravity/Claude Desktop) |

---

## Appendix A: A complete `.env` for a power user

```ini
# Local + cloud database
TURSO_DATABASE_URL="libsql://sysqlow-mcp-yourname.aws-ap-northeast-1.turso.io"
TURSO_AUTH_TOKEN="eyJhbGciOiJFZERTQSI..."
LOCAL_DB_PATH="data/sysqlow.db"

# LLM
GEMINI_API_KEY="AIzaSy..."
# OpenAI as fallback; either alone is enough
# OPENAI_API_KEY="sk-..."

# Web search (Brave is higher quality; DDG fallback is keyless)
BRAVE_API_KEY="BSA..."

# Transport — uncomment to switch to SSE+dashboard mode
# MCP_TRANSPORT="sse"
# PORT="50741"
```

## Appendix B: A minimal `.env` for "just let me try it"

```ini
# No env vars at all — local SQLite, no validation, no embeddings.
# (You can store and recall snippets via FTS5 from day one.)
```

## Appendix C: Stack of commands you'll actually use

```bash
bun install                                # Install dependencies
bun dev                                    # Watch mode (stdio)
MCP_TRANSPORT=sse PORT=50741 bun start     # SSE mode + dashboard
bun run typecheck                          # Type-check
bun run test:workflow                      # Integration test (spawns server, exercises tools)
bun test src/coherence.test.ts             # Unit tests for the coherence engine
bun audit                                  # Offline coherence audit (no server)
bun run build                              # Bundle (external deps unbundled)
bun run compile                            # Standalone native binary at dist/sysqlow-mcp
./run-docker.sh --sse                      # Docker SSE mode
```

---

**Welcome aboard.** Most users land at full productivity within an hour: Section 3 to get it running, Section 6 to wire your MCP client, Section 7 to verify the loop works, Section 9 to understand the project scoping. Sections 11–13 you'll return to as your databank grows.
