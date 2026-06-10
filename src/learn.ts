import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { analyzeCodebaseWithLLM, LearnedKnowledgeItem, generateEmbedding } from "./llm";
import { client, isEmbeddedReplica } from "./db";

export interface CodebaseAnalysisResult {
  projectName: string;
  detectedFiles: string[];
  snippets: LearnedKnowledgeItem[];
}

export interface CollectedFile {
  filename: string;
  content: string;
  truncated: boolean;
}

export interface CollectedCodebase {
  projectName: string;
  resolvedPath: string;
  detectedFiles: string[];
  files: CollectedFile[];
  // Pre-concatenated FILE-delimited blob, kept for callers (learnCodebase
  // → analyzeCodebaseWithLLM) that prefer a single prompt-ready string.
  combinedContent: string;
  // Diagnostic — true when the requested path doesn't exist inside this
  // process's filesystem AND we appear to be running in Docker. Callers can
  // surface this directly instead of guessing.
  isDockerIsolated: boolean;
}

const TARGET_MANIFESTS = [
  "package.json",
  "composer.json",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "README.md",
  ".env.example",
  "tsconfig.json",
];

function isRunningInDocker(): boolean {
  try {
    if (existsSync("/.dockerenv")) return true;
    if (existsSync("/proc/1/cgroup")) {
      return readFileSync("/proc/1/cgroup", "utf8").includes("docker");
    }
  } catch (_) {}
  return false;
}

/**
 * Read project manifest/README files at `projectPath` and return their raw
 * contents. Performs zero LLM calls and zero DB writes — safe to call from
 * an MCP tool whose contract is "hand the bytes back to the client agent
 * for analysis." Used as the file-collection step inside `learnCodebase`
 * and exposed standalone via the `collect_codebase_files` MCP tool so the
 * calling agent can do the cognitive work on its own model instead of
 * burning sysqlow's Gemini quota.
 */
export async function collectCodebaseFiles(projectPath: string): Promise<CollectedCodebase> {
  let resolvedPath = projectPath;
  const inDocker = isRunningInDocker();

  // Smart container fallback: If the requested path is a host path for the current project
  // and does not exist inside the sandbox, resolve it directly to the container's working directory
  if (!existsSync(resolvedPath)) {
    if (inDocker && (basename(resolvedPath) === "sysqlow-mcp" || basename(resolvedPath) === basename(process.cwd()))) {
      console.error(`[SysQlow Info] Resolving isolated host path "${resolvedPath}" to container directory "${process.cwd()}"...`);
      resolvedPath = process.cwd();
    }
  }

  if (!existsSync(resolvedPath)) {
    console.error(`[SysQlow Warn] Project path "${resolvedPath}" does not exist inside the server filesystem.`);
    if (inDocker) {
      console.error(
        `[SysQlow Info] Server is running within a Docker container. The client's host path "${resolvedPath}" is isolated and not mounted inside this container.\n` +
        `Either restart with SYSQLOW_WORKSPACE_ROOTS=<path>, place the project under one of the auto-probed roots, or run sysqlow-mcp natively (see docs/running-natively.md).`
      );
    }
    return {
      projectName: basename(resolvedPath) || "Current Project",
      resolvedPath,
      detectedFiles: [],
      files: [],
      combinedContent: "",
      isDockerIsolated: inDocker,
    };
  }

  const filesInRoot = readdirSync(resolvedPath);
  let projectName = basename(resolvedPath) || "Current Project";

  // Prefer the manifest-declared project name over the directory basename.
  if (filesInRoot.includes("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(resolvedPath, "package.json"), "utf8"));
      if (pkg.name) projectName = pkg.name;
    } catch (_) {}
  } else if (filesInRoot.includes("composer.json")) {
    try {
      const comp = JSON.parse(readFileSync(join(resolvedPath, "composer.json"), "utf8"));
      if (comp.name) projectName = comp.name;
    } catch (_) {}
  }

  const detectedFiles: string[] = [];
  const files: CollectedFile[] = [];
  let combinedContent = "";

  for (const filename of TARGET_MANIFESTS) {
    if (!filesInRoot.includes(filename)) continue;
    const fullPath = join(resolvedPath, filename);
    try {
      const stats = statSync(fullPath);
      if (!stats.isFile()) continue;
      detectedFiles.push(filename);
      // Cap each file at 6KB to keep both the LLM prompt and the MCP-client
      // response payload bounded.
      const raw = readFileSync(fullPath, "utf8");
      const truncated = raw.length > 6000;
      const content = truncated
        ? raw.substring(0, 6000) + "\n\n[... content truncated for brevity ...]"
        : raw;
      files.push({ filename, content, truncated });
      combinedContent += `=== FILE: ${filename} ===\n${content}\n\n`;
    } catch (err: any) {
      console.error(`Failed to read file ${filename}: ${err.message}`);
    }
  }

  return {
    projectName,
    resolvedPath,
    detectedFiles,
    files,
    combinedContent,
    isDockerIsolated: false,
  };
}

