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
