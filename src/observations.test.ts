import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import { client, initDatabase } from "./db";
import { recordObservation, getTimeline } from "./observations";
import { buildSessionBriefing } from "./context";

/**
 * Live-DB test pattern (see coherence.test.ts): unique per-test tag, cleanup
 * in afterEach.
 */
describe("episodic observations", () => {
  let tag: string;
  let projId: string;

  beforeAll(async () => {
    await initDatabase();
  }, 30000);

  beforeEach(async () => {
    tag = `obs-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    projId = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)",
      args: [projId, `${tag}-proj`, `/tmp/${tag}-proj`],
    });
  }, 30000);

  afterEach(async () => {
    await client.execute({ sql: "DELETE FROM observations WHERE title LIKE ?", args: [`${tag}%`] });
    await client.execute({ sql: "DELETE FROM projects WHERE name LIKE ?", args: [`${tag}%`] });
  }, 30000);

  test("recordObservation stores a project-scoped event", async () => {
    const { id, project } = await recordObservation({
      projectId: projId,
      kind: "decision",
      title: `${tag} chose SearXNG`,
      body: "Tavily quota is limited; SearXNG is keyless.",
      agent: "claude-code",
      files: ["src/search.ts"],
    });

    expect(project?.id).toBe(projId);
    const row = await client.execute({ sql: "SELECT * FROM observations WHERE id = ?", args: [id] });
    expect(row.rows.length).toBe(1);
    expect(String(row.rows[0].kind)).toBe("decision");
    expect(String(row.rows[0].project_id)).toBe(projId);
    expect(JSON.parse(String(row.rows[0].files))).toEqual(["src/search.ts"]);
  }, 30000);

  test("recordObservation rejects empty title/body", async () => {
    await expect(
      recordObservation({ projectId: projId, title: "  ", body: "x" }),
    ).rejects.toThrow("title and body");
  }, 30000);

  test("getTimeline returns newest-first, scoped to project ∪ generic", async () => {
    const otherProj = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)",
      args: [otherProj, `${tag}-other`, `/tmp/${tag}-other`],
    });

    await recordObservation({ projectId: projId, kind: "bugfix", title: `${tag} first`, body: "b1" });
    await recordObservation({ projectId: projId, kind: "decision", title: `${tag} second`, body: "b2" });
    await recordObservation({ projectId: otherProj, kind: "note", title: `${tag} foreign`, body: "b3" });

    const timeline = await getTimeline({ projectId: projId, limit: 50 });
    const mine = timeline.items.filter((i) => i.title.startsWith(tag));

    expect(mine.map((i) => i.title)).toEqual([`${tag} second`, `${tag} first`]);
    expect(mine.some((i) => i.title === `${tag} foreign`)).toBe(false);
  }, 60000);

  test("getTimeline filters by kind", async () => {
    await recordObservation({ projectId: projId, kind: "bugfix", title: `${tag} bug`, body: "b" });
    await recordObservation({ projectId: projId, kind: "session_summary", title: `${tag} summary`, body: "s" });

    const timeline = await getTimeline({ projectId: projId, kind: "session_summary", limit: 50 });
    const mine = timeline.items.filter((i) => i.title.startsWith(tag));

    expect(mine.length).toBe(1);
    expect(mine[0].title).toBe(`${tag} summary`);
  }, 60000);

  test("session briefing includes recent observations", async () => {
    await recordObservation({
      projectId: projId,
      kind: "session_summary",
      title: `${tag} wrapped up auth work`,
      body: "Implemented JWT refresh; next step is rate limiting.",
      agent: "cursor",
    });

    const briefing = await buildSessionBriefing({ projectId: projId });
    const found = briefing.recent_observations.find((o) => o.title === `${tag} wrapped up auth work`);

    expect(found).toBeDefined();
    expect(found?.kind).toBe("session_summary");
    expect(found?.agent).toBe("cursor");
  }, 60000);
});