export async function learnCodebase(projectPath: string): Promise<CodebaseAnalysisResult> {
  const collected = await collectCodebaseFiles(projectPath);
  const { projectName, detectedFiles, combinedContent } = collected;

  if (detectedFiles.length === 0) {
    return { projectName, detectedFiles: [], snippets: [] };
  }

  // Analyze metadata using Gemini
  console.error(`Analyzing project context for "${projectName}" using Gemini...`);
  const snippets = await analyzeCodebaseWithLLM(projectName, combinedContent);

  // Store snippets in SQLite
  console.error(`Storing ${snippets.length} learned snippets in the database...`);
  
  // Prevent duplication and stale context: clean up existing automated snippets matching this project prefix first
  try {
    const deleteRes = await client.execute({
      sql: `DELETE FROM technical_knowledge 
            WHERE category = 'Project Context' 
              AND (topic LIKE ? OR topic = ?)`,
      args: [`${projectName}:%`, projectName],
    });
    if (Number(deleteRes.rowsAffected ?? 0) > 0) {
      console.error(`Cleaned up ${deleteRes.rowsAffected} existing project context snippets for "${projectName}" to prevent duplication.`);
    }
  } catch (err: any) {
    console.error(`Warning: Failed to clean up old project context snippets: ${err.message}`);
  }

  for (const item of snippets) {
    const normalizedCategory = item.category?.trim() || "Project Context";

    // Keep auto-learn idempotent across reconnects/restarts by updating existing topic/category rows.
    const updateRes = await client.execute({
      sql: `UPDATE technical_knowledge
            SET content = ?,
                is_validated = 1,
                confidence_score = 10,
                last_validated_at = CURRENT_TIMESTAMP
            WHERE topic = ? AND category = ?`,
      args: [item.content, item.topic, normalizedCategory],
    });

    let targetId = "";
    if (Number(updateRes.rowsAffected ?? 0) > 0) {
      const row = await client.execute({
        sql: "SELECT id FROM technical_knowledge WHERE topic = ? AND category = ?",
        args: [item.topic, normalizedCategory]
      });
      if (row.rows.length > 0) {
        targetId = String(row.rows[0].id);
      }
    } else {
      const id = crypto.randomUUID();
      await client.execute({
        sql: `INSERT INTO technical_knowledge (id, topic, content, category, is_validated, confidence_score)
              VALUES (?, ?, ?, ?, 1, 10)`,
        args: [id, item.topic, item.content, normalizedCategory],
      });
      targetId = id;
    }

    if (targetId) {
      generateAndSaveEmbedding(targetId, item.topic, item.content).catch(() => {});
    }
  }

  // Force replica sync to push to Turso cloud
  if (isEmbeddedReplica) {
    console.error("Triggering replication sync to Turso cloud...");
    client.sync().catch((err: any) => console.error(`Replication sync error in learnCodebase: ${err.message}`));
  }

  return {
    projectName,
    detectedFiles,
    snippets
  };
}

async function generateAndSaveEmbedding(id: string, topic: string, content: string) {
  try {
    const vector = await generateEmbedding(`${topic}\n${content}`);
    if (vector && vector.length > 0) {
      await client.execute({
        sql: "INSERT OR REPLACE INTO technical_knowledge_embeddings (id, embedding) VALUES (?, ?)",
        args: [id, JSON.stringify(vector)]
      });
    }
  } catch (err: any) {
    console.error(`[Embedding Auto] Failed to generate embedding for topic "${topic}": ${err.message}`);
  }
}
