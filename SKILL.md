---
name: sysqlow-mcp-agent-manual
description: |
  Comprehensive instructional manual for AI coding agents (such as Cursor, Claude Desktop, Copilot, etc.) to query, store, validate, and orchestrate technical snippets inside the SysQlow-MCP server.
---

# SysQlow-MCP: AI Agent Interaction & Retrieval Manual

This document provides AI coding assistants with precise instructions on how to leverage **SysQlow-MCP** to maintain a persistent, validated, and highly contextual second brain.

---

## 💡 Operational Philosophy

As an AI agent, your primary objective is to keep your developer's workspace documented and synchronized with modern standards. SysQlow-MCP enables this by exposing high-level tools to analyze codebases, search concepts semantically, import external documentation, audit codeblocks, and build parent-child topic hierarchies.

SysQlow exposes **two complementary call patterns** for cognitive work — choose the one that matches your context:

| Pattern | LLM consumed | When to use |
|---|---|---|
| **Server-side LLM** (`learn_codebase`, `validate_knowledge`, `import_documentation`) | sysqlow's Gemini daily quota | You're a non-LLM caller (CI, script, headless agent) and need sysqlow to do the analysis. Or sysqlow is keyed and has spare quota. |
| **Client-side LLM** (`collect_codebase_files` + `knowledge_workflow`/`store_knowledge`) | YOUR model's tokens (zero sysqlow quota) | You are an LLM agent (Claude Code, Cursor, Claude Desktop). Prefer this when sysqlow's Gemini is exhausted, when the OpenRouter fallback isn't configured, or simply when you want all cognitive work on your own model. |

**Heuristic:** if you are reading this manual right now, you are an LLM. Default to the client-side pattern for `learn`-shaped operations.

---

## 🛠️ Core Tool Capabilities

SysQlow-MCP exposes **17 Tools**. You should usually call the unified orchestrator instead of the micro-tools, but two no-LLM data-provider tools are listed separately because they invert the work direction (server hands raw data to you, you do the synthesis).

### 1. Unified Orchestrator: `knowledge_workflow`
Always prefer this tool over individual micro-tools for *normal* read/write flows. It minimizes tool-calling roundtrips and optimizes context tokens.

#### Available Intents & Usage Guidelines:
*   **`learn`**: Server-side analysis. Calls sysqlow's Gemini to synthesize Project Context snippets. **If Gemini quota is exhausted, switch to `collect_codebase_files` instead** (see below).
*   **`save`**: Call this whenever the user teaches you a new trick, command, or architectural rule. Ensure you normalized categories properly (e.g. `"api"` ➔ `"Backend"`, `"tailwind"` ➔ `"Frontend"`).
*   **`semantic`**: Always use this for conceptual queries (e.g. *"how do I configure local replicas?"*). It ranks snippets using local cosine vector similarity and falls back to FTS5 matches under rate limits.
*   **`validate`**: Server-side validation. Sentinel performs a live web crawl (Tavily → SearXNG → DDG) and returns a Git-style unified diff. When evidence is zero (every search tier returns empty), the snippet is marked `unverifiable` instead of getting a false-positive verdict.
*   **`apply`**: Call this to commit updated contents to a snippet, optionally running defensive validation before final write.
*   **`merge`**: Call this to link a child sub-topic to a parent topic (using `mode: "link_child"`) or merge child text into a parent (using `mode: "merge_content"`).
*   **`delete`**: Deletes a snippet by UUID.
*   **`list`**: Lists all snippet headers and UUIDs.

### 2. No-LLM Data Provider: `collect_codebase_files`
**Use this when you are an LLM agent and want to learn a codebase without burning sysqlow's Gemini quota.** Pattern:

1. Call `collect_codebase_files { projectPath: "/path/to/repo" }`.
2. The tool returns the raw text of `package.json`, `composer.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `requirements.txt`, `README.md`, `.env.example`, `tsconfig.json` — whichever exist, each capped at 6KB.
3. **You** analyze the contents using your own model.
4. For each finding, call `knowledge_workflow { intent: "save", topic, content, category }` (preferred) or `store_knowledge { ... }` directly.

This mirrors the output of `learn_codebase` but shifts the synthesis from sysqlow's Gemini onto your model. Zero server quota consumed.

### 3. Triage: `list_outdated_knowledge`
Surfaces snippets the Sentinel daemon has flagged as `outdated`, `incorrect`, or `unverifiable` along with the LLM's reasoning + suggested diff. Returns `{ count, items: [{ id, topic, reasoning, suggested_diff, source_url, confidence_score, last_validated_at }] }`. Use this to triage the validation backlog without re-running the LLM.

### 4. Coherence: `audit_coherence`
Three-phase project-identity sweep: (1) structural — auto-applies safe fixes, (2) semantic — returns suggestions for selective application, (3) relation re-discovery. Call after large ingestion batches or when the dashboard graph looks tangled.

---

## ⚠️ Critical Syntax Rules

### Double-Escaping Backslashes in JSON
Because MCP parameters are JSON-RPC payloads, any backslashes (`\`) inside code contents, file paths, or language syntax **MUST be properly double-escaped as `\\`** (e.g., PHP namespaces `Illuminate\\Support\\Facades\\RateLimiter` or directory paths `src\\styles\\main.css`).
Failure to do so will corrupt the JSON stream and trigger connection timeouts.

### When the Server Reports Gemini Quota Exhausted
If a tool call fails with `Gemini quota exhausted for model gemini-2.5-flash`:

1. **Check for OpenRouter fallback.** If sysqlow has `OPENROUTER_API_KEY` configured, daily-quota exhaustion auto-routes through OpenRouter (per ADR-0002). Retry the call; the fallback is transparent.
2. **Switch to client-side analysis.** For `learn_codebase` workflows, use `collect_codebase_files` instead — your own model does the synthesis, sysqlow's quota stays untouched.
3. **Defer to next reset.** The `set_llm_budget` tool can be used to inspect or temporarily adjust caps, but the upstream Gemini account quota resets at next Pacific midnight regardless of local config.

---

## 📊 Dashboard Visual Standards

When saving snippets, map them to standard **Canonical Categories** to preserve beautiful visual clustering on the Vis.js 2D graph (`http://localhost:50741/`):

