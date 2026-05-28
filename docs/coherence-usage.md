# Using the Coherence Engine

> **Audience:** end users of sysqlow-mcp who want to store, recall, and curate engineering knowledge cleanly across multiple projects.
>
> **Companion docs:**
> - [Design spec](superpowers/specs/2026-05-28-knowledge-coherence-engine-design.md) — architecture & invariants
> - [LITERATURES.md](../LITERATURES.md) — academic grounding
> - [CLAUDE.md](../CLAUDE.md) — operator/developer reference

---

## What changed (one paragraph)

sysqlow-mcp now knows which **project** each `Project Context` snippet belongs to. When you store such a snippet, the server detects your current workspace from the spawn directory (or the `SYSQLOW_WORKSPACE_DIR` env var inside Docker) and tags the row with that project's id. Reads default to *current project ∪ generic*, so your `markboard` snippets never leak into a `sentec-pms` recall, but a generic snippet like "Laravel rate limiting" still surfaces in both. The graph view, semantic search, and a built-in `audit_coherence` MCP tool all respect this boundary, enforced at two layers (app code + DB trigger).

---

## TL;DR — what to do, when

| Situation | Action |
|---|---|
| **Store a project-specific note** | Use `store_knowledge` with `category: "Project Context"` from inside your project workspace. project_id is auto-assigned. |
| **Store a generic technical note** | Any other category (`Backend`, `Frontend`, `Database`, `Testing`, `Tooling`, `DevOps`). Stays cross-project. |
| **Recall** | Default — gets current project + generic. Pass `projectScope: "all"` if you want everything. |
| **Inspect health periodically** | Server self-audits on every startup (30s in). You don't have to do anything. |
| **See semantic suggestions** | Ask: *"Run audit_coherence with phase=2"* — review the report, apply selectively. |
| **Move a single snippet** | Use `reassign_project` MCP tool. |
| **Two projects are actually the same** | Use `merge_projects` MCP tool. |
| **Offline inspection** | `bun audit` in the repo. |

---

## 1. The mental model

Think of your databank as **stratified subgraphs**:

- **Generic layer** (`project_id IS NULL`) — knowledge that is genuinely portable across projects. "Postgres EXPLAIN ANALYZE", "Laravel rate limiting", "Vue reactivity caveats". Shared by all projects.
- **Project layers** (`project_id = <uuid>`) — knowledge tied to a specific workspace. "MarkBoard PWA Integration", "Archipelago Blog: Slug Helpers", "Sentec PMS pricing model".

**The rule:** a snippet can link to its own project's snippets *and* to generic snippets, but never across projects. This is the *context isolation invariant*, named after Serafini & Homola's 2012 work on contextualized knowledge repositories (full citation in LITERATURES.md).

You don't enforce it manually. The server does — `canRelate()` in `src/coherence.ts` and `enforce_relation_isolation` trigger in the DB both reject cross-project edges by construction.

## 2. Setup once: tell the server which workspace it's in

In stdio mode (Cursor, Claude Desktop, Antigravity, etc.), the MCP client launches the server from the directory you're editing — `process.cwd()` is already correct. Nothing to configure.

In Docker (via `run-docker.sh`), the script captures `$PWD` before `cd`-ing into the project dir and passes it through as `SYSQLOW_WORKSPACE_DIR`. Still nothing to configure; just launch from your workspace.

To verify the handshake worked, after storing a Project Context snippet:

```bash
sqlite3 data/sysqlow.db \
  "SELECT p.name, p.root_path, tk.topic
   FROM technical_knowledge tk
   LEFT JOIN projects p ON p.id = tk.project_id
   WHERE tk.category='Project Context'
   ORDER BY tk.created_at DESC LIMIT 1;"
```

`p.name` should be your workspace's name, `p.root_path` your workspace's absolute path. If `root_path` is empty (`NULL`), that project is still a "proto-project" — open the workspace once with the new server running and it adopts in place automatically.

## 3. Daily workflow

### Writing

Just store. The auto-resolver does the work:

```
# in your MCP-enabled agent (e.g., Cursor chat)
"Store this in Project Context: <content>"
```

`store_knowledge` calls `detectCurrentProject()`, looks up or adopts the project row, and stamps `project_id` on the new snippet. Old "`MarkBoard: Topic`" prefix convention is no longer required — feel free to write topics naturally.

Other categories (`Backend`, `Frontend`, `Database`, `Testing`, `Tooling`, `DevOps`) stay generic. They're meant to be portable.

