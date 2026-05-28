# Knowledge Coherence Engine — Design

**Status:** Draft for review
**Date:** 2026-05-28
**Owner:** sysqlow-mcp
**Related:** [LITERATURES.md](../../../LITERATURES.md), [CLAUDE.md](../../../CLAUDE.md)

---

## 1. Problem

Today, sysqlow-mcp stores all snippets in one flat `technical_knowledge` table. When the dashboard graph (`/api/graph`) computes edges via brute-force cosine similarity over *every* embedding regardless of source, snippets from unrelated projects link to each other. The user's report:

> "when trying to store the project knowledge in databank, it links to another project that didn't have coherence with each other"

This is a **context isolation failure** — the system has no notion of which snippets belong to which workspace, so the refinement layer (relation discovery, recall, graph viz) pollutes one project's mental model with another's.

We need to give the knowledge graph a notion of *project context* (Serafini & Homola 2012) while preserving a *shared/generic* layer that survives across projects (the part of one's knowledge that is genuinely portable: "Laravel rate limiting", "PostgreSQL EXPLAIN ANALYZE", etc.).

## 2. Goals & Non-Goals

**Goals**

1. Snippets stored as "Project Context" are scoped to exactly one project.
2. Generic technical snippets remain shared and readable across all projects.
3. Relation discovery (the link-formation layer) **never** crosses a project boundary.
4. Existing polluted data is detectable and cleanable via a guided audit tool.
5. The same backing knowledge base works across multiple machines/clones (no hard-coded absolute paths leaking into IDs).

**Non-Goals**

- Multi-user / multi-tenant access control. This remains a single-user PKG.
- Renaming or restructuring the existing `technical_knowledge` table beyond an additive column.
- Replacing Sentinel; truth-discovery / staleness handling continues unchanged.
- Cross-project relation discovery as a *future* feature flag. Out of scope here.

## 3. Theoretical Grounding (one-line summary)

The system is a **Personal Knowledge Graph** (Balog & Kenter 2019) being extended with a **Contextualized Knowledge Repository** layer (Serafini & Homola 2012; MCS, Brewka & Eiter 2007), with refinement (Paulheim 2017) bounded by an explicit *context isolation invariant*. Full citations in [LITERATURES.md](../../../LITERATURES.md).

## 4. Architecture Overview

Three additions, all backwards compatible:

```
┌─────────────────────┐         ┌──────────────────────────┐
│  projects           │◄────────│  technical_knowledge     │
│  (new table)        │  N:1    │  + project_id (nullable) │
└─────────────────────┘         └──────────────────────────┘
                                              ▲
                                              │
                                  ┌───────────┴────────────┐
                                  │  knowledge_relations    │
                                  │  (new table)            │
                                  │  + isolation trigger    │
                                  └────────────────────────┘
```

- `project_id IS NULL` ⇒ **generic / shared** snippet (readable from any project).
- `project_id IS NOT NULL` ⇒ **project-scoped** snippet (only its project's relation graph touches it).
- A DB trigger enforces the invariant *at write time*; an app-layer `canRelate()` function enforces it before we ever call the DB.

### 4.1 New table: `projects`

```sql
CREATE TABLE IF NOT EXISTS projects (
    id           TEXT PRIMARY KEY,            -- UUID
    name         TEXT NOT NULL,               -- "sysqlow-mcp", "sentec-pms", ...
    root_path    TEXT UNIQUE,                 -- absolute workspace path; NULL for proto-projects
    detected_stack TEXT,                      -- JSON: ["bun","typescript","libsql"]
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name_orphan
    ON projects(name) WHERE root_path IS NULL;
```

- **`root_path UNIQUE`**: identity by workspace, not by name. Two clones of the same repo on the same machine deliberately become distinct projects (different paths). On *different* machines they are also distinct, which is fine for a single-user PKG.
- **NULL `root_path` = proto-project**: created by the migration when we can only recover the project's name from a topic prefix, not its location. Adopted in place the next time that workspace is opened.

### 4.2 Extended column on `technical_knowledge`

```sql
ALTER TABLE technical_knowledge
    ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
```

Added via the existing `try { ALTER ... } catch(_) {}` auto-migration pattern in `src/db.ts`.

### 4.3 New table: `knowledge_relations`

```sql
CREATE TABLE IF NOT EXISTS knowledge_relations (
    id           TEXT PRIMARY KEY,
    source_id    TEXT NOT NULL REFERENCES technical_knowledge(id) ON DELETE CASCADE,
    target_id    TEXT NOT NULL REFERENCES technical_knowledge(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,              -- "semantic_neighbor" | "manual" | "derived_from"
    weight       REAL NOT NULL,               -- e.g. cosine similarity
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_relations_source ON knowledge_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON knowledge_relations(target_id);
```

Replaces the on-demand brute-force similarity in `/api/graph` with a materialized edge set. Discovery runs explicitly (during `audit_coherence` or post-store hooks), not on every dashboard render.

### 4.4 Isolation trigger

```sql
CREATE TRIGGER IF NOT EXISTS enforce_relation_isolation
BEFORE INSERT ON knowledge_relations
WHEN (
  (SELECT project_id FROM technical_knowledge WHERE id = NEW.source_id) IS NOT NULL
  AND (SELECT project_id FROM technical_knowledge WHERE id = NEW.target_id) IS NOT NULL
  AND (SELECT project_id FROM technical_knowledge WHERE id = NEW.source_id)
     != (SELECT project_id FROM technical_knowledge WHERE id = NEW.target_id)
)
BEGIN
  SELECT RAISE(ABORT, 'context_isolation_violation: cross-project relation forbidden');
END;
```

A relation is allowed iff **at least one endpoint is generic** *or* **both endpoints belong to the same project**. The trigger is the last line of defense; the app layer must not rely on it for normal flow control.

## 5. Project Identification

A new module `src/coherence.ts` exposes:

```ts
async function detectCurrentProject(): Promise<Project>
async function canRelate(srcProjectId: string | null, tgtProjectId: string | null): Promise<boolean>
```

`detectCurrentProject()`:

1. Read `process.cwd()`.
2. Walk upward until we hit a folder containing `package.json`, `composer.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, or `.git`. That folder's absolute path is the canonical `root_path`.
3. `SELECT * FROM projects WHERE root_path = ?`. If found → return it.
4. Else: read the manifest (or directory basename), pick a `name`, and:
   - If a **proto-project** (`root_path IS NULL`) with the same `name` exists, **adopt it in place**: `UPDATE projects SET root_path = ?, detected_stack = ? WHERE id = <proto.id>`.
   - Otherwise `INSERT` a new row.
5. Touch `last_active_at`.

`canRelate(a, b)`:

```ts
if (a === null) return true;           // generic source
if (b === null) return true;           // generic target
return a === b;                        // same project
```

Identical in semantics to the trigger.

## 6. Scoping Rules

| Operation | Default scope | Override |
|---|---|---|
| `store_knowledge` (category = "Project Context") | current project | explicit `project_id` arg |
| `store_knowledge` (other categories) | generic (NULL) | explicit `project_id` arg |
| `recall_knowledge` | **current project ∪ generic** | `projectScope: "all" \| "current" \| "generic" \| <project_id>` |
| `semantic_search` | current project ∪ generic | same `projectScope` |
| `discover_relations` | **current project only** (writes) | n/a (strict) |
| `/api/graph` | all projects (read-only) | filter UI dropdown |

Reads are permissive (you can still benefit from a generic snippet you stored years ago in a different workspace). Writes that *create links* are strict.

## 7. Migration Plan (auto, on startup)

Runs once in `initDatabase()` after the new `ALTER`s land:

1. **Schema:** create `projects`, add `project_id`, create `knowledge_relations`, create the isolation trigger. All wrapped in the existing try/catch auto-migration idiom.
2. **Discover proto-projects** from existing `Project Context` topic prefixes:
   ```sql
   SELECT DISTINCT TRIM(SUBSTR(topic, 1, INSTR(topic, ':') - 1)) AS name
   FROM technical_knowledge
   WHERE category = 'Project Context' AND topic LIKE '%: %' AND project_id IS NULL;
   ```
   For each, `INSERT OR IGNORE INTO projects (id, name, root_path) VALUES (uuid(), name, NULL)`.
3. **Backfill `project_id`** on those rows:
   ```sql
   UPDATE technical_knowledge SET project_id = (
     SELECT p.id FROM projects p
     WHERE p.name = TRIM(SUBSTR(technical_knowledge.topic, 1, INSTR(technical_knowledge.topic, ':') - 1))
     LIMIT 1
   )
   WHERE category = 'Project Context' AND topic LIKE '%: %' AND project_id IS NULL;
   ```
4. **Everything else stays `NULL`** (= generic). This is the conservative default; promotion is opt-in via `reassign_project()`.

No relations are touched in migration; cross-project edges are simply *no longer recomputed* once the new `/api/graph` reads from `knowledge_relations` instead of brute-forcing embeddings.

## 8. `audit_coherence` — three-phase cleanup tool

New MCP tool. Each phase is independently runnable; later phases assume earlier phases passed.

### Phase 1 — Structural (deterministic, auto-apply)

- Find `Project Context` rows that don't match the `Name: Topic` shape → report.
- Find duplicate proto-projects with case/whitespace-normalized equal names → propose merges.
- Find orphan relations (endpoints deleted) → delete.

### Phase 2 — Semantic (heuristic, user-confirmed)

Reads embeddings; produces a report of suggestions, each with a `suggestion_id`. User applies a subset via `audit_coherence --apply=id-1,id-3`.

Detectors:

- **Generic snippet that looks project-specific:** for a `project_id IS NULL` row, if its top-3 cosine neighbors all belong to the *same* project with mean similarity > 0.7 → suggest `reassign_project(snippet, that_project)`.
- **Project snippet that looks generic:** for a `project_id IS NOT NULL` row, if neighbors span ≥ 3 distinct projects → suggest `reassign_project(snippet, NULL)`.
- **Cross-project mention pollution:** `Project Context` rows whose content mentions another known project name → flag for manual review.
- **Near-duplicate across projects:** cosine > 0.92 between rows of different projects → suggest collapse (keep one, link the other as `derived_from`).

### Phase 3 — Relation re-discovery

Runs `discoverRelations()`:

```ts
for each row R in technical_knowledge:
    neighbors = topK(embedding(R), k=10, threshold=0.75)
    for N in neighbors:
        if canRelate(R.project_id, N.project_id):
            INSERT OR IGNORE INTO knowledge_relations (...)
```

Trigger enforces the invariant as a safety net. After Phase 3, `/api/graph` reads from this table directly — fast, deterministic, and pollution-free by construction.

## 9. New Operations

- **`merge_projects(keep_id, drop_id)`** — reassigns all snippets and relations from `drop_id` to `keep_id`, deletes `drop_id`. Used to collapse phantom proto-projects after audit Phase 1.
- **`reassign_project(snippet_id, new_project_id | null)`** — manual single-snippet correction. `new_project_id = null` is the canonical "promote to generic" operation.

## 10. Hooks into Existing Code

| File | Change |
|---|---|
| `schema.sql` | Append `projects`, extended column (documented; actual ALTER runs in `db.ts`), `knowledge_relations`, trigger. |
| `src/db.ts` | Append auto-migration block(s); run proto-project backfill once. |
| `src/coherence.ts` *(new)* | `detectCurrentProject`, `canRelate`, `discoverRelations`, `mergeProjects`, `reassignProject`. |
| `src/index.ts` | `store_knowledge` calls `detectCurrentProject()` for Project Context. `recall_knowledge` / `semantic_search` accept `projectScope`. Register `audit_coherence`, `merge_projects`, `reassign_project` tools. Replace `/api/graph` edge computation with `SELECT ... FROM knowledge_relations`. |
| `src/index.ts` (Sentinel cron) | Optional: schedule a `discoverRelations()` pass after each audit batch. |

`src/sentinel.ts`, `src/llm.ts`, `src/search.ts`, `src/learn.ts`, `src/dashboard-html.ts` are unchanged in this design (dashboard gains a project filter dropdown — UI-only).

## 11. Failure Modes & Edge Cases

- **Embedding missing for a snippet:** Phase 2/3 skip it; logged.
- **Two machines, same repo cloned to different paths:** they become two `projects` rows. Acceptable for single-user PKG; documented limitation. Cross-machine merging is a future tool, not this design.
- **User renames the workspace folder:** next `detectCurrentProject()` creates a new project. They can `merge_projects` to consolidate.
- **Topic-prefix migration produces a wrong project for a row:** Phase 2 detects it (semantic neighbors disagree) and proposes a fix.
- **Race between two MCP clients writing relations:** trigger is the safety net; `INSERT OR IGNORE` on the UNIQUE index handles duplicates.

## 12. Testing Strategy

- Unit: `canRelate()` truth table; `detectCurrentProject()` with mocked `cwd`, with/without manifest, with existing proto-project.
- Integration: in-memory libSQL DB; seed mixed (generic + two-project) corpus; assert no cross-project edges after `discoverRelations`; assert trigger rejects manual cross-project insert.
- Migration: snapshot of pre-migration DB → run `initDatabase` → assert proto-projects exist and `project_id` populated for `Project Context` rows.
- Manual: dashboard graph rendered before/after on a real polluted DB.

## 13. Open Questions (deferred, not blocking)

- Should `discoverRelations` run inline on every `store_knowledge`, or only on demand? *(Lean: on demand + nightly Sentinel cron.)*
- Should generic snippets be linkable to **all** project snippets, or only to project snippets that explicitly opt in? *(Lean: all — that is the whole point of "shared layer".)*
- Cross-machine project identity. Future work.

---

**Approval requested.** Once approved, the next step is to invoke the `writing-plans` skill to break this design into an ordered, TDD-shaped implementation plan.
