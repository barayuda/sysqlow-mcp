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
  // Precedence: test override > SYSQLOW_WORKSPACE_DIR env (used by run-docker.sh
  // to pass the host's invocation cwd into the container) > process.cwd().
  if (cwdOverride !== null) return cwdOverride;
  const envDir = process.env.SYSQLOW_WORKSPACE_DIR;
  if (envDir && envDir.trim().length > 0) return envDir;
  return process.cwd();
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

  // 3. Orphan relations (FK should cascade-delete, but double-check).
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

export type Suggestion = {
  id: string;
  kind: "reassign_to_project" | "promote_to_generic" | "near_duplicate" | "mention_pollution";
  snippet_id: string;
  detail: string;
  proposedProjectId?: string | null;
  partnerSnippetId?: string;
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
    } catch { /* skip malformed */ }
  }

  const suggestions: Suggestion[] = [];

  // Detector A: generic snippet whose top-3 neighbors all belong to one project.
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

  // Detector D: Project Context rows mentioning another known project's name.
  const projNames = await client.execute("SELECT id, name FROM projects");
  const nameById = new Map<string, string>(projNames.rows.map(r => [String(r.id), String(r.name)]));
  for (const src of recs) {
    if (src.project_id === null) continue;
    for (const [otherId, otherName] of nameById) {
      if (otherId === src.project_id) continue;
      if (otherName.length < 3) continue;
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
        failed.push(`${s.id}: ${s.kind} requires manual action`);
      }
    } catch (err: any) {
      failed.push(`${s.id}: ${err.message}`);
    }
  }
  return { applied, failed };
}

// In-memory suggestion store, keyed by audit run id. Cleared on server restart by design —
// suggestions are advisory and re-running the audit is cheap.
const suggestionStore = new Map<string, Suggestion[]>();

export function _stashSuggestions(runId: string, list: Suggestion[]) {
  suggestionStore.set(runId, list);
}
export function _loadSuggestions(runId: string): Suggestion[] | undefined {
  return suggestionStore.get(runId);
}

/**
 * Background coherence pass: runs phase 1 (structural, auto-applies safe fixes)
 * and phase 3 (re-discover edges). Intentionally skips phase 2 because semantic
 * suggestions require user judgment.
 *
 * Safe to call repeatedly: phase 1 is idempotent, phase 3 uses INSERT OR IGNORE
 * plus the isolation trigger, and any error is swallowed so the caller (server
 * startup or Sentinel cron) never gets killed by an audit failure.
 */
export async function runBackgroundCoherence(label: string): Promise<void> {
  try {
    console.error(`[Coherence Daemon] (${label}) Phase 1 (structural)…`);
    const p1 = await auditStructural(true);
    console.error(
      `[Coherence Daemon] (${label}) Phase 1 done: ` +
      `unprefixed=${p1.unprefixedProjectContext.length}, ` +
      `merged_proto_dupes=${p1.duplicateProtoProjects.length}, ` +
      `orphan_relations=${p1.orphanRelations}`,
    );

    console.error(`[Coherence Daemon] (${label}) Phase 3 (re-discovery)…`);
    const p3 = await discoverRelations();
    console.error(
      `[Coherence Daemon] (${label}) Phase 3 done: ` +
      `inserted=${p3.inserted}, skipped_by_invariant=${p3.skipped}`,
    );
  } catch (err: any) {
    console.error(`[Coherence Daemon Error] (${label}) ${err?.message ?? err}`);
  }
}
