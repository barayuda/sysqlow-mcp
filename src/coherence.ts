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
  while (true) {
    for (const marker of MANIFEST_FILES) {
      if (fs.existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
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

  const id = crypto.randomUUID();
  await client.execute({
    sql: "INSERT INTO projects (id, name, root_path, detected_stack) VALUES (?, ?, ?, ?)",
    args: [id, name, rootPath, stack],
  });
  return { id, name, root_path: rootPath, detected_stack: stack };
}

import { cosineSimilarity } from "./search";

const DISCOVERY_THRESHOLD = 0.75;
const DISCOVERY_TOPK = 10;

export async function discoverRelations(opts?: { projectId?: string | null }): Promise<{ inserted: number; skipped: number }> {
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
    if (opts?.projectId !== undefined && opts.projectId !== null && src.project_id !== opts.projectId) continue;

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
  // Relations reference snippet ids (not project ids), so no edge rewrite is needed.
  await client.execute({ sql: "DELETE FROM projects WHERE id = ?", args: [dropId] });

  return { snippetsMoved, relationsMoved: 0 };
}

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

  // Any relations that now violate the isolation invariant must be pruned.
  await client.execute(`
    DELETE FROM knowledge_relations
    WHERE id IN (
      SELECT kr.id FROM knowledge_relations kr
      JOIN technical_knowledge s ON s.id = kr.source_id
      JOIN technical_knowledge t ON t.id = kr.target_id
      WHERE s.project_id IS NOT NULL
        AND t.project_id IS NOT NULL
        AND s.project_id != t.project_id
    )
  `);
}
