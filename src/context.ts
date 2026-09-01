/**
 * Session context briefing — the "memory injection" half of SysQlow's
 * knowledge-bank workflow. Builds a compact digest of what the bank already
 * knows about a project so any MCP client (Claude Code, Cursor, Claude
 * Desktop, …) can pull it into context at session start.
 *
 * Everything here is pure DB reads: zero LLM calls, zero network calls,
 * zero Gemini quota. Safe to serve on every session start.
 */
import fs from "node:fs";
import { client } from "./db";
import { detectCurrentProject, type Project } from "./coherence";

export type ProjectHint = {
  projectId?: string;
  projectPath?: string;
  projectName?: string;
};

export type BriefingKnowledgeItem = {
  id: string;
  topic: string;
  category: string | null;
  content: string;
  is_validated: boolean;
  confidence_score: number;
};

export type BriefingRecentItem = {
  id: string;
  topic: string;
  category: string | null;
  created_at: string;
};

export type BriefingOutdatedItem = {
  id: string;
  topic: string;
  reasoning: string | null;
};

export type BriefingObservation = {
  id: string;
  kind: string;
  title: string;
  body: string;
  agent: string | null;
  created_at: string;
};

export type SessionBriefing = {
  project: Project | null;
  /** Set when explicit hints were given but none matched a known project. */
  unresolved_hint: string | null;
  stats: {
    total_in_scope: number;
    validated: number;
    flagged_outdated: number;
    project_scoped: number;
    generic: number;
  };
  project_knowledge: BriefingKnowledgeItem[];
  /** Generic snippets FTS-matched against the project's detected stack. */
  stack_hints: BriefingRecentItem[];
  recent: BriefingRecentItem[];
  /** Episodic memory: what happened in recent sessions (see src/observations.ts). */
  recent_observations: BriefingObservation[];
  outdated: BriefingOutdatedItem[];
  guidance: string;
};

/**
 * The capture protocol handed to every agent alongside the briefing. This is
 * what turns a passive knowledge base into a cross-client memory: every agent
 * that reads the briefing also learns how to write back into it.
 */
export const CAPTURE_GUIDANCE = [
  "You are connected to SysQlow, this developer's persistent cross-agent knowledge bank. During this session:",
  '- SEARCH FIRST: before re-deriving project facts or researching a topic, call `knowledge_workflow { intent: "semantic", query }`.',
  '- SAVE AS YOU GO: when the user teaches you something, a decision is made, or you discover a non-obvious fact, call `knowledge_workflow { intent: "save", topic, content, category }`. Use category "Project Context" for project-specific facts (they auto-scope to this project); Backend/Frontend/DevOps/Database/Testing/Tooling for reusable knowledge.',
  '- RECORD EVENTS: after a decision, bug fix, or discovery, call `record_observation { kind, title, body }` (kinds: decision, bugfix, discovery, change, note).',
  '- END OF SESSION: before a long session ends, record one `record_observation { kind: "session_summary", title, body }` covering what changed and why — the next agent (in any IDE) starts from it.',
  "- Knowledge you save here is shared with every other AI agent the developer uses.",
].join("\n");

const MAX_ITEMS_CEILING = 25;
const CONTENT_TRUNCATE = 600;
const REASONING_TRUNCATE = 300;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + "…";
}

function rowToProject(r: any): Project {
  return {
    id: String(r.id),
    name: String(r.name),
    root_path: r.root_path === null || r.root_path === undefined ? null : String(r.root_path),
    detected_stack: r.detected_stack === null || r.detected_stack === undefined ? null : String(r.detected_stack),
  };
}

/**
 * Resolve a project row from caller-supplied hints.
 *
 * Explicit hints never fall back to the server's own cwd: on a shared SSE
 * server, "which project?" must not be answered with "whatever directory the
 * server happens to run in" when a remote client asked about a path that only
 * exists on the client's machine. No hints at all = stdio-style local
 * detection via detectCurrentProject().
 */
