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
  if (!existsSync(projectPath)) {
    throw new Error(`Project path "${projectPath}" does not exist.`);
  }

  const filesInRoot = readdirSync(projectPath);
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
  let projectName = basename(projectPath) || "Current Project";

  // Check if we can extract a better project name from package.json
  if (filesInRoot.includes("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(projectPath, "package.json"), "utf8"));
      if (pkg.name) {
        projectName = pkg.name;
      }
    } catch (_) {}
  } else if (filesInRoot.includes("composer.json")) {
    try {
      const comp = JSON.parse(readFileSync(join(projectPath, "composer.json"), "utf8"));
      if (comp.name) {
        projectName = comp.name;
      }
    } catch (_) {}
  }

  for (const filename of targetFiles) {
    if (filesInRoot.includes(filename)) {
      const fullPath = join(projectPath, filename);
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
  for (const item of snippets) {
    const id = crypto.randomUUID();
    await client.execute({
      sql: `INSERT INTO technical_knowledge (id, topic, content, category, is_validated, confidence_score) 
            VALUES (?, ?, ?, ?, 1, 10)`,
      args: [id, item.topic, item.content, item.category],
    });
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
