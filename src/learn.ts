import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, basename } from "path";
import { analyzeCodebaseWithLLM, LearnedKnowledgeItem } from "./llm";
import { client, isEmbeddedReplica } from "./db";

export interface CodebaseAnalysisResult {
  projectName: string;
  detectedFiles: string[];
  snippets: LearnedKnowledgeItem[];
}

export async function learnCodebase(projectPath: string): Promise<CodebaseAnalysisResult> {
  let resolvedPath = projectPath;
  
  // Smart container fallback: If the requested path is a host path for the current project
  // and does not exist inside the sandbox, resolve it directly to the container's working directory
  if (!existsSync(resolvedPath)) {
    const isDocker = existsSync("/.dockerenv") || existsSync("/proc/1/cgroup") && readFileSync("/proc/1/cgroup", "utf8").includes("docker");
    if (isDocker && (basename(resolvedPath) === "sysqlow-mcp" || basename(resolvedPath) === basename(process.cwd()))) {
      console.error(`[SysQlow Info] Resolving isolated host path "${resolvedPath}" to container directory "${process.cwd()}"...`);
      resolvedPath = process.cwd();
    }
  }

  if (!existsSync(resolvedPath)) {
    console.error(`[SysQlow Warn] Project path "${resolvedPath}" does not exist inside the server filesystem.`);
    
    // Check if we are running in a Docker container
    const isDocker = existsSync("/.dockerenv") || existsSync("/proc/1/cgroup") && readFileSync("/proc/1/cgroup", "utf8").includes("docker");
    if (isDocker) {
      console.error(
        `[SysQlow Info] Server is running within a Docker container. The client's host path "${resolvedPath}" is isolated and not mounted inside this container.\n` +
        `To automatically scan your codebase, either:\n` +
        `  1. Bind-mount your project folder into the Docker run command (e.g. -v /Users/...:/Users/...)\n` +
        `  2. Run the MCP server natively on your host machine using Bun in SSE transport mode.`
      );
    }
    
    return {
      projectName: basename(resolvedPath) || "Current Project",
      detectedFiles: [],
      snippets: []
    };
  }

  const filesInRoot = readdirSync(resolvedPath);
  const targetFiles = [
    "package.json",
    "composer.json",
    "Cargo.toml",
    "go.mod",
    "pyproject.toml",
    "requirements.txt",
    "README.md",
    ".env.example",
    "tsconfig.json"
  ];

  const detectedFiles: string[] = [];
  let collectedContent = "";
  let projectName = basename(resolvedPath) || "Current Project";

  // Check if we can extract a better project name from package.json
  if (filesInRoot.includes("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(resolvedPath, "package.json"), "utf8"));
      if (pkg.name) {
        projectName = pkg.name;
      }
    } catch (_) {}
  } else if (filesInRoot.includes("composer.json")) {
    try {
      const comp = JSON.parse(readFileSync(join(resolvedPath, "composer.json"), "utf8"));
      if (comp.name) {
        projectName = comp.name;
      }
    } catch (_) {}
  }

  for (const filename of targetFiles) {
    if (filesInRoot.includes(filename)) {
      const fullPath = join(resolvedPath, filename);
      try {
        const stats = statSync(fullPath);
        if (stats.isFile()) {
          detectedFiles.push(filename);
          // Limit file read to 6KB to prevent token bloating
          let content = readFileSync(fullPath, "utf8");
          if (content.length > 6000) {
            content = content.substring(0, 6000) + "\n\n[... content truncated for brevity ...]";
          }
          collectedContent += `=== FILE: ${filename} ===\n${content}\n\n`;
        }
      } catch (err: any) {
        console.error(`Failed to read file ${filename}: ${err.message}`);
      }
    }
  }

  if (detectedFiles.length === 0) {
    return {
      projectName,
      detectedFiles: [],
      snippets: []
    };
  }

  // Analyze metadata using Gemini
  console.error(`Analyzing project context for "${projectName}" using Gemini...`);
  const snippets = await analyzeCodebaseWithLLM(projectName, collectedContent);

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

    if (Number(updateRes.rowsAffected ?? 0) === 0) {
      const id = crypto.randomUUID();
      await client.execute({
        sql: `INSERT INTO technical_knowledge (id, topic, content, category, is_validated, confidence_score)
              VALUES (?, ?, ?, ?, 1, 10)`,
        args: [id, item.topic, item.content, normalizedCategory],
      });
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
