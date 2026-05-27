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

---

## 🛠️ Core Tool Capabilities

SysQlow-MCP exposes **11 Tools**, but you should prioritize the unified orchestrator:

### 1. Unified Orchestrator: `knowledge_workflow` (Tool 6)
Always prefer this tool over individual micro-tools. It minimizes tool-calling roundtrips and optimizes context tokens.

#### Available Intents & Usage Guidelines:
*   **`learn`**: Call this on startup or major workspace updates if the auto-scan did not run. It reads root dependencies and builds baseline context snippets under the category `"Project Context"`.
*   **`save`**: Call this whenever the user teaches you a new trick, command, or architectural rule. Ensure you normalized categories properly (e.g. `"api"` ➔ `"Backend"`, `"tailwind"` ➔ `"Frontend"`).
*   **`semantic`**: Always use this for conceptual queries (e.g. *"how do I configure local replicas?"*). It ranks snippets using local cosine vector similarity and falls back to FTS5 matches under rate limits.
*   **`validate`**: Call this to check if a stored snippet is outdated. The Sentinel engine performs a live web crawl and returns a Git-style unified diff if corrections are required.
*   **`apply`**: Call this to commit updated contents to a snippet, optionally running defensive validation before final write.
*   **`merge`**: Call this to link a child sub-topic to a parent topic (using `mode: "link_child"`) or merge child text into a parent (using `mode: "merge_content"`).
*   **`delete`**: Deletes a snippet by UUID.
*   **`list`**: Lists all snippet headers and UUIDs.

---

## ⚠️ Critical Syntax Rules

### Double-Escaping Backslashes in JSON
Because MCP parameters are JSON-RPC payloads, any backslashes (`\`) inside code contents, file paths, or language syntax **MUST be properly double-escaped as `\\`** (e.g., PHP namespaces `Illuminate\\Support\\Facades\\RateLimiter` or directory paths `src\\styles\\main.css`). 
Failure to do so will corrupt the JSON stream and trigger connection timeouts.

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

### Phase 1: Ingesting a Workspace Rule
If the user establishes a rule (e.g., *"We use hybrid BEM + Tailwind style scoped in Vue components"*):
1.  Call `knowledge_workflow` with `intent: "save"`.
2.  Topic: `"Project: Vue CSS Convention"`.
3.  Category: `"Frontend"`.
4.  Content: Document the exact code boilerplate and conventions.

### Phase 2: Contextual Recall
When asked to write a new Vue component:
1.  Call `knowledge_workflow` with `intent: "semantic"`, `query: "Vue BEM Tailwind styles"`.
2.  Retrieve the stored guideline, guaranteeing your code output matches your developer's exact workspace conventions on the first try.

### Phase 3: Sentinel Validation
When a framework updates:
1.  Call `knowledge_workflow` with `intent: "validate"`, `id: "snippet-uuid"`.
2.  Parse the returned Git-style unified diff.
3.  Call `knowledge_workflow` with `intent: "apply"`, committing the modern code standard seamlessly.
