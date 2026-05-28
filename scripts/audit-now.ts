#!/usr/bin/env bun
/**
 * One-off audit runner: runs all three phases of audit_coherence against the
 * current databank and prints a human-readable report.
 *
 * Not a permanent file — used to inspect the live state after the coherence
 * engine migration. Safe to re-run; phase 1 auto-applies idempotent fixes,
 * phase 2 only collects suggestions (you decide what to apply), phase 3
 * (re)materializes edges via INSERT OR IGNORE.
 *
 * Usage: bun run scripts/audit-now.ts
 */
import { initDatabase, client } from "../src/db";
import {
  auditStructural,
  auditSemantic,
  discoverRelations,
} from "../src/coherence";

await initDatabase();

// --- Snapshot before ---
const beforeProjects = await client.execute("SELECT COUNT(*) AS n FROM projects");
const beforeRelations = await client.execute("SELECT COUNT(*) AS n FROM knowledge_relations");
const beforeProjectCtx = await client.execute(
  "SELECT COUNT(*) AS n FROM technical_knowledge WHERE category='Project Context'"
);
const beforeScoped = await client.execute(
  "SELECT COUNT(*) AS n FROM technical_knowledge WHERE project_id IS NOT NULL"
);
const beforeGeneric = await client.execute(
  "SELECT COUNT(*) AS n FROM technical_knowledge WHERE project_id IS NULL"
);

console.log("\n================ BEFORE ================");
console.log(`projects                : ${beforeProjects.rows[0].n}`);
console.log(`knowledge_relations     : ${beforeRelations.rows[0].n}`);
console.log(`Project Context rows    : ${beforeProjectCtx.rows[0].n}`);
console.log(`scoped snippets         : ${beforeScoped.rows[0].n}`);
console.log(`generic snippets        : ${beforeGeneric.rows[0].n}`);

// --- Phase 1 ---
console.log("\n================ PHASE 1: STRUCTURAL ================");
const p1 = await auditStructural(true);
console.log(`unprefixed Project Context : ${p1.unprefixedProjectContext.length}`);
for (const r of p1.unprefixedProjectContext.slice(0, 10)) {
  console.log(`  - ${r.id.slice(0, 8)}…  "${r.topic}"`);
}
if (p1.unprefixedProjectContext.length > 10) {
  console.log(`  …(+${p1.unprefixedProjectContext.length - 10} more)`);
}
console.log(`duplicate proto-projects   : ${p1.duplicateProtoProjects.length} (merged)`);
for (const d of p1.duplicateProtoProjects) {
  console.log(`  - "${d.name}" ×${d.ids.length}`);
}
console.log(`orphan relations           : ${p1.orphanRelations} (deleted if any)`);

// --- Phase 2 ---
console.log("\n================ PHASE 2: SEMANTIC ================");
const suggestions = await auditSemantic();
const byKind = new Map<string, number>();
for (const s of suggestions) byKind.set(s.kind, (byKind.get(s.kind) ?? 0) + 1);

console.log(`total suggestions          : ${suggestions.length}`);
for (const [k, n] of byKind) console.log(`  ${k.padEnd(22)} : ${n}`);

const sampleEach: Record<string, typeof suggestions> = {};
for (const s of suggestions) {
  sampleEach[s.kind] = sampleEach[s.kind] ?? [];
  if (sampleEach[s.kind].length < 5) sampleEach[s.kind].push(s);
}
for (const [kind, list] of Object.entries(sampleEach)) {
  console.log(`\n  --- sample ${kind} (showing ${list.length} of ${byKind.get(kind)}) ---`);
  for (const s of list) {
    console.log(`    ${s.id.slice(0, 8)}…  ${s.detail}`);
  }
}

// --- Phase 3 ---
console.log("\n================ PHASE 3: RE-DISCOVERY ================");
const p3 = await discoverRelations();
console.log(`relation rows inserted     : ${p3.inserted}`);
console.log(`relation rows skipped      : ${p3.skipped}  (isolation invariant guard)`);

// --- Snapshot after ---
const afterRelations = await client.execute("SELECT COUNT(*) AS n FROM knowledge_relations");
const projectBreakdown = await client.execute(`
  SELECT COALESCE(p.name, '<generic>') AS bucket, COUNT(*) AS n
  FROM technical_knowledge tk
  LEFT JOIN projects p ON p.id = tk.project_id
  GROUP BY bucket
  ORDER BY n DESC
`);

console.log("\n================ AFTER ================");
console.log(`knowledge_relations        : ${afterRelations.rows[0].n} (was ${beforeRelations.rows[0].n})`);
console.log("\nsnippets by project bucket:");
for (const r of projectBreakdown.rows) {
  console.log(`  ${String(r.bucket).padEnd(40)} : ${r.n}`);
}

console.log("\n=== DONE ===");
process.exit(0);