### Reading

`recall_knowledge` and `semantic_search` accept `projectScope`:

| `projectScope` | Result |
|---|---|
| omitted, or `"current"` (default) | current project ∪ generic |
| `"all"` | every snippet across every project |
| `"generic"` | only generic snippets |
| `"<project-uuid>"` | that specific project ∪ generic |

99% of the time you want the default. If you're explicitly cross-pollinating ideas (e.g., "show me everything related to slug helpers across all my projects"), use `"all"`.

### Visualization

```bash
MCP_TRANSPORT=sse PORT=50741 bun run src/index.ts
# open http://localhost:50741/
```

The dashboard has a **Project** dropdown in the toolbar. Pick a specific project to see only that workspace's subgraph plus generic nodes. Edges shown are from the materialized `knowledge_relations` table — there are no cross-project edges to filter out.

## 4. Periodic maintenance

The server schedules itself. You don't have to remember anything.

**Every server start (~30s in, both stdio and SSE modes):**
- Phase 1 (structural) — auto-applies safe fixes (orphan edges, duplicate proto-projects).
- Phase 3 (re-discovery) — rebuilds edges in `knowledge_relations`, gated by the isolation invariant.

**Every 12 hours in SSE mode:**
- Same pass, piggybacked on the existing Sentinel cron.

You'll see this in your client's MCP log:

```
[Coherence Daemon] (startup) Phase 1 done: unprefixed=N, merged_proto_dupes=N, orphan_relations=N
[Coherence Daemon] (startup) Phase 3 done: inserted=N, skipped_by_invariant=N
```

`skipped_by_invariant > 0` is **proof** the engine is rejecting cross-project pollution. If you see `skipped=0` indefinitely, either you only have one project, or something has bypassed the invariant — both worth a closer look.

## 5. On-demand: `audit_coherence` (the MCP tool)

When you want a deeper, judgment-required inspection — usually after a `learn_codebase` run, or weekly hygiene — ask your agent:

> Run `audit_coherence` with `phase="all"`.

You'll get back JSON with three sections:

### Phase 1 — structural

```json
"phase1": {
  "unprefixedProjectContext": [ /* rows that need manual reassignment */ ],
  "duplicateProtoProjects": [ /* already merged */ ],
  "orphanRelations": 0
}
```

`unprefixedProjectContext` lists legacy `Project Context` rows that don't follow the old `"Name: Topic"` shape and therefore weren't auto-bucketed. You decide where they go (see Section 6).

### Phase 2 — semantic suggestions

```json
"phase2": {
  "run_id": "abc-123-…",
  "suggestions": [
    { "id": "s1", "kind": "reassign_to_project", "snippet_id": "…", "detail": "Generic snippet \"X\" looks project-specific (mean sim 0.80)." },
    { "id": "s2", "kind": "promote_to_generic", "snippet_id": "…", "detail": "Project snippet \"Y\" has neighbors across 3 projects — likely generic." },
    { "id": "s3", "kind": "near_duplicate", "snippet_id": "…", "partnerSnippetId": "…", "detail": "Near-duplicate across projects." },
    { "id": "s4", "kind": "mention_pollution", "snippet_id": "…", "detail": "Snippet in project A mentions project B by name." }
  ]
}
```

| Kind | Auto-applicable? | When to apply |
|---|---|---|
| `reassign_to_project` | yes | The snippet's semantic neighbors all live in one project. Usually correct. |
| `promote_to_generic` | yes | The snippet's neighbors span multiple projects. Suggests it's cross-cutting. |
| `near_duplicate` | no (manual) | Same content exists in two projects. You decide whether to delete one, merge, or keep both. |
| `mention_pollution` | no (manual) | A Project A snippet mentions Project B by name. Could be a real cross-reference (fine) or a misfiled note (move). |

To apply selected suggestions:

> Run `audit_coherence` again with `suggestion_run_id="abc-123-…"` and `apply_suggestions=["s1", "s2"]`.

Only `reassign_to_project` and `promote_to_generic` actually mutate; the other kinds come back in `failed` so you handle them manually.

### Phase 3 — re-discovery

```json
"phase3": { "inserted": 36, "skipped": 68 }
```

`inserted` = new edges materialized. `skipped` = candidate edges blocked by the invariant. Both should grow as your databank grows.

## 6. Manual corrections

### Move one snippet

> Use `reassign_project` with `snippet_id="<id>"` and `new_project_id="<project-uuid>"`.