| Canonical Category | Matching Topics | Visual Color Theme |
| :--- | :--- | :--- |
| **`Backend`** | API routes, routing, controllers, frameworks (Laravel, Next.js, Express) | Emerald Green |
| **`Frontend`** | UI components, Tailwind CSS, Vue, React, styling guides | Emerald Green |
| **`Database`** | SQLite, Turso, schema migrations, models, seeding | Emerald Green |
| **`DevOps`** | Docker, fly.io, deployments, Nginx, cron jobs | Emerald Green |
| **`Testing`** | Vitest, E2E tests, Bun test, mocking assertions | Emerald Green |
| **`Tooling`** | Bun scripts, compilers, Webpack, TS configuration | Emerald Green |
| **`Project Context`** | Codebase dependency stacks, architectural conventions | Glowing Blue (Clustered) |

---

## 🔄 Ingestion & Retrieval Walkthrough

### Phase 1A: Ingesting a Workspace Rule (manual)
If the user establishes a rule (e.g., *"We use hybrid BEM + Tailwind style scoped in Vue components"*):
1.  Call `knowledge_workflow` with `intent: "save"`.
2.  Topic: `"Project: Vue CSS Convention"`.
3.  Category: `"Frontend"`.
4.  Content: Document the exact code boilerplate and conventions.

### Phase 1B: Bootstrapping a New Codebase (client-side, recommended)
When opening an unknown workspace and you (the LLM client) want to bootstrap Project Context snippets without consuming sysqlow's Gemini quota:

1.  Call `collect_codebase_files { projectPath: "<repo-root>" }`.
2.  The tool returns raw contents of all manifest/README files found at the root.
3.  Read them yourself. Synthesize **3–7 focused snippets** covering: framework stack, build tooling, key conventions, architectural choices.
4.  For each finding, call `knowledge_workflow { intent: "save", topic: "<ProjectName>: <aspect>", content: "...", category: "Project Context" }`.
5.  Use canonical categories. Prefer `Project Context` for codebase-wide conventions; use `Backend`/`Frontend`/`Database`/etc. for stack-specific patterns.

This is the preferred shape when sysqlow's Gemini is exhausted, or any time you'd rather keep the synthesis cost on your own model.

### Phase 1C: Bootstrapping a New Codebase (server-side fallback)
When you're a non-LLM caller, or sysqlow has spare quota and you want to minimize your own tokens:

1.  Call `knowledge_workflow { intent: "learn", projectPath: "<repo-root>" }`.
2.  Sysqlow reads the manifest files internally, calls Gemini to synthesize snippets, and persists them with `category: "Project Context"`.
3.  On Gemini quota exhaustion: if `OPENROUTER_API_KEY` is configured the call routes through OpenRouter transparently; otherwise the call fails and you should fall back to Phase 1B.

### Phase 2: Contextual Recall
When asked to write a new Vue component:
1.  Call `knowledge_workflow` with `intent: "semantic"`, `query: "Vue BEM Tailwind styles"`.
2.  Retrieve the stored guideline, guaranteeing your code output matches your developer's exact workspace conventions on the first try.

### Phase 3: Sentinel Validation
When a framework updates:
1.  Call `knowledge_workflow` with `intent: "validate"`, `id: "snippet-uuid"`.
2.  Parse the returned Git-style unified diff.
3.  Call `knowledge_workflow` with `intent: "apply"`, committing the modern code standard seamlessly.

### Phase 4: Backlog Triage
Periodically (or when prompted by the user):
1.  Call `list_outdated_knowledge { limit: 20 }`.
2.  For each item, the LLM reasoning and suggested diff are pre-attached — no second validation call needed.
3.  Decide per-item: apply the suggested diff (via `commit_update` or `knowledge_workflow { intent: "apply" }`), edit manually, or `delete_knowledge` if the snippet is obsolete.

---

## 🧭 Architecture References

- **Gemini-only LLM** for primary path: [`docs/adr/0001-gemini-only-remove-openai-fallback.md`](docs/adr/0001-gemini-only-remove-openai-fallback.md)
- **Resilience fallbacks** (OpenRouter + multi-tier search): [`docs/adr/0002-resilience-fallbacks.md`](docs/adr/0002-resilience-fallbacks.md)
- **Running without Docker** (per-request filesystem access): [`docs/running-natively.md`](docs/running-natively.md)
- **Coherence usage guide** (project identity, isolation invariant): [`docs/coherence-usage.md`](docs/coherence-usage.md)
