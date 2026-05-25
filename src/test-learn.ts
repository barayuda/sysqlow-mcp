import { learnCodebase } from "./learn";
import { initDatabase, client } from "./db";

console.log("=== STARTING SYSQLOW-MCP CODEBASE LEARNING TEST ===");

try {
  // 1. Initialize the database schema
  await initDatabase();

  // 2. Clear old project context context snippets to start fresh
  console.log("\n🧹 Cleaning old Project Context records...");
  await client.execute({
    sql: "DELETE FROM technical_knowledge WHERE category = 'Project Context'",
    args: []
  });

  // 3. Execute learning on the current project directory (sysqlow-mcp itself!)
  const projectPath = process.cwd();
  console.log(`\n📂 Learning active codebase at: ${projectPath}`);
  
  const result = await learnCodebase(projectPath);

  console.log("\n✔ Codebase Learning Completed!");
  console.log(`🏷️  Project Name: ${result.projectName}`);
  console.log(`📄 Discovered Meta-Files: ${result.detectedFiles.join(", ")}`);
  console.log(`📦 Learned Snippets count: ${result.snippets.length}`);

  console.log("\n--- Verification from Database Query ---");
  const checkRes = await client.execute({
    sql: "SELECT topic, category FROM technical_knowledge WHERE category = 'Project Context'",
    args: []
  });
  
  console.log(`Database contains ${checkRes.rows.length} 'Project Context' rows:`);
  for (const r of checkRes.rows) {
    console.log(`  - Topic: "${r.topic}" | Category: "${r.category}"`);
  }

} catch (err: any) {
  console.error("\n❌ Codebase Learning Test Failed:", err.message);
}

console.log("\n=== STARTING SYSQLOW-MCP CODEBASE LEARNING TEST FINISHED ===");