To promote a snippet to generic instead:

> Use `reassign_project` with `snippet_id="<id>"` and `new_project_id=null`.

The engine auto-prunes any edges the move would have made invariant-violating.

### Merge two projects

If `audit_coherence` shows two project rows that are actually the same workspace (e.g., you cloned the repo to two paths and stored snippets from both):

> Use `merge_projects` with `keep_id="<uuid-A>"` and `drop_id="<uuid-B>"`.

All snippets and references move to A; B's row is deleted.

### Bulk fix from the CLI

For one-off operations that don't have a clean MCP shape, the repo ships an offline auditor:

```bash
bun audit
```

Runs Phase 1 + Phase 2 + Phase 3 against the live DB, prints a human-readable report, doesn't need the FastMCP server up. Read-mostly except for Phase 1 auto-applies and Phase 3 edge inserts.

For ad-hoc reassignments, drop into a one-liner:

```bash
bun -e '
import { initDatabase } from "./src/db";
import { reassignProject } from "./src/coherence";
await initDatabase();
await reassignProject("<snippet-id>", "<project-id-or-null>");
process.exit(0);
'
```

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| New Project Context snippet has `project_id = NULL` | Server ran from a directory with no `package.json`/`composer.json`/etc. up the chain | Open the workspace from its root; or set `SYSQLOW_WORKSPACE_DIR` in your MCP client's env block |
| Snippet stored from MarkBoard shows up in sysqlow-mcp recall | The snippet was *generic* (not Project Context); generic snippets surface everywhere by design | If it's actually project-specific, run `reassign_project(snippet_id, markboard_id)` |
| Two project rows for the same repo | Different `root_path`s (e.g., symlinked clone) | `merge_projects` |
| Many snippets clumped into one "phantom" project named `app` or `sysqlow-mcp` | Docker workspace handshake failed; everything resolved to `/app` | Confirm `SYSQLOW_WORKSPACE_DIR` is set by `run-docker.sh`; then `merge_projects` or `reassign_project` to fix the historical rows |
| `[Coherence Daemon] skipped_by_invariant: 0` after months of use | Either you only have one project, or no embeddings exist on cross-project snippets to score | Check `SELECT COUNT(*) FROM projects;` and ensure `technical_knowledge_embeddings` is populated |

## 8. What the invariant guarantees, in plain English

1. **You cannot accidentally link two unrelated projects' snippets.** Two layers — `canRelate()` in app code, `enforce_relation_isolation` trigger in SQLite — would have to both fail for it to happen. The trigger is the last line of defense.
2. **You can always reach generic knowledge from any project.** Cross-project pollution is forbidden, but project-to-generic and generic-to-project edges are encouraged.
3. **Moving a snippet between projects automatically severs links the move would invalidate.** `reassignProject()` runs a pruning pass after every update.
4. **The graph in the dashboard reflects reality.** Edges are materialized into `knowledge_relations` (gated by the invariant) — what you see is what's stored, no on-the-fly recomputation.

## 9. What still needs your judgment

The engine does **not** make these calls automatically:

- Whether a snippet that *looks* cross-cutting (e.g., "blog category slug helpers") is genuinely generic or a project-specific implementation note. Phase 2 surfaces suggestions; you decide.
- Whether two near-duplicate snippets in different projects should be collapsed, kept, or one promoted to generic.
- Whether a Project Context snippet that mentions another project by name is a legitimate cross-reference or a misfiled note.

These are deliberately left to you because they're judgment calls that depend on intent. A daemon that "decided" them would generate noise.

---

## TL;DR for AI agents calling sysqlow-mcp

If you are an AI agent (Claude, GPT, Gemini, etc.) reading this through an MCP client:

1. **Storing**: just call `store_knowledge`. Don't try to manually set `project_id`. Don't prefix the topic with the project name — the auto-resolver handles bucketing.
2. **Reading**: default `projectScope` is *current ∪ generic*, which is what you want 99% of the time. Set `projectScope: "all"` only when explicitly cross-pollinating projects.
3. **If asked to audit**: call `audit_coherence` with `phase="all"`. Surface the human-readable summary; do NOT auto-apply Phase 2 suggestions without user confirmation. Phase 1 auto-applies are safe.
4. **If asked to move snippets**: use `reassign_project` (single) or `merge_projects` (two whole projects). Never modify `technical_knowledge.project_id` directly via raw SQL — the trigger's edge-pruning side effect won't fire.
