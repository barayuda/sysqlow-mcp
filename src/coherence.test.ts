import { describe, test, expect } from "bun:test";
import { canRelate } from "./coherence";
import { beforeEach, afterEach } from "bun:test";
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

  beforeEach(async () => {
    process.env.LOCAL_DB_PATH = ":memory:";
    await initDatabase();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sysqlow-test-"));
  }, 30000);

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
