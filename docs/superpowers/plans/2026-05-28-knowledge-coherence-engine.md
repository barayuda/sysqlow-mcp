# Knowledge Coherence Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give sysqlow-mcp a notion of *project context* so that knowledge stored against one workspace can no longer pollute another's relation graph, while keeping generic technical snippets shareable.

**Architecture:** Add a `projects` table and a nullable `project_id` column on `technical_knowledge`. Replace the dashboard's brute-force similarity edges with a materialized `knowledge_relations` table whose writes are gated by a `canRelate()` invariant (enforced both in app code and by a SQLite trigger). Add an `audit_coherence` MCP tool with three phases (structural, semantic, re-discovery) to clean existing polluted data.

**Tech Stack:** Bun + TypeScript, libSQL/Turso (SQLite), FastMCP v4, FTS5, `bun:test` for unit tests, existing `src/test-workflow.ts` for integration.

**Spec:** [`docs/superpowers/specs/2026-05-28-knowledge-coherence-engine-design.md`](../specs/2026-05-28-knowledge-coherence-engine-design.md)

---

## File Structure

| Path | Status | Responsibility |
|---|---|---|
| `schema.sql` | modify | DDL of record. Append `projects`, `knowledge_relations`, isolation trigger. |
| `src/db.ts` | modify | Auto-migration. Append three try/catch ALTER/CREATE blocks + one proto-project backfill block. |
| `src/coherence.ts` | **new** | `canRelate`, `detectCurrentProject`, `discoverRelations`, `mergeProjects`, `reassignProject`. |
| `src/index.ts` | modify | Wire `store_knowledge` / `recall_knowledge` / `semantic_search` to projects; register `audit_coherence`, `merge_projects`, `reassign_project` tools; replace `/api/graph` edge query. |
| `src/dashboard-html.ts` | modify | Add project filter dropdown (UI only). |
| `src/coherence.test.ts` | **new** | Unit tests for `canRelate` and `detectCurrentProject`. |
| `src/test-workflow.ts` | modify | Append integration assertions (no cross-project edges after `discoverRelations`; trigger rejects manual cross-project insert). |

---

## Task 1: Schema DDL — `projects` table

**Files:**
- Modify: `schema.sql` (append at end)

- [ ] **Step 1: Append the `projects` table DDL**

Add to the bottom of `schema.sql`:

```sql
-- Projects table: identifies a workspace whose Project Context snippets cohere together.
-- root_path is NULL for "proto-projects" created by topic-prefix migration; they get
-- adopted in place the first time their workspace is opened.
CREATE TABLE IF NOT EXISTS projects (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    root_path      TEXT UNIQUE,
    detected_stack TEXT,
    created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Allows at most one orphan (proto) project per name; once adopted, the partial index no longer applies.
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name_orphan
    ON projects(name) WHERE root_path IS NULL;
```

- [ ] **Step 2: Commit**

```bash
git add schema.sql
git commit -m "feat(schema): add projects table with proto-project support"
```

---

## Task 2: Schema DDL — `project_id` on `technical_knowledge`

**Files:**
- Modify: `schema.sql`

- [ ] **Step 1: Document the `project_id` column in the base table**

In `schema.sql`, add a comment block right after the existing `technical_knowledge` table definition (after line 13) noting that `project_id` is added by auto-migration in `db.ts` and cannot be inlined here because the base CREATE uses `IF NOT EXISTS` and won't re-run on existing DBs:

```sql
-- NOTE: column `project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`
-- is added by auto-migration in src/db.ts so it lands on pre-existing databases too.
-- New databases pick it up via the same migration on first init.
```

- [ ] **Step 2: Commit**

```bash
git add schema.sql
git commit -m "docs(schema): note project_id auto-migration on technical_knowledge"
```

---

## Task 3: Schema DDL — `knowledge_relations` table + isolation trigger

**Files:**
- Modify: `schema.sql`

- [ ] **Step 1: Append `knowledge_relations` and the trigger**

Add at the bottom of `schema.sql`:

```sql
-- Materialized edges between snippets. Replaces on-demand brute-force similarity in /api/graph.
CREATE TABLE IF NOT EXISTS knowledge_relations (
    id            TEXT PRIMARY KEY,
    source_id     TEXT NOT NULL REFERENCES technical_knowledge(id) ON DELETE CASCADE,
    target_id     TEXT NOT NULL REFERENCES technical_knowledge(id) ON DELETE CASCADE,
    relation_type TEXT NOT NULL,
    weight        REAL NOT NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(source_id, target_id, relation_type)
);
CREATE INDEX IF NOT EXISTS idx_relations_source ON knowledge_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_relations_target ON knowledge_relations(target_id);

-- Context isolation invariant: a relation may exist only when at least one endpoint is
-- generic (project_id IS NULL) OR both endpoints belong to the same project.
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

- [ ] **Step 2: Commit**

```bash
git add schema.sql
git commit -m "feat(schema): add knowledge_relations table and isolation trigger"
```

---

## Task 4: Auto-migration — create `projects` and `project_id` on existing DBs

**Files:**
- Modify: `src/db.ts` (inside `initDatabase`, after the existing `technical_knowledge_embeddings` migration block around line 148)

- [ ] **Step 1: Append the projects-table migration block**

After the existing embeddings migration (after line 148, before the `if (isEmbeddedReplica)` sync block), add:

```ts
// Auto-migration: create projects table on existing databases
try {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS projects (
      id             TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      root_path      TEXT UNIQUE,
      detected_stack TEXT,
      created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_active_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await client.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name_orphan
      ON projects(name) WHERE root_path IS NULL
  `);
  console.error("[DB Migration] Verified projects table.");
} catch (err: any) {
  console.error(`[DB Migration Warn] Failed to create projects table: ${err.message}`);
}

// Auto-migration: add project_id column to technical_knowledge if missing
try {
  await client.execute(
    "ALTER TABLE technical_knowledge ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL"
  );
  console.error("[DB Migration] Added project_id column to technical_knowledge.");
} catch (_) {
  // Column already exists, ignore.
}
```

- [ ] **Step 2: Run typecheck**

```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 3: Start the server once to verify migration runs cleanly**

```bash
bun run src/index.ts < /dev/null 2>&1 | head -30
```
Expected: log lines including `[DB Migration] Verified projects table.` and either `Added project_id column` (fresh DB) or no error from the ALTER (existing DB).

- [ ] **Step 4: Commit**

```bash
git add src/db.ts
git commit -m "feat(db): auto-migrate projects table and project_id column"
```

---

## Task 5: Auto-migration — `knowledge_relations` + isolation trigger

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Append the relations migration block**

Right after the block added in Task 4:

```ts
// Auto-migration: create knowledge_relations + isolation trigger on existing databases
try {
  await client.execute(`
    CREATE TABLE IF NOT EXISTS knowledge_relations (
      id            TEXT PRIMARY KEY,
      source_id     TEXT NOT NULL REFERENCES technical_knowledge(id) ON DELETE CASCADE,
      target_id     TEXT NOT NULL REFERENCES technical_knowledge(id) ON DELETE CASCADE,
      relation_type TEXT NOT NULL,
      weight        REAL NOT NULL,
      created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(source_id, target_id, relation_type)
    )
  `);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_relations_source ON knowledge_relations(source_id)`);
  await client.execute(`CREATE INDEX IF NOT EXISTS idx_relations_target ON knowledge_relations(target_id)`);
  await client.execute(`
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
    END
  `);
  console.error("[DB Migration] Verified knowledge_relations table and isolation trigger.");
} catch (err: any) {
  console.error(`[DB Migration Warn] Failed to create relations table: ${err.message}`);
}
```

- [ ] **Step 2: Restart server and check logs**

```bash
bun run src/index.ts < /dev/null 2>&1 | head -40
```
Expected: `[DB Migration] Verified knowledge_relations table and isolation trigger.`

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "feat(db): auto-migrate knowledge_relations table and isolation trigger"
```

---

## Task 6: `coherence.ts` — `canRelate` (with tests)

**Files:**
- Create: `src/coherence.ts`
- Create: `src/coherence.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/coherence.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { canRelate } from "./coherence";

describe("canRelate", () => {
  test("two nulls (both generic) → true", () => {
    expect(canRelate(null, null)).toBe(true);
  });
  test("source null, target project → true (generic→project allowed)", () => {
    expect(canRelate(null, "proj-a")).toBe(true);
  });
  test("source project, target null → true (project→generic allowed)", () => {
    expect(canRelate("proj-a", null)).toBe(true);
  });
  test("same project on both sides → true", () => {
    expect(canRelate("proj-a", "proj-a")).toBe(true);
  });
  test("different projects → false (the invariant)", () => {
    expect(canRelate("proj-a", "proj-b")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
bun test src/coherence.test.ts
```
Expected: FAIL with `Cannot find module './coherence'`.

- [ ] **Step 3: Implement `canRelate`**

Create `src/coherence.ts`:

```ts
/**
 * Context Isolation Invariant:
 * A relation between two snippets is allowed iff at least one endpoint is
 * generic (project_id === null) OR both endpoints share the same project_id.
 *
 * Mirrored at the DB layer by the `enforce_relation_isolation` trigger.
 */
export function canRelate(
  sourceProjectId: string | null,
  targetProjectId: string | null,
): boolean {
  if (sourceProjectId === null) return true;
  if (targetProjectId === null) return true;
  return sourceProjectId === targetProjectId;
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
bun test src/coherence.test.ts
```
Expected: 5 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/coherence.ts src/coherence.test.ts
git commit -m "feat(coherence): add canRelate invariant with unit tests"
```

---

## Task 7: `coherence.ts` — `detectCurrentProject` (with tests)

**Files:**
- Modify: `src/coherence.ts`
- Modify: `src/coherence.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/coherence.test.ts`:

```ts
import { beforeEach, afterEach } from "bun:test";
import { detectCurrentProject, _setCwdForTests, _resetCwdForTests } from "./coherence";
import { client, initDatabase } from "./db";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("detectCurrentProject", () => {
  let tmpDir: string;

  beforeEach(async () => {
    process.env.LOCAL_DB_PATH = ":memory:";
    await initDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sysqlow-test-"));
  });

  afterEach(() => {
    _resetCwdForTests();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates a new project row when called in a fresh workspace with package.json", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "fresh-app" }));
    _setCwdForTests(tmpDir);

    const project = await detectCurrentProject();

    expect(project.name).toBe("fresh-app");
    expect(project.root_path).toBe(tmpDir);

    const rows = await client.execute({
      sql: "SELECT COUNT(*) as n FROM projects WHERE root_path = ?",
      args: [tmpDir],
    });
    expect(Number(rows.rows[0].n)).toBe(1);
  });

  test("returns existing project row on second call (idempotent)", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "stable-app" }));
    _setCwdForTests(tmpDir);

    const first = await detectCurrentProject();
    const second = await detectCurrentProject();

    expect(second.id).toBe(first.id);
  });

  test("adopts a proto-project (NULL root_path) with the same name", async () => {
    const protoId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO projects (id, name, root_path) VALUES (?, ?, NULL)",
      args: [protoId, "legacy-app"],
    });
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "legacy-app" }));
    _setCwdForTests(tmpDir);

    const adopted = await detectCurrentProject();

    expect(adopted.id).toBe(protoId);
    expect(adopted.root_path).toBe(tmpDir);
  });

  test("walks up to find the manifest root (cwd inside a subdirectory)", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "nested-app" }));
    const sub = path.join(tmpDir, "src", "deep");
    fs.mkdirSync(sub, { recursive: true });
    _setCwdForTests(sub);

    const project = await detectCurrentProject();

    expect(project.root_path).toBe(tmpDir);
    expect(project.name).toBe("nested-app");
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
bun test src/coherence.test.ts
```
Expected: FAIL — `detectCurrentProject` not exported.

- [ ] **Step 3: Implement `detectCurrentProject`**

Append to `src/coherence.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { client } from "./db";

export type Project = {
  id: string;
  name: string;
  root_path: string | null;
  detected_stack: string | null;
};

const MANIFEST_FILES = [
  "package.json",
  "composer.json",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  ".git",
];

let cwdOverride: string | null = null;
export function _setCwdForTests(p: string) { cwdOverride = p; }
export function _resetCwdForTests() { cwdOverride = null; }

function getCwd(): string {
  return cwdOverride ?? process.cwd();
}

function findProjectRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  // Stop at filesystem root.
  while (true) {
    for (const marker of MANIFEST_FILES) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir); // fallback: original cwd
    dir = parent;
  }
}

function readProjectName(rootPath: string): string {
  const pkgPath = path.join(rootPath, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (typeof pkg.name === "string" && pkg.name.length > 0) return pkg.name;
    } catch { /* fall through to basename */ }
  }
  return path.basename(rootPath);
}

function detectStack(rootPath: string): string {
  const stack: string[] = [];
  if (fs.existsSync(path.join(rootPath, "package.json"))) stack.push("node");
  if (fs.existsSync(path.join(rootPath, "bun.lockb")) || fs.existsSync(path.join(rootPath, "bun.lock"))) stack.push("bun");
  if (fs.existsSync(path.join(rootPath, "tsconfig.json"))) stack.push("typescript");
  if (fs.existsSync(path.join(rootPath, "composer.json"))) stack.push("php");
  if (fs.existsSync(path.join(rootPath, "go.mod"))) stack.push("go");
  if (fs.existsSync(path.join(rootPath, "pyproject.toml"))) stack.push("python");
  if (fs.existsSync(path.join(rootPath, "Cargo.toml"))) stack.push("rust");
  return JSON.stringify(stack);
}

export async function detectCurrentProject(): Promise<Project> {
  const rootPath = findProjectRoot(getCwd());
  const name = readProjectName(rootPath);
  const stack = detectStack(rootPath);

  // 1. Look up by canonical root_path.
  const existing = await client.execute({
    sql: "SELECT id, name, root_path, detected_stack FROM projects WHERE root_path = ?",
    args: [rootPath],
  });
  if (existing.rows.length > 0) {
    const r = existing.rows[0];
    await client.execute({
      sql: "UPDATE projects SET last_active_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [String(r.id)],
    });
    return {
      id: String(r.id),
      name: String(r.name),
      root_path: r.root_path === null ? null : String(r.root_path),
      detected_stack: r.detected_stack === null ? null : String(r.detected_stack),
    };
  }

  // 2. Adopt a proto-project (NULL root_path) with the same name, if any.
  const proto = await client.execute({
    sql: "SELECT id FROM projects WHERE name = ? AND root_path IS NULL LIMIT 1",
    args: [name],
  });
  if (proto.rows.length > 0) {
    const id = String(proto.rows[0].id);
    await client.execute({
      sql: "UPDATE projects SET root_path = ?, detected_stack = ?, last_active_at = CURRENT_TIMESTAMP WHERE id = ?",
      args: [rootPath, stack, id],
    });
    return { id, name, root_path: rootPath, detected_stack: stack };
  }

  // 3. Insert a new project.
  const id = crypto.randomUUID();
  await client.execute({
    sql: "INSERT INTO projects (id, name, root_path, detected_stack) VALUES (?, ?, ?, ?)",
    args: [id, name, rootPath, stack],
  });
  return { id, name, root_path: rootPath, detected_stack: stack };
}
```

- [ ] **Step 4: Run tests, verify they pass**

```bash
bun test src/coherence.test.ts
```
Expected: 9 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/coherence.ts src/coherence.test.ts
git commit -m "feat(coherence): add detectCurrentProject with proto-project adoption"
```

---

## Task 8: Proto-project backfill from existing topic prefixes

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Append the backfill block to `initDatabase`**

After the relations-migration block from Task 5, before the final `if (isEmbeddedReplica)` push-to-cloud sync block:

```ts
// One-time backfill: turn legacy "Project Context" rows into proto-projects so that
// existing data starts cohering before any new write happens.
try {
  const prefixRows = await client.execute(`
    SELECT DISTINCT TRIM(SUBSTR(topic, 1, INSTR(topic, ':') - 1)) AS name
    FROM technical_knowledge
    WHERE category = 'Project Context' AND topic LIKE '%: %' AND project_id IS NULL
  `);
  for (const row of prefixRows.rows) {
    const name = String(row.name).trim();
    if (!name) continue;
    await client.execute({
      sql: `INSERT OR IGNORE INTO projects (id, name, root_path) VALUES (?, ?, NULL)`,
      args: [crypto.randomUUID(), name],
    });
  }
  await client.execute(`
    UPDATE technical_knowledge SET project_id = (
      SELECT p.id FROM projects p
      WHERE p.name = TRIM(SUBSTR(technical_knowledge.topic, 1, INSTR(technical_knowledge.topic, ':') - 1))
      LIMIT 1
    )
    WHERE category = 'Project Context' AND topic LIKE '%: %' AND project_id IS NULL
  `);
  console.error("[DB Migration] Backfilled proto-projects from topic prefixes.");
} catch (err: any) {
  console.error(`[DB Migration Warn] Proto-project backfill failed: ${err.message}`);
}
```

- [ ] **Step 2: Run the server and verify the log line + a sample row**

```bash
bun run src/index.ts < /dev/null 2>&1 | head -50
```
Expected: log includes `Backfilled proto-projects from topic prefixes.`

In a separate terminal:
```bash
sqlite3 sysqlow.db "SELECT name, root_path FROM projects LIMIT 5;"
sqlite3 sysqlow.db "SELECT topic, project_id FROM technical_knowledge WHERE category = 'Project Context' LIMIT 5;"
```
Expected: proto-projects listed; matching `project_id` populated on Project Context rows.

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "feat(db): backfill proto-projects from existing topic prefixes"
```

---

## Task 9: `discoverRelations` (with tests)

**Files:**
- Modify: `src/coherence.ts`
- Modify: `src/coherence.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/coherence.test.ts`:

```ts
import { discoverRelations } from "./coherence";

describe("discoverRelations", () => {
  beforeEach(async () => {
    process.env.LOCAL_DB_PATH = ":memory:";
    await initDatabase();
  });

  test("creates only within-project and generic↔project edges (no cross-project)", async () => {
    const projA = crypto.randomUUID();
    const projB = crypto.randomUUID();
    await client.execute({ sql: "INSERT INTO projects (id, name, root_path) VALUES (?, 'A', '/a')", args: [projA] });
    await client.execute({ sql: "INSERT INTO projects (id, name, root_path) VALUES (?, 'B', '/b')", args: [projB] });

    // Two snippets per project + one generic, all with identical embeddings → high similarity.
    const emb = JSON.stringify(Array(8).fill(1));
    const seed = async (id: string, project_id: string | null) => {
      await client.execute({
        sql: "INSERT INTO technical_knowledge (id, topic, content, project_id) VALUES (?, ?, ?, ?)",
        args: [id, `t-${id}`, `c-${id}`, project_id],
      });
      await client.execute({
        sql: "INSERT INTO technical_knowledge_embeddings (id, embedding) VALUES (?, ?)",
        args: [id, emb],
      });
    };
    const a1 = "a1", a2 = "a2", b1 = "b1", b2 = "b2", g = "g";
    await seed(a1, projA); await seed(a2, projA);
    await seed(b1, projB); await seed(b2, projB);
    await seed(g, null);

    await discoverRelations();

    const edges = await client.execute("SELECT source_id, target_id FROM knowledge_relations");
    const pairs = edges.rows.map(r => `${r.source_id}->${r.target_id}`);

    // No cross-project edge.
    expect(pairs.some(p => p.includes("a1->b1") || p.includes("a1->b2") || p.includes("a2->b1") || p.includes("a2->b2"))).toBe(false);
    expect(pairs.some(p => p.includes("b1->a1") || p.includes("b1->a2") || p.includes("b2->a1") || p.includes("b2->a2"))).toBe(false);
    // Within-project edges and generic edges exist.
    expect(pairs.some(p => p === "a1->a2" || p === "a2->a1")).toBe(true);
    expect(pairs.some(p => p.startsWith("g->") || p.endsWith("->g"))).toBe(true);
  });

  test("the DB trigger rejects a direct cross-project insert", async () => {
    const projA = crypto.randomUUID();
    const projB = crypto.randomUUID();
    await client.execute({ sql: "INSERT INTO projects (id, name, root_path) VALUES (?, 'A', '/a')", args: [projA] });
    await client.execute({ sql: "INSERT INTO projects (id, name, root_path) VALUES (?, 'B', '/b')", args: [projB] });
    await client.execute({ sql: "INSERT INTO technical_knowledge (id, topic, content, project_id) VALUES ('x', 'x', 'x', ?)", args: [projA] });
    await client.execute({ sql: "INSERT INTO technical_knowledge (id, topic, content, project_id) VALUES ('y', 'y', 'y', ?)", args: [projB] });

    let threw = false;
    try {
      await client.execute({
        sql: "INSERT INTO knowledge_relations (id, source_id, target_id, relation_type, weight) VALUES (?, 'x', 'y', 'manual', 1.0)",
        args: [crypto.randomUUID()],
      });
    } catch (err: any) {
      threw = true;
      expect(err.message).toContain("context_isolation_violation");
    }
    expect(threw).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
bun test src/coherence.test.ts
```
Expected: FAIL — `discoverRelations` not exported.

- [ ] **Step 3: Implement `discoverRelations`**

Append to `src/coherence.ts`:

```ts
import { cosineSimilarity } from "./search";

const DISCOVERY_THRESHOLD = 0.75;
const DISCOVERY_TOPK = 10;

export async function discoverRelations(opts?: { projectId?: string | null }): Promise<{ inserted: number; skipped: number }> {
  // Load all snippets with embeddings and project_id.
  const rows = await client.execute(`
    SELECT tk.id AS id, tk.project_id AS project_id, e.embedding AS embedding
    FROM technical_knowledge tk
    JOIN technical_knowledge_embeddings e ON e.id = tk.id
  `);

  const records: { id: string; project_id: string | null; vec: number[] }[] = [];
  for (const r of rows.rows) {
    try {
      const vec = JSON.parse(String(r.embedding)) as number[];
      records.push({
        id: String(r.id),
        project_id: r.project_id === null ? null : String(r.project_id),
        vec,
      });
    } catch { /* skip malformed embedding */ }
  }

  let inserted = 0;
  let skipped = 0;

  for (const src of records) {
    // Optional scope: only emit edges originating from a given project (or generic).
    if (opts?.projectId !== undefined && opts.projectId !== null && src.project_id !== opts.projectId) continue;

    // Compute similarity to all other records, keep top K above threshold.
    const scored: { tgt: typeof src; score: number }[] = [];
    for (const tgt of records) {
      if (tgt.id === src.id) continue;
      if (!canRelate(src.project_id, tgt.project_id)) { skipped++; continue; }
      const score = cosineSimilarity(src.vec, tgt.vec);
      if (score >= DISCOVERY_THRESHOLD) scored.push({ tgt, score });
    }
    scored.sort((a, b) => b.score - a.score);

    for (const { tgt, score } of scored.slice(0, DISCOVERY_TOPK)) {
      try {
        await client.execute({
          sql: `INSERT OR IGNORE INTO knowledge_relations (id, source_id, target_id, relation_type, weight)
                VALUES (?, ?, ?, 'semantic_neighbor', ?)`,
          args: [crypto.randomUUID(), src.id, tgt.id, score],
        });
        inserted++;
      } catch (err: any) {
        if (String(err.message).includes("context_isolation_violation")) {
          skipped++;
        } else {
          throw err;
        }
      }
    }
  }

  return { inserted, skipped };
}
```

- [ ] **Step 4: Run tests, verify all pass**

```bash
bun test src/coherence.test.ts
```
Expected: 11 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/coherence.ts src/coherence.test.ts
git commit -m "feat(coherence): add discoverRelations gated by canRelate + trigger"
```

---

## Task 10: Hook `store_knowledge` to assign `project_id`

**Files:**
- Modify: `src/index.ts` (the `store_knowledge` tool definition)

- [ ] **Step 1: Locate the `store_knowledge` tool and read its current INSERT**

Run:
```bash
grep -n "store_knowledge\|INSERT INTO technical_knowledge" src/index.ts | head -20
```
Note the lines for the INSERT statement inside the tool's `execute`.

- [ ] **Step 2: Modify the insert path to attach `project_id`**

At the top of `src/index.ts`, add the import:

```ts
import { detectCurrentProject } from "./coherence";
```

Inside the `store_knowledge` tool's `execute` function, **before** the existing INSERT, add:

```ts
// Resolve project scope: Project Context snippets are scoped to the current workspace,
// everything else stays generic unless the caller passes an explicit project_id.
let resolvedProjectId: string | null = null;
const normalizedCategory = normalizeCategory(category);
if (normalizedCategory === "Project Context") {
  const proj = await detectCurrentProject();
  resolvedProjectId = proj.id;
}
```

Update the INSERT statement to include `project_id` in the column list and `?` in the values, and add `resolvedProjectId` to the args. For example:

```ts
await client.execute({
  sql: `INSERT INTO technical_knowledge (id, topic, content, category, parent_id, project_id)
        VALUES (?, ?, ?, ?, ?, ?)`,
  args: [id, topic, content, normalizedCategory, parent_id ?? null, resolvedProjectId],
});
```

(Adjust to match the actual existing arg names — `category` may already be normalized upstream.)

- [ ] **Step 3: Run typecheck**

```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Manual smoke test**

```bash
bun run src/test-workflow.ts
```
Expected: existing workflow test still passes; a `Project Context` write now populates `project_id`. Verify:

```bash
sqlite3 sysqlow.db "SELECT topic, project_id FROM technical_knowledge WHERE category='Project Context' ORDER BY created_at DESC LIMIT 3;"
```
Expected: most recent rows show non-NULL `project_id`.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(store): assign project_id to Project Context snippets via detectCurrentProject"
```

---

## Task 11: Add `projectScope` to `recall_knowledge` and `semantic_search`

**Files:**
- Modify: `src/index.ts` (the `recall_knowledge` and `semantic_search` tool definitions)

- [ ] **Step 1: Add the `projectScope` parameter to both tools**

For each tool, extend the Zod schema with:

```ts
projectScope: z.enum(["all", "current", "generic"]).or(z.string().uuid()).optional()
  .describe("'all' = no filter; 'current' (default) = current project ∪ generic; 'generic' = generic only; or a project UUID."),
```

- [ ] **Step 2: Resolve the scope into a SQL fragment + args**

At the top of each tool's `execute`, add:

```ts
async function resolveScope(scope: string | undefined): Promise<{ where: string; args: any[] }> {
  if (scope === "all") return { where: "", args: [] };
  if (scope === "generic") return { where: "AND project_id IS NULL", args: [] };
  if (scope && scope !== "current") {
    // explicit project UUID
    return { where: "AND (project_id = ? OR project_id IS NULL)", args: [scope] };
  }
  // default = current
  const proj = await detectCurrentProject();
  return { where: "AND (project_id = ? OR project_id IS NULL)", args: [proj.id] };
}
```

(Place this as a top-level helper in `src/index.ts`, not nested inside the tool, so both tools can share it.)

- [ ] **Step 3: Apply the scope filter in each SQL path**

Update the FTS query, the LIKE-fallback query, and the embedding loader inside `semantic_search` so they all append `scope.where` to their WHERE clause and concat `scope.args` to their args array. Example for the FTS branch:

```ts
const scope = await resolveScope(projectScope);
const result = await client.execute({
  sql: `SELECT tk.* FROM technical_knowledge tk
        JOIN technical_knowledge_fts f ON f.id = tk.id
        WHERE technical_knowledge_fts MATCH ? ${scope.where}
        LIMIT ?`,
  args: [ftsQuery, ...scope.args, limit],
});
```

Apply the same pattern to the LIKE fallback and to the `SELECT ... FROM technical_knowledge_embeddings JOIN technical_knowledge ...` query inside `semantic_search`.

- [ ] **Step 4: Typecheck and manual smoke**

```bash
bun run typecheck
bun run src/test-workflow.ts
```
Expected: no type errors; workflow integration still passes.

- [ ] **Step 5: Commit**

```bash
git add src/index.ts
git commit -m "feat(search): add projectScope filter to recall_knowledge and semantic_search"
```

---

## Task 12: Replace `/api/graph` edges with `knowledge_relations`

**Files:**
- Modify: `src/index.ts` (the `/api/graph` route handler, ~lines 1442-1490)

- [ ] **Step 1: Locate the current implementation**

```bash
grep -n "/api/graph" src/index.ts
```

- [ ] **Step 2: Replace the brute-force similarity loop with a SQL read**

Replace the existing edge-computation block inside the handler with:

```ts
// Edges now come from the materialized knowledge_relations table.
// The isolation trigger guarantees no cross-project edges exist here.
const edgeRows = await client.execute(`
  SELECT source_id, target_id, weight, relation_type
  FROM knowledge_relations
`);

const edges = edgeRows.rows.map(r => ({
  from: String(r.source_id),
  to: String(r.target_id),
  value: Number(r.weight),
  title: String(r.relation_type),
}));
```

Keep the existing node-collection code (it already reads from `technical_knowledge`); just attach each node's `project_id` to its payload so the dashboard can color/filter by project:

```ts
const nodeRows = await client.execute(`SELECT id, topic, category, project_id FROM technical_knowledge`);
const nodes = nodeRows.rows.map(r => ({
  id: String(r.id),
  label: String(r.topic),
  group: String(r.category ?? "Uncategorized"),
  project_id: r.project_id === null ? null : String(r.project_id),
}));
```

- [ ] **Step 3: Manual verification**

Start the server in SSE mode and hit the endpoint:

```bash
MCP_TRANSPORT=sse PORT=50741 bun run src/index.ts &
sleep 2
curl -s http://localhost:50741/api/graph | head -c 500
kill %1
```
Expected: JSON with `nodes` and `edges` arrays; no cross-project edges (if `discoverRelations` hasn't been run yet, `edges` may be empty — that is correct).

- [ ] **Step 4: Commit**

```bash
git add src/index.ts
git commit -m "feat(api): /api/graph reads edges from knowledge_relations table"
```

---

## Task 13: `mergeProjects` operation + `merge_projects` tool

**Files:**
- Modify: `src/coherence.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement `mergeProjects` in coherence.ts**

Append to `src/coherence.ts`:

```ts
export async function mergeProjects(keepId: string, dropId: string): Promise<{ snippetsMoved: number; relationsMoved: number }> {
  if (keepId === dropId) throw new Error("mergeProjects: keep_id and drop_id are identical");

  const before = await client.execute({
    sql: "SELECT COUNT(*) AS n FROM technical_knowledge WHERE project_id = ?",
    args: [dropId],
  });
  const snippetsMoved = Number(before.rows[0].n);

  await client.execute({
    sql: "UPDATE technical_knowledge SET project_id = ? WHERE project_id = ?",
    args: [keepId, dropId],
  });
  // Relations are referenced by snippet ids, not project ids, so no edge rewrite is needed.
  // We just delete the now-empty project row.
  await client.execute({ sql: "DELETE FROM projects WHERE id = ?", args: [dropId] });

  return { snippetsMoved, relationsMoved: 0 };
}
```

- [ ] **Step 2: Register the `merge_projects` MCP tool in `src/index.ts`**

Add this tool registration alongside the other `server.addTool({...})` calls:

```ts
server.addTool({
  name: "merge_projects",
  description: "Merge two projects: move all snippets from drop_id into keep_id, then delete drop_id. Use after audit_coherence flags a duplicate proto-project.",
  parameters: z.object({
    keep_id: z.string().uuid().describe("Project to retain."),
    drop_id: z.string().uuid().describe("Project to absorb and delete."),
  }),
  execute: async ({ keep_id, drop_id }) => {
    const { mergeProjects } = await import("./coherence");
    const result = await mergeProjects(keep_id, drop_id);
    return `Merged ${result.snippetsMoved} snippet(s) from ${drop_id} into ${keep_id}.`;
  },
});
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/coherence.ts src/index.ts
git commit -m "feat(coherence): add merge_projects tool to collapse duplicate projects"
```

---

## Task 14: `reassignProject` operation + `reassign_project` tool

**Files:**
- Modify: `src/coherence.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement `reassignProject`**

Append to `src/coherence.ts`:

```ts
export async function reassignProject(snippetId: string, newProjectId: string | null): Promise<void> {
  // Verify the snippet exists.
  const existing = await client.execute({
    sql: "SELECT id FROM technical_knowledge WHERE id = ?",
    args: [snippetId],
  });
  if (existing.rows.length === 0) throw new Error(`reassignProject: snippet ${snippetId} not found`);

  if (newProjectId !== null) {
    const proj = await client.execute({
      sql: "SELECT id FROM projects WHERE id = ?",
      args: [newProjectId],
    });
    if (proj.rows.length === 0) throw new Error(`reassignProject: project ${newProjectId} not found`);
  }

  await client.execute({
    sql: "UPDATE technical_knowledge SET project_id = ? WHERE id = ?",
    args: [newProjectId, snippetId],
  });

  // Any relations that now violate the invariant must be pruned.
  await client.execute({
    sql: `
      DELETE FROM knowledge_relations
      WHERE id IN (
        SELECT kr.id FROM knowledge_relations kr
        JOIN technical_knowledge s ON s.id = kr.source_id
        JOIN technical_knowledge t ON t.id = kr.target_id
        WHERE s.project_id IS NOT NULL
          AND t.project_id IS NOT NULL
          AND s.project_id != t.project_id
      )
    `,
    args: [],
  });
}
```

- [ ] **Step 2: Register the tool**

In `src/index.ts`:

```ts
server.addTool({
  name: "reassign_project",
  description: "Move a single snippet to a different project, or pass new_project_id=null to promote it to generic (shared across projects).",
  parameters: z.object({
    snippet_id: z.string().uuid(),
    new_project_id: z.string().uuid().nullable(),
  }),
  execute: async ({ snippet_id, new_project_id }) => {
    const { reassignProject } = await import("./coherence");
    await reassignProject(snippet_id, new_project_id);
    return new_project_id === null
      ? `Promoted snippet ${snippet_id} to generic.`
      : `Reassigned snippet ${snippet_id} to project ${new_project_id}.`;
  },
});
```

- [ ] **Step 3: Commit**

```bash
git add src/coherence.ts src/index.ts
git commit -m "feat(coherence): add reassign_project tool with relation pruning"
```

---

## Task 15: `audit_coherence` — Phase 1 (structural, auto-apply)

**Files:**
- Modify: `src/coherence.ts`
- Modify: `src/index.ts`

- [ ] **Step 1: Implement `auditStructural`**

Append to `src/coherence.ts`:

```ts
export type StructuralReport = {
  unprefixedProjectContext: { id: string; topic: string }[];
  duplicateProtoProjects: { name: string; ids: string[] }[];
  orphanRelations: number;
};

export async function auditStructural(autoApply: boolean): Promise<StructuralReport> {
  // 1. Project Context rows that do NOT match the "Name: Topic" shape.
  const unprefixed = await client.execute(`
    SELECT id, topic FROM technical_knowledge
    WHERE category = 'Project Context' AND topic NOT LIKE '%: %'
  `);

  // 2. Duplicate proto-projects (NULL root_path) with normalized-equal names.
  const proto = await client.execute(`
    SELECT id, LOWER(TRIM(name)) AS nkey, name FROM projects WHERE root_path IS NULL
  `);
  const byKey = new Map<string, { ids: string[]; name: string }>();
  for (const r of proto.rows) {
    const key = String(r.nkey);
    const entry = byKey.get(key) ?? { ids: [], name: String(r.name) };
    entry.ids.push(String(r.id));
    byKey.set(key, entry);
  }
  const duplicateProtoProjects = [...byKey.entries()]
    .filter(([, v]) => v.ids.length > 1)
    .map(([, v]) => ({ name: v.name, ids: v.ids }));

  // 3. Orphan relations (FK should have cascaded, but double-check).
  const orphans = await client.execute(`
    SELECT COUNT(*) AS n FROM knowledge_relations kr
    WHERE NOT EXISTS (SELECT 1 FROM technical_knowledge WHERE id = kr.source_id)
       OR NOT EXISTS (SELECT 1 FROM technical_knowledge WHERE id = kr.target_id)
  `);
  const orphanRelations = Number(orphans.rows[0].n);

  if (autoApply) {
    // Auto-merge duplicate proto-projects (keep the first id).
    for (const { ids } of duplicateProtoProjects) {
      const [keep, ...drop] = ids;
      for (const d of drop) await mergeProjects(keep, d);
    }
    // Delete orphan relations.
    await client.execute(`
      DELETE FROM knowledge_relations
      WHERE NOT EXISTS (SELECT 1 FROM technical_knowledge WHERE id = knowledge_relations.source_id)
         OR NOT EXISTS (SELECT 1 FROM technical_knowledge WHERE id = knowledge_relations.target_id)
    `);
  }

  return {
    unprefixedProjectContext: unprefixed.rows.map(r => ({ id: String(r.id), topic: String(r.topic) })),
    duplicateProtoProjects,
    orphanRelations,
  };
}
```

- [ ] **Step 2: Commit (the MCP tool wiring lands in Task 17)**

```bash
git add src/coherence.ts
git commit -m "feat(coherence): add auditStructural (audit phase 1)"
```

---

## Task 16: `audit_coherence` — Phase 2 (semantic, suggestion-based)

**Files:**
- Modify: `src/coherence.ts`

- [ ] **Step 1: Implement `auditSemantic`**

Append to `src/coherence.ts`:

```ts
export type Suggestion = {
  id: string;                       // suggestion id (random, ephemeral)
  kind: "reassign_to_project" | "promote_to_generic" | "near_duplicate" | "mention_pollution";
  snippet_id: string;
  detail: string;
  proposedProjectId?: string | null;
  partnerSnippetId?: string;        // for near_duplicate
};

const SIM_REASSIGN_THRESHOLD = 0.7;
const SIM_NEAR_DUPLICATE = 0.92;

export async function auditSemantic(): Promise<Suggestion[]> {
  const rows = await client.execute(`
    SELECT tk.id, tk.project_id, tk.topic, tk.content, e.embedding
    FROM technical_knowledge tk
    JOIN technical_knowledge_embeddings e ON e.id = tk.id
  `);

  type Rec = { id: string; project_id: string | null; topic: string; content: string; vec: number[] };
  const recs: Rec[] = [];
  for (const r of rows.rows) {
    try {
      recs.push({
        id: String(r.id),
        project_id: r.project_id === null ? null : String(r.project_id),
        topic: String(r.topic),
        content: String(r.content),
        vec: JSON.parse(String(r.embedding)),
      });
    } catch { /* skip */ }
  }

  const suggestions: Suggestion[] = [];

  // Detector A: generic snippet whose top-3 neighbors all belong to one project (high mean similarity).
  for (const src of recs) {
    if (src.project_id !== null) continue;
    const others = recs
      .filter(t => t.id !== src.id)
      .map(t => ({ t, score: cosineSimilarity(src.vec, t.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    if (others.length === 3 && others.every(o => o.t.project_id !== null)) {
      const projectIds = new Set(others.map(o => o.t.project_id));
      const meanScore = others.reduce((s, o) => s + o.score, 0) / 3;
      if (projectIds.size === 1 && meanScore > SIM_REASSIGN_THRESHOLD) {
        suggestions.push({
          id: crypto.randomUUID(),
          kind: "reassign_to_project",
          snippet_id: src.id,
          proposedProjectId: [...projectIds][0],
          detail: `Generic snippet "${src.topic}" looks project-specific (mean sim ${meanScore.toFixed(2)}).`,
        });
      }
    }
  }

  // Detector B: project snippet whose neighbors span ≥3 distinct projects.
  for (const src of recs) {
    if (src.project_id === null) continue;
    const others = recs
      .filter(t => t.id !== src.id && t.project_id !== null)
      .map(t => ({ t, score: cosineSimilarity(src.vec, t.vec) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);
    const projectIds = new Set(others.map(o => o.t.project_id));
    if (projectIds.size >= 3) {
      suggestions.push({
        id: crypto.randomUUID(),
        kind: "promote_to_generic",
        snippet_id: src.id,
        proposedProjectId: null,
        detail: `Project snippet "${src.topic}" has neighbors across ${projectIds.size} projects — likely generic.`,
      });
    }
  }

  // Detector C: cross-project near-duplicates.
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      const a = recs[i], b = recs[j];
      if (a.project_id === null || b.project_id === null) continue;
      if (a.project_id === b.project_id) continue;
      const score = cosineSimilarity(a.vec, b.vec);
      if (score >= SIM_NEAR_DUPLICATE) {
        suggestions.push({
          id: crypto.randomUUID(),
          kind: "near_duplicate",
          snippet_id: a.id,
          partnerSnippetId: b.id,
          detail: `Near-duplicate across projects: "${a.topic}" ≈ "${b.topic}" (sim ${score.toFixed(2)}).`,
        });
      }
    }
  }

  // Detector D: Project Context rows that mention another known project's name in their content.
  const projNames = await client.execute("SELECT id, name FROM projects");
  const nameById = new Map<string, string>(projNames.rows.map(r => [String(r.id), String(r.name)]));
  for (const src of recs) {
    if (src.project_id === null) continue;
    for (const [otherId, otherName] of nameById) {
      if (otherId === src.project_id) continue;
      if (otherName.length < 3) continue; // skip too-generic names
      if (src.content.toLowerCase().includes(otherName.toLowerCase())) {
        suggestions.push({
          id: crypto.randomUUID(),
          kind: "mention_pollution",
          snippet_id: src.id,
          detail: `Snippet in project ${nameById.get(src.project_id) ?? src.project_id} mentions "${otherName}".`,
        });
      }
    }
  }

  return suggestions;
}

export async function applySuggestions(all: Suggestion[], ids: string[]): Promise<{ applied: number; failed: string[] }> {
  const picked = all.filter(s => ids.includes(s.id));
  let applied = 0;
  const failed: string[] = [];
  for (const s of picked) {
    try {
      if (s.kind === "reassign_to_project" || s.kind === "promote_to_generic") {
        await reassignProject(s.snippet_id, s.proposedProjectId ?? null);
        applied++;
      } else {
        // near_duplicate and mention_pollution are flagged for manual review.
        failed.push(`${s.id}: ${s.kind} requires manual action`);
      }
    } catch (err: any) {
      failed.push(`${s.id}: ${err.message}`);
    }
  }
  return { applied, failed };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/coherence.ts
git commit -m "feat(coherence): add auditSemantic with four heuristic detectors (phase 2)"
```

---

## Task 17: `audit_coherence` — Phase 3 (re-discovery) + MCP tool wiring

**Files:**
- Modify: `src/index.ts`
- Modify: `src/coherence.ts` (export a small in-memory store for suggestion ids across calls)

- [ ] **Step 1: Add an in-memory suggestion cache to coherence.ts**

Append to `src/coherence.ts`:

```ts
// In-memory suggestion store, keyed by audit run id. Cleared on server restart by design —
// suggestions are advisory and re-running the audit is cheap.
const suggestionStore = new Map<string, Suggestion[]>();

export function _stashSuggestions(runId: string, list: Suggestion[]) {
  suggestionStore.set(runId, list);
}
export function _loadSuggestions(runId: string): Suggestion[] | undefined {
  return suggestionStore.get(runId);
}
```

- [ ] **Step 2: Register the `audit_coherence` tool in `src/index.ts`**

```ts
server.addTool({
  name: "audit_coherence",
  description: "Inspect and optionally clean the knowledge base. Phase 1 = structural (auto-applies safe fixes). Phase 2 = semantic (returns suggestions; apply a subset with apply_suggestions). Phase 3 = relation re-discovery.",
  parameters: z.object({
    phase: z.enum(["1", "2", "3", "all"]).default("all"),
    auto_apply_structural: z.boolean().default(true),
    apply_suggestions: z.array(z.string()).optional().describe("Suggestion ids returned by a previous phase-2 call."),
    suggestion_run_id: z.string().optional().describe("Run id from a previous phase-2 call, required when applying."),
  }),
  execute: async ({ phase, auto_apply_structural, apply_suggestions, suggestion_run_id }) => {
    const coherence = await import("./coherence");
    const out: any = {};

    if (apply_suggestions && apply_suggestions.length > 0) {
      if (!suggestion_run_id) throw new Error("suggestion_run_id is required when apply_suggestions is set");
      const stash = coherence._loadSuggestions(suggestion_run_id);
      if (!stash) throw new Error(`No suggestions found for run ${suggestion_run_id}. Re-run phase 2 first.`);
      out.applied = await coherence.applySuggestions(stash, apply_suggestions);
    }

    if (phase === "1" || phase === "all") {
      out.phase1 = await coherence.auditStructural(auto_apply_structural);
    }
    if (phase === "2" || phase === "all") {
      const suggestions = await coherence.auditSemantic();
      const runId = crypto.randomUUID();
      coherence._stashSuggestions(runId, suggestions);
      out.phase2 = { run_id: runId, suggestions };
    }
    if (phase === "3" || phase === "all") {
      out.phase3 = await coherence.discoverRelations();
    }
    return JSON.stringify(out, null, 2);
  },
});
```

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/coherence.ts src/index.ts
git commit -m "feat(coherence): register audit_coherence MCP tool covering all three phases"
```

---

## Task 18: Integration assertions in `test-workflow.ts`

**Files:**
- Modify: `src/test-workflow.ts`

- [ ] **Step 1: Append two integration assertions at the end of `run()`**

Right before the script terminates the spawned server:

```ts
// --- Coherence engine assertions ---
console.log("[coherence] verifying isolation invariant…");

// Seed two project rows + one snippet each.
const projA = crypto.randomUUID();
const projB = crypto.randomUUID();
await client.execute({ sql: "INSERT INTO projects (id, name, root_path) VALUES (?, 'coh-a', '/tmp/coh-a')", args: [projA] });
await client.execute({ sql: "INSERT INTO projects (id, name, root_path) VALUES (?, 'coh-b', '/tmp/coh-b')", args: [projB] });
const sA = crypto.randomUUID();
const sB = crypto.randomUUID();
await client.execute({ sql: "INSERT INTO technical_knowledge (id, topic, content, category, project_id) VALUES (?, 'A-topic', 'A-content', 'Project Context', ?)", args: [sA, projA] });
await client.execute({ sql: "INSERT INTO technical_knowledge (id, topic, content, category, project_id) VALUES (?, 'B-topic', 'B-content', 'Project Context', ?)", args: [sB, projB] });

let triggerRejected = false;
try {
  await client.execute({
    sql: "INSERT INTO knowledge_relations (id, source_id, target_id, relation_type, weight) VALUES (?, ?, ?, 'manual', 1.0)",
    args: [crypto.randomUUID(), sA, sB],
  });
} catch (err: any) {
  if (String(err.message).includes("context_isolation_violation")) triggerRejected = true;
}
if (!triggerRejected) {
  console.error("[coherence] FAIL: cross-project relation was NOT rejected by trigger");
  process.exit(1);
}
console.log("[coherence] OK: trigger rejected cross-project insert.");

// Cleanup.
await client.execute({ sql: "DELETE FROM technical_knowledge WHERE id IN (?, ?)", args: [sA, sB] });
await client.execute({ sql: "DELETE FROM projects WHERE id IN (?, ?)", args: [projA, projB] });
```

- [ ] **Step 2: Run the workflow test**

```bash
bun run test:workflow
```
Expected: ends with `[coherence] OK: trigger rejected cross-project insert.` and overall success.

- [ ] **Step 3: Commit**

```bash
git add src/test-workflow.ts
git commit -m "test(workflow): assert isolation trigger rejects cross-project edges"
```

---

## Task 19: Dashboard project filter dropdown

**Files:**
- Modify: `src/dashboard-html.ts`

- [ ] **Step 1: Locate the toolbar markup in the HTML string**

```bash
grep -n "<select\|filterControls\|<header" src/dashboard-html.ts | head
```

- [ ] **Step 2: Add a project `<select>` element to the toolbar**

Inside the HTML string, alongside the existing category filter, insert:

```html
<label>Project:
  <select id="projectFilter">
    <option value="all">All</option>
    <option value="generic">Generic only</option>
  </select>
</label>
```

- [ ] **Step 3: Populate the dropdown and wire the filter on graph load**

In the inline `<script>` block, after the existing `fetch('/api/graph')` call, add:

```js
// Populate project filter from node payloads.
const projectIds = [...new Set(nodes.map(n => n.project_id).filter(Boolean))];
const sel = document.getElementById('projectFilter');
for (const pid of projectIds) {
  const opt = document.createElement('option');
  opt.value = pid;
  opt.textContent = pid.slice(0, 8) + '…';
  sel.appendChild(opt);
}

function applyProjectFilter() {
  const val = sel.value;
  const visibleNodeIds = new Set(
    nodes.filter(n => {
      if (val === 'all') return true;
      if (val === 'generic') return n.project_id === null;
      return n.project_id === val || n.project_id === null;
    }).map(n => n.id),
  );
  network.setData({
    nodes: nodes.filter(n => visibleNodeIds.has(n.id)),
    edges: edges.filter(e => visibleNodeIds.has(e.from) && visibleNodeIds.has(e.to)),
  });
}
sel.addEventListener('change', applyProjectFilter);
```

- [ ] **Step 4: Manual verification**

```bash
MCP_TRANSPORT=sse PORT=50741 bun run src/index.ts &
sleep 2
open http://localhost:50741/
# Visually confirm the Project dropdown appears and filters the graph.
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add src/dashboard-html.ts
git commit -m "feat(dashboard): add project filter dropdown to knowledge graph"
```

---

## Task 20: Update CLAUDE.md and README

**Files:**
- Modify: `CLAUDE.md`
- Modify: `README.md`

- [ ] **Step 1: Append a "Coherence" section to `CLAUDE.md`**

Under the existing architecture section, add:

```markdown
### Coherence

`src/coherence.ts` owns project identity and the context isolation invariant:
- `detectCurrentProject()` walks up from `process.cwd()` to find a manifest (package.json, composer.json, etc.), then looks up or creates a row in `projects` keyed by `root_path`. Proto-projects (NULL `root_path`) are adopted in place when their workspace is first opened.
- `canRelate(a, b)` returns true iff at least one side is generic (NULL) or both share the same project_id. Mirrored at the DB layer by the `enforce_relation_isolation` trigger.
- `discoverRelations()` materializes edges into `knowledge_relations`; `/api/graph` reads from this table directly.
- `audit_coherence` MCP tool runs three phases: structural (auto-applies safe fixes), semantic (returns suggestions to apply selectively), relation re-discovery.

`store_knowledge` writes a non-NULL `project_id` for `Project Context` snippets; everything else stays generic.

`recall_knowledge` and `semantic_search` accept a `projectScope` parameter (`"current"` default = current project ∪ generic, `"all"`, `"generic"`, or a project UUID).
```

- [ ] **Step 2: Add a one-liner pointer in `README.md`**

Under the existing LITERATURES.md pointer, add:

```markdown
> 🧭 **Coherence:** Snippets stored as `Project Context` are scoped to the workspace they were stored in; generic technical snippets are shared across all projects. See [Coherence Engine design](docs/superpowers/specs/2026-05-28-knowledge-coherence-engine-design.md).
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: document coherence engine in CLAUDE.md and README"
```

---

## Self-Review Notes

- **Spec coverage:** §4 schema ↔ Tasks 1-5. §5 project identification ↔ Task 7. §6 scoping rules ↔ Tasks 10-11. §7 migration ↔ Tasks 4-5, 8. §8 audit phases ↔ Tasks 15-17. §9 new operations ↔ Tasks 13-14. §10 hooks ↔ Tasks 10-12, 19. §11 edge cases covered by tests in Tasks 7, 9, 18. §12 testing strategy ↔ Tasks 6, 7, 9, 18.
- **Naming consistency:** `detectCurrentProject`, `canRelate`, `discoverRelations`, `mergeProjects`, `reassignProject`, `auditStructural`, `auditSemantic`, `applySuggestions` — used identically in coherence.ts definitions and index.ts call sites.
- **No placeholders:** every step has executable code or shell commands.
- **TDD shape:** Tasks 6, 7, 9 follow strict red→green→commit. Tasks 10-19 are wiring/glue where unit tests are less valuable than the integration assertions in Task 18.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-28-knowledge-coherence-engine.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session with checkpoints for review.

**Which approach?**
