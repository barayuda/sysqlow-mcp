import { describe, test, expect } from "bun:test";
import { canRelate } from "./coherence";
import { beforeAll, beforeEach, afterEach } from "bun:test";
import { detectCurrentProject, _setCwdForTests, _resetCwdForTests } from "./coherence";
import { client, initDatabase } from "./db";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

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

describe("detectCurrentProject", () => {
  let tmpDir: string;

  beforeAll(async () => {
    await initDatabase();
    // Scrub any leftover rows from previous polluted runs.
    await client.execute({
      sql: "DELETE FROM projects WHERE root_path LIKE ? OR name = 'legacy-app'",
      args: ["%/sysqlow-test-%"],
    });
  }, 30000);

  beforeEach(async () => {
    process.env.LOCAL_DB_PATH = ":memory:";
    await initDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sysqlow-test-"));
  }, 30000);

  afterEach(async () => {
    _resetCwdForTests();
    // Clean up any DB rows the tests inserted to avoid polluting the live Turso DB.
    if (tmpDir) {
      await client.execute({
        sql: "DELETE FROM projects WHERE root_path = ? OR name = 'legacy-app'",
        args: [tmpDir],
      });
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 30000);

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

import { discoverRelations } from "./coherence";

describe("discoverRelations", () => {
  // Use unique project paths per test to scope cleanup tightly and avoid cross-test pollution
  // (tests run against the live Turso DB; see existing detectCurrentProject tests for the pattern).
  let testTag: string;

  beforeEach(async () => {
    await initDatabase();
    testTag = `coh-discover-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }, 60000);

  afterEach(async () => {
    // Clean up: delete relations whose endpoints are our test snippets, snippets, then projects.
    await client.execute({
      sql: `DELETE FROM knowledge_relations WHERE source_id IN
              (SELECT id FROM technical_knowledge WHERE topic LIKE ?)
            OR target_id IN
              (SELECT id FROM technical_knowledge WHERE topic LIKE ?)`,
      args: [`${testTag}-%`, `${testTag}-%`],
    });
    await client.execute({
      sql: "DELETE FROM technical_knowledge WHERE topic LIKE ?",
      args: [`${testTag}-%`],
    });
    await client.execute({
      sql: "DELETE FROM projects WHERE name LIKE ?",
      args: [`${testTag}-%`],
    });
  }, 60000);

  test("creates only within-project and generic↔project edges (no cross-project)", async () => {
    const projA = crypto.randomUUID();
    const projB = crypto.randomUUID();
    await client.execute({ sql: "INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)", args: [projA, `${testTag}-A`, `/tmp/${testTag}-A`] });
    await client.execute({ sql: "INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)", args: [projB, `${testTag}-B`, `/tmp/${testTag}-B`] });

    const emb = JSON.stringify(Array(8).fill(1));
    const seed = async (suffix: string, project_id: string | null) => {
      const id = `${testTag}-${suffix}`;
      await client.execute({
        sql: "INSERT INTO technical_knowledge (id, topic, content, project_id) VALUES (?, ?, ?, ?)",
        args: [id, `${testTag}-topic-${suffix}`, `c-${suffix}`, project_id],
      });
      await client.execute({
        sql: "INSERT INTO technical_knowledge_embeddings (id, embedding) VALUES (?, ?)",
        args: [id, emb],
      });
      return id;
    };
    const a1 = await seed("a1", projA);
    const a2 = await seed("a2", projA);
    const b1 = await seed("b1", projB);
    const b2 = await seed("b2", projB);
    const g  = await seed("g",  null);

    await discoverRelations();

    const edges = await client.execute({
      sql: `SELECT source_id, target_id FROM knowledge_relations
            WHERE source_id LIKE ? AND target_id LIKE ?`,
      args: [`${testTag}-%`, `${testTag}-%`],
    });
    const pairs = edges.rows.map(r => `${r.source_id}->${r.target_id}`);

    // No cross-project edges between A and B.
    const crossAB = pairs.filter(p =>
      (p.includes(a1) || p.includes(a2)) && (p.includes(b1) || p.includes(b2))
    );
    expect(crossAB.length).toBe(0);

    // Within-project A edges exist.
    expect(pairs.some(p => p === `${a1}->${a2}` || p === `${a2}->${a1}`)).toBe(true);
    // Generic↔project edges exist (at least one).
    expect(pairs.some(p => p.startsWith(`${g}->`) || p.endsWith(`->${g}`))).toBe(true);
  }, 120000);

  test("the DB trigger rejects a direct cross-project insert", async () => {
    const projA = crypto.randomUUID();
    const projB = crypto.randomUUID();
    await client.execute({ sql: "INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)", args: [projA, `${testTag}-A`, `/tmp/${testTag}-A`] });
    await client.execute({ sql: "INSERT INTO projects (id, name, root_path) VALUES (?, ?, ?)", args: [projB, `${testTag}-B`, `/tmp/${testTag}-B`] });
    const x = `${testTag}-x`;
    const y = `${testTag}-y`;
    await client.execute({ sql: "INSERT INTO technical_knowledge (id, topic, content, project_id) VALUES (?, ?, ?, ?)", args: [x, `${testTag}-tx`, "cx", projA] });
    await client.execute({ sql: "INSERT INTO technical_knowledge (id, topic, content, project_id) VALUES (?, ?, ?, ?)", args: [y, `${testTag}-ty`, "cy", projB] });

    let threw = false;
    try {
      await client.execute({
        sql: "INSERT INTO knowledge_relations (id, source_id, target_id, relation_type, weight) VALUES (?, ?, ?, 'manual', 1.0)",
        args: [crypto.randomUUID(), x, y],
      });
    } catch (err: any) {
      threw = true;
      expect(String(err.message)).toContain("context_isolation_violation");
    }
    expect(threw).toBe(true);
  }, 60000);
});