export async function resolveProjectHint(hint: ProjectHint): Promise<{ project: Project | null; unresolvedHint: string | null }> {
  const path = hint.projectPath?.trim();
  const name = hint.projectName?.trim();
  const hasHint = Boolean(hint.projectId || path || name);

  if (hint.projectId) {
    const res = await client.execute({
      sql: "SELECT id, name, root_path, detected_stack FROM projects WHERE id = ?",
      args: [hint.projectId],
    });
    if (res.rows.length > 0) return { project: rowToProject(res.rows[0]), unresolvedHint: null };
  }

  if (path) {
    // Path visible on this server's filesystem → full detection (creates the
    // project row on first contact, same as store_knowledge does).
    if (fs.existsSync(path)) {
      try {
        return { project: await detectCurrentProject(path), unresolvedHint: null };
      } catch (err: any) {
        console.error(`[Context Warn] detectCurrentProject failed for "${path}": ${err.message}`);
      }
    }
    // Host-side path not mounted here (Docker, or a remote client's local
    // path) → fall back to an exact root_path lookup.
    const res = await client.execute({
      sql: "SELECT id, name, root_path, detected_stack FROM projects WHERE root_path = ?",
      args: [path],
    });
    if (res.rows.length > 0) return { project: rowToProject(res.rows[0]), unresolvedHint: null };
  }

  if (name) {
    const res = await client.execute({
      sql: "SELECT id, name, root_path, detected_stack FROM projects WHERE LOWER(name) = LOWER(?) ORDER BY last_active_at DESC LIMIT 1",
      args: [name],
    });
    if (res.rows.length > 0) return { project: rowToProject(res.rows[0]), unresolvedHint: null };
  }

  if (hasHint) {
    return { project: null, unresolvedHint: hint.projectId ?? path ?? name ?? null };
  }

  try {
    return { project: await detectCurrentProject(), unresolvedHint: null };
  } catch (err: any) {
    console.error(`[Context Warn] detectCurrentProject failed: ${err.message}`);
    return { project: null, unresolvedHint: null };
  }
}

export async function buildSessionBriefing(opts: ProjectHint & { maxItems?: number } = {}): Promise<SessionBriefing> {
  const maxItems = Math.min(MAX_ITEMS_CEILING, Math.max(1, opts.maxItems ?? 8));
  const { project, unresolvedHint } = await resolveProjectHint(opts);

  // Scope = this project ∪ generic knowledge; generic-only when no project.
  const scopeWhere = project ? "(project_id = ? OR project_id IS NULL)" : "project_id IS NULL";
  const scopeArgs: any[] = project ? [project.id] : [];

  const statsRes = await client.execute({
    sql: `SELECT COUNT(*) AS total,
                 COALESCE(SUM(CASE WHEN is_validated = 1 THEN 1 ELSE 0 END), 0) AS validated,
                 COALESCE(SUM(CASE WHEN is_validated = 0 AND last_validated_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS flagged,
                 COALESCE(SUM(CASE WHEN project_id IS NOT NULL THEN 1 ELSE 0 END), 0) AS project_scoped
          FROM technical_knowledge WHERE ${scopeWhere}`,
    args: scopeArgs,
  });
  const s = statsRes.rows[0] as any;
  const stats = {
    total_in_scope: Number(s.total),
    validated: Number(s.validated),
    flagged_outdated: Number(s.flagged),
    project_scoped: Number(s.project_scoped),
    generic: Number(s.total) - Number(s.project_scoped),
  };

  let projectKnowledge: BriefingKnowledgeItem[] = [];
  if (project) {
    const res = await client.execute({
      sql: `SELECT id, topic, category, content, is_validated, confidence_score
            FROM technical_knowledge WHERE project_id = ?
            ORDER BY confidence_score DESC, created_at DESC LIMIT ?`,
      args: [project.id, maxItems],
    });
    projectKnowledge = res.rows.map((r: any) => ({
      id: String(r.id),
      topic: String(r.topic),
      category: r.category === null ? null : String(r.category),
      content: truncate(String(r.content), CONTENT_TRUNCATE),
      is_validated: Boolean(Number(r.is_validated)),
      confidence_score: Number(r.confidence_score),
    }));
  }

  // Generic knowledge that plausibly applies to this project's stack, found
  // via FTS on the detected stack terms. Best-effort: FTS quirks never break
  // the briefing.
  let stackHints: BriefingRecentItem[] = [];
  if (project?.detected_stack) {
    try {
      const terms: string[] = JSON.parse(project.detected_stack);
      if (Array.isArray(terms) && terms.length > 0) {
        const ftsQuery = terms.map((t) => `"${String(t).replace(/"/g, '""')}"`).join(" OR ");
        const res = await client.execute({
          sql: `SELECT tk.id, tk.topic, tk.category, tk.created_at
                FROM technical_knowledge_fts f
                JOIN technical_knowledge tk ON tk.id = f.id
                WHERE technical_knowledge_fts MATCH ? AND tk.project_id IS NULL
                LIMIT 5`,
          args: [ftsQuery],
        });
        stackHints = res.rows.map((r: any) => ({
          id: String(r.id),
          topic: String(r.topic),
          category: r.category === null ? null : String(r.category),
          created_at: String(r.created_at),
        }));
      }
    } catch (err: any) {
      console.error(`[Context Warn] Stack-hint FTS lookup failed: ${err.message}`);
    }
  }

  const recentRes = await client.execute({
    sql: `SELECT id, topic, category, created_at
          FROM technical_knowledge
          WHERE ${scopeWhere} AND created_at >= datetime('now', '-14 days')
          ORDER BY created_at DESC LIMIT 5`,
    args: scopeArgs,
  });
  const recent: BriefingRecentItem[] = recentRes.rows.map((r: any) => ({
    id: String(r.id),
    topic: String(r.topic),
    category: r.category === null ? null : String(r.category),
    created_at: String(r.created_at),
  }));

  // Episodic memory: latest session events in scope. Guarded — a briefing must
  // never fail because the observations table is missing on an old DB snapshot.
  let recentObservations: BriefingObservation[] = [];
  try {
    const res = await client.execute({
      sql: `SELECT id, kind, title, body, agent, created_at
            FROM observations
            WHERE ${scopeWhere} AND created_at >= datetime('now', '-14 days')
            ORDER BY created_at DESC, rowid DESC LIMIT 8`,
      args: scopeArgs,
    });
    recentObservations = res.rows.map((r: any) => ({
      id: String(r.id),
      kind: String(r.kind),
      title: String(r.title),
      body: truncate(String(r.body), CONTENT_TRUNCATE),
      agent: r.agent === null ? null : String(r.agent),
      created_at: String(r.created_at),
    }));
  } catch (err: any) {
    console.error(`[Context Warn] Observation lookup failed: ${err.message}`);
  }

  const outdatedRes = await client.execute({
    sql: `SELECT id, topic, last_validation_reasoning
          FROM technical_knowledge
          WHERE ${scopeWhere} AND is_validated = 0 AND last_validated_at IS NOT NULL
          ORDER BY last_validated_at DESC LIMIT 5`,
    args: scopeArgs,
  });
  const outdated: BriefingOutdatedItem[] = outdatedRes.rows.map((r: any) => ({
    id: String(r.id),
    topic: String(r.topic),
    reasoning: r.last_validation_reasoning === null ? null : truncate(String(r.last_validation_reasoning), REASONING_TRUNCATE),
  }));

  return {
    project,
    unresolved_hint: unresolvedHint,
    stats,
    project_knowledge: projectKnowledge,
    stack_hints: stackHints,
    recent,
    recent_observations: recentObservations,
    outdated,
    guidance: CAPTURE_GUIDANCE,
  };
}

