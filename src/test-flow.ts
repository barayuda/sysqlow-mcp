import { initDatabase, client } from "./db";
import { validateKnowledgeItem } from "./sentinel";
import { webSearch } from "./search";
import { generateEmbedding } from "./llm";

console.log("=== STARTING SYSQLOW-MCP SYSTEM FLOW TEST ===");

// 1. Initialize Database
console.log("\n[1/6] Initializing database...");
try {
  await initDatabase();
  console.log("✔ Database initialized successfully!");
} catch (e: any) {
  console.error("❌ Database initialization failed:", e.message);
  process.exit(1);
}

// 2. Perform a test insertion
console.log("\n[2/6] Inserting test snippet...");
const testId = crypto.randomUUID();
const testTopic = "Laravel 11 Rate Limiting";
const testContent = `
// Laravel 11 rate limiting setup in bootstrap/app.php
use Illuminate\\Cache\\RateLimiting\\Limit;
use Illuminate\\Support\\Facades\\RateLimiter;

RateLimiter::for('api', function (Request $request) {
    return Limit::perMinute(60)->by($request->user()?->id ?: $request->ip());
});
`;
const testCategory = "Backend";

try {
  // Clear any existing test data for this topic
  await client.execute({
    sql: "DELETE FROM technical_knowledge WHERE topic = ?",
    args: [testTopic]
  });

  await client.execute({
    sql: `INSERT INTO technical_knowledge (id, topic, content, category) 
          VALUES (?, ?, ?, ?)`,
    args: [testId, testTopic, testContent, testCategory],
  });
  console.log(`✔ Snippet inserted successfully! ID: ${testId}`);
} catch (e: any) {
  console.error("❌ Snippet insertion failed:", e.message);
}

// 3. Perform a Search / Recall test
console.log("\n[3/6] Testing recall_knowledge (FTS5 search and LIKE fallback)...");
try {
  // Query: "Laravel"
  let rows: any[] = [];
  try {
    const ftsRes = await client.execute({
      sql: `
        SELECT id, topic, category, is_validated, confidence_score 
        FROM technical_knowledge 
        WHERE id IN (
          SELECT id FROM technical_knowledge_fts WHERE technical_knowledge_fts MATCH ?
        )
      `,
      args: ["Laravel"]
    });
    rows = ftsRes.rows;
    console.log("  FTS5 Search results found:", rows.length);
  } catch (ftsError: any) {
    console.log("  FTS5 Search failed or not supported, trying LIKE search:", ftsError.message);
  }

  if (rows.length === 0) {
    const likeRes = await client.execute({
      sql: `
        SELECT id, topic, category, is_validated, confidence_score 
        FROM technical_knowledge 
        WHERE topic LIKE ? OR content LIKE ?
      `,
      args: ["%Laravel%", "%Laravel%"]
    });
    rows = likeRes.rows;
    console.log("  LIKE Search results found:", rows.length);
  }

  if (rows.length > 0) {
    console.log("✔ Recall test passed! Top result topic:", rows[0].topic);
  } else {
    console.error("❌ Recall test failed: No results found.");
  }
} catch (e: any) {
  console.error("❌ Recall test crashed:", e.message);
}

// 4. Test Search Engine Fallback
console.log("\n[4/6] Testing search fallback (DuckDuckGo scraper)...");
try {
  const searchResults = await webSearch("Laravel 11 rate limiting docs");
  console.log(`✔ Web Search retrieved ${searchResults.length} results.`);
  if (searchResults.length > 0) {
    console.log("  First result title:", searchResults[0].title);
    console.log("  First result URL:", searchResults[0].url);
  } else {
    console.warn("  ⚠ Web search retrieved 0 results (scraper might be blocked or no internet).");
  }
} catch (e: any) {
  console.error("❌ Web search failed:", e.message);
}

// 5. Test validation engine
console.log("\n[5/6] Testing Sentinel validation engine (requires GEMINI_API_KEY or OPENAI_API_KEY)...");
if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
  console.log("  ⚠ Skipped: No GEMINI_API_KEY or OPENAI_API_KEY in environment variables.");
} else {
  try {
    const report = await validateKnowledgeItem(testId);
    console.log("✔ Validation Engine finished!");
    console.log("  Status:", report.status);
    console.log("  Confidence Score:", report.confidence_score);
    console.log("  Source URL:", report.source_url);
    console.log("  Reasoning:", report.reasoning);
    console.log("  Suggested Diff:", report.suggested_diff);
  } catch (e: any) {
    console.error("❌ Validation Engine failed:", e.message);
  }
}

// 6. Test Commit Update
console.log("\n[6/6] Testing commit_update...");
const updatedContent = testContent + "\n// Updated: Tested and verified!";
try {
  await client.execute({
    sql: `UPDATE technical_knowledge 
          SET content = ?, is_validated = 1, last_validated_at = CURRENT_TIMESTAMP
          WHERE id = ?`,
    args: [updatedContent, testId]
  });
  
  // Verify it changed
  const checkRes = await client.execute({
    sql: "SELECT content, is_validated FROM technical_knowledge WHERE id = ?",
    args: [testId]
  });
  
  if (checkRes.rows.length > 0 && checkRes.rows[0].is_validated === 1) {
    console.log("✔ Commit update passed!");
  } else {
    console.error("❌ Commit update failed validation check.");
  }
} catch (e: any) {
  console.error("❌ Commit update failed:", e.message);
}

console.log("\n=== SYSQLOW-MCP SYSTEM FLOW TEST FINISHED ===");
process.exit(0);
