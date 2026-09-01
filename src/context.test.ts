import { describe, test, expect, beforeAll, beforeEach, afterEach } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { client, initDatabase } from "./db";
import { resolveProjectHint, buildSessionBriefing, renderBriefingMarkdown } from "./context";

/**
 * Tests run against the live configured DB (same pattern as coherence.test.ts):
 * every row is tagged with a unique per-test prefix and cleaned up in afterEach.
 */
describe("session context briefing", () => {
  let tag: string;
  let tmpDir: string;

  beforeAll(async () => {
    await initDatabase();
  }, 30000);

  beforeEach(() => {
    tag = `ctx-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sysqlow-ctx-"));
  });

  afterEach(async () => {
    await client.execute({
      sql: "DELETE FROM technical_knowledge WHERE topic LIKE ?",
      args: [`${tag}%`],
    });
    await client.execute({
      sql: "DELETE FROM projects WHERE name LIKE ? OR root_path = ?",
      args: [`${tag}%`, tmpDir],
    });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30000);

  const seedProject = async (suffix: string, rootPath: string | null) => {
    const id = crypto.randomUUID();
    await client.execute({
      sql: "INSERT INTO projects (id, name, root_path, detected_stack) VALUES (?, ?, ?, ?)",
      args: [id, `${tag}-${suffix}`, rootPath, JSON.stringify(["node", "typescript"])],
    });
    return id;
  };

  const seedSnippet = async (
    suffix: string,
    projectId: string | null,
    opts: { validated?: boolean; flagged?: string; category?: string; confidence?: number } = {},
  ) => {
    const id = crypto.randomUUID();
    await client.execute({
      sql: `INSERT INTO technical_knowledge
              (id, topic, content, category, project_id, is_validated, confidence_score,
               last_validated_at, last_validation_reasoning)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        id,
        `${tag}-topic-${suffix}`,
        `content for ${suffix}`,
        opts.category ?? "Project Context",
        projectId,
        opts.validated === false || opts.flagged ? 0 : 1,
        opts.confidence ?? 8,
        opts.flagged ? new Date().toISOString() : null,
        opts.flagged ?? null,
      ],
    });
    return id;
  };

  test("resolveProjectHint: finds by projectId", async () => {
    const pid = await seedProject("byid", `/tmp/${tag}-byid`);
    const { project, unresolvedHint } = await resolveProjectHint({ projectId: pid });
    expect(project?.id).toBe(pid);
    expect(unresolvedHint).toBeNull();
  }, 30000);

  test("resolveProjectHint: detects by filesystem path and creates the row", async () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: `${tag}-fresh` }));
    const { project } = await resolveProjectHint({ projectPath: tmpDir });
    expect(project?.name).toBe(`${tag}-fresh`);
    expect(project?.root_path).toBe(tmpDir);
  }, 30000);

  test("resolveProjectHint: falls back to DB root_path when path is not on this filesystem", async () => {
    const ghostPath = `/nonexistent/${tag}/workspace`;
    const pid = await seedProject("ghost", ghostPath);
    const { project } = await resolveProjectHint({ projectPath: ghostPath });
    expect(project?.id).toBe(pid);
  }, 30000);

  test("resolveProjectHint: finds by name (case-insensitive)", async () => {
    const pid = await seedProject("Named", null);
    const { project } = await resolveProjectHint({ projectName: `${tag}-named`.toUpperCase() });
    expect(project?.id).toBe(pid);
  }, 30000);

  test("resolveProjectHint: explicit unmatched hint does NOT fall back to server cwd", async () => {
    const { project, unresolvedHint } = await resolveProjectHint({
      projectPath: `/nope/${tag}/never-existed`,
    });
    expect(project).toBeNull();
    expect(unresolvedHint).toBe(`/nope/${tag}/never-existed`);
  }, 30000);

  test("briefing scopes to project ∪ generic and excludes other projects", async () => {
    const projA = await seedProject("A", `/tmp/${tag}-A`);
    const projB = await seedProject("B", `/tmp/${tag}-B`);
    const aSnip = await seedSnippet("a1", projA);
    const bSnip = await seedSnippet("b1", projB);
    await seedSnippet("gen", null, { category: "Backend" });

    const briefing = await buildSessionBriefing({ projectId: projA });

    const ids = briefing.project_knowledge.map((k) => k.id);
    expect(ids).toContain(aSnip);
    expect(ids).not.toContain(bSnip);
    expect(briefing.project?.id).toBe(projA);
    expect(briefing.stats.project_scoped).toBe(1);
    expect(briefing.stats.total_in_scope).toBeGreaterThanOrEqual(2);
  }, 60000);

  test("briefing surfaces Sentinel-flagged items with reasoning", async () => {
    const projA = await seedProject("F", `/tmp/${tag}-F`);
    const flaggedId = await seedSnippet("stale", projA, {
      flagged: "The API described here was deprecated in v3.",
    });

    const briefing = await buildSessionBriefing({ projectId: projA });

    const flagged = briefing.outdated.find((o) => o.id === flaggedId);
    expect(flagged).toBeDefined();
    expect(flagged?.reasoning).toContain("deprecated in v3");
    expect(briefing.stats.flagged_outdated).toBeGreaterThanOrEqual(1);
  }, 60000);

  test("briefing respects maxItems", async () => {
    const projA = await seedProject("M", `/tmp/${tag}-M`);
    for (let i = 0; i < 5; i++) await seedSnippet(`m${i}`, projA);

    const briefing = await buildSessionBriefing({ projectId: projA, maxItems: 2 });
    expect(briefing.project_knowledge.length).toBe(2);
  }, 60000);

  test("markdown render contains project name, knowledge, flags, and the capture protocol", async () => {
    const projA = await seedProject("R", `/tmp/${tag}-R`);
    await seedSnippet("r1", projA);
    await seedSnippet("r2", projA, { flagged: "outdated because reasons" });

    const md = renderBriefingMarkdown(await buildSessionBriefing({ projectId: projA }));

    expect(md).toContain("# SysQlow Session Briefing");
    expect(md).toContain(`${tag}-R`);
    expect(md).toContain(`${tag}-topic-r1`);
    expect(md).toContain("Flagged by Sentinel");
    expect(md).toContain("Memory protocol");
    expect(md).toContain("knowledge_workflow");
  }, 60000);

  test("markdown render notes an unresolved hint and stays generic-only", async () => {
    const md = renderBriefingMarkdown(
      await buildSessionBriefing({ projectPath: `/nope/${tag}/ghost` }),
    );
    expect(md).toContain("none matched hint");
    expect(md).toContain(`/nope/${tag}/ghost`);
  }, 30000);
});
