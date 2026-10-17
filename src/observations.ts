/**
 * Episodic memory — timestamped session events recorded by AI agents as they
 * work: decisions made, bugs fixed, discoveries, and end-of-session summaries.
 *
 * Complements technical_knowledge (semantic memory: timeless facts) with a
 * timeline of *what happened*, per project. The session briefing in
 * src/context.ts folds recent observations back into every session start, so
 * an agent in Cursor picks up where an agent in Claude Code left off.
 *
 * Pure DB reads/writes — zero LLM calls.
 */
import { client, isEmbeddedReplica } from "./db";
import { resolveProjectHint, type ProjectHint } from "./context";
import type { Project } from "./coherence";

export const OBSERVATION_KINDS = [
  "decision",
  "bugfix",
  "discovery",
  "change",
  "session_summary",
  "note",
] as const;
export type ObservationKind = (typeof OBSERVATION_KINDS)[number];

export type Observation = {
  id: string;
  project_id: string | null;
  session_id: string | null;
  agent: string | null;
  kind: ObservationKind;
  title: string;
  body: string;
  files: string[] | null;
  created_at: string;
};

export type RecordObservationInput = ProjectHint & {
  kind?: ObservationKind;
  title: string;
  body: string;
  sessionId?: string;
  agent?: string;
  files?: string[];
};

export async function recordObservation(input: RecordObservationInput): Promise<{ id: string; project: Project | null }> {
  const title = input.title.trim();
  const body = input.body.trim();
  if (!title || !body) throw new Error("recordObservation: title and body are both required");

  const { project } = await resolveProjectHint(input);

  const id = crypto.randomUUID();
  await client.execute({
    sql: `INSERT INTO observations (id, project_id, session_id, agent, kind, title, body, files)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      project?.id ?? null,
      input.sessionId?.trim() || null,
      input.agent?.trim() || null,
      input.kind ?? "note",
      title,
      body,
      input.files && input.files.length > 0 ? JSON.stringify(input.files) : null,
    ],
  });

  if (isEmbeddedReplica) {
    client.sync().catch((err: any) => console.error(`Replication sync error in recordObservation: ${err.message}`));
  }

  return { id, project };
}

export type TimelineOptions = ProjectHint & {
  limit?: number;
  kind?: ObservationKind;
  sinceDays?: number;
};

export type TimelineResult = {
  project: Project | null;
  unresolved_hint: string | null;
  count: number;
  items: Observation[];
};

/**
 * Chronological (newest-first) view of what happened in a project. Scope is
 * project ∪ generic, mirroring the briefing's scoping semantics.
 */
export async function getTimeline(opts: TimelineOptions = {}): Promise<TimelineResult> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const { project, unresolvedHint } = await resolveProjectHint(opts);

  const filters: string[] = [project ? "(project_id = ? OR project_id IS NULL)" : "project_id IS NULL"];
  const args: any[] = project ? [project.id] : [];

  if (opts.kind) {
    filters.push("kind = ?");
    args.push(opts.kind);
  }
  if (opts.sinceDays !== undefined && opts.sinceDays > 0) {
    filters.push(`created_at >= datetime('now', '-' || ? || ' days')`);
    args.push(Math.floor(opts.sinceDays));
  }
  args.push(limit);

  const res = await client.execute({
    sql: `SELECT id, project_id, session_id, agent, kind, title, body, files, created_at
          FROM observations
          WHERE ${filters.join(" AND ")}
          ORDER BY created_at DESC, rowid DESC
          LIMIT ?`,
    args,
  });

  const items: Observation[] = res.rows.map((r: any) => {
    let files: string[] | null = null;
    if (r.files) {
      try { files = JSON.parse(String(r.files)); } catch { /* malformed — expose as null */ }
    }
    return {
      id: String(r.id),
      project_id: r.project_id === null ? null : String(r.project_id),
      session_id: r.session_id === null ? null : String(r.session_id),
      agent: r.agent === null ? null : String(r.agent),
      kind: String(r.kind) as ObservationKind,
      title: String(r.title),
      body: String(r.body),
      files,
      created_at: String(r.created_at),
    };
  });

  return { project, unresolved_hint: unresolvedHint, count: items.length, items };
}