/**
 * Render the briefing as compact markdown suitable for direct injection into
 * an agent's context window. Empty sections are omitted to keep it small.
 */
export function renderBriefingMarkdown(b: SessionBriefing): string {
  const lines: string[] = ["# SysQlow Session Briefing", ""];

  if (b.project) {
    let stack = "";
    try {
      const terms: string[] = JSON.parse(b.project.detected_stack ?? "[]");
      if (Array.isArray(terms) && terms.length > 0) stack = ` — stack: ${terms.join(", ")}`;
    } catch { /* unparseable stack — omit */ }
    const root = b.project.root_path ? ` (\`${b.project.root_path}\`)` : "";
    lines.push(`**Project:** ${b.project.name}${root}${stack}`);
  } else if (b.unresolved_hint) {
    lines.push(
      `**Project:** none matched hint \`${b.unresolved_hint}\` — showing generic knowledge only. ` +
      `Pass \`projectName\` (see the \`projects\` this bank knows) or call from within the workspace to register it.`
    );
  } else {
    lines.push("**Project:** none detected — showing generic knowledge only.");
  }

  lines.push(
    `**Knowledge in scope:** ${b.stats.total_in_scope} snippet(s) — ` +
    `${b.stats.project_scoped} project-scoped, ${b.stats.generic} generic; ` +
    `${b.stats.validated} validated, ${b.stats.flagged_outdated} flagged outdated.`,
    ""
  );

  if (b.project_knowledge.length > 0) {
    lines.push("## Project knowledge");
    for (const k of b.project_knowledge) {
      const badge = k.is_validated ? "✓" : "•";
      const cat = k.category ? ` [${k.category}]` : "";
      lines.push(`- ${badge} **${k.topic}**${cat} — ${k.content}`);
    }
    lines.push("");
  }

  if (b.stack_hints.length > 0) {
    lines.push("## Possibly relevant generic knowledge (stack match)");
    for (const h of b.stack_hints) {
      const cat = h.category ? ` [${h.category}]` : "";
      lines.push(`- **${h.topic}**${cat} (id: ${h.id})`);
    }
    lines.push("");
  }

  if (b.recent_observations.length > 0) {
    lines.push("## Recent session activity (14 days)");
    for (const o of b.recent_observations) {
      const agent = o.agent ? ` · ${o.agent}` : "";
      lines.push(`- \`${o.kind}\` **${o.title}** (${o.created_at}${agent}) — ${o.body}`);
    }
    lines.push("");
  }

  if (b.recent.length > 0) {
    lines.push("## Recently added knowledge (14 days)");
    for (const r of b.recent) {
      const cat = r.category ? ` [${r.category}]` : "";
      lines.push(`- **${r.topic}**${cat} — ${r.created_at}`);
    }
    lines.push("");
  }

  if (b.outdated.length > 0) {
    lines.push("## ⚠ Flagged by Sentinel (needs review)");
    for (const o of b.outdated) {
      lines.push(`- **${o.topic}** (id: ${o.id})${o.reasoning ? ` — ${o.reasoning}` : ""}`);
    }
    lines.push("");
  }

  lines.push("## Memory protocol", b.guidance);
  return lines.join("\n");
}
