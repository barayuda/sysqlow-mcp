import { describe, test, expect, beforeEach } from "bun:test";
import { createClient, type Client } from "@libsql/client";

let testDb: Client;

beforeEach(async () => {
  testDb = createClient({ url: ":memory:" });
  await testDb.execute(`
    CREATE TABLE technical_knowledge (
      id TEXT PRIMARY KEY, topic TEXT, content TEXT, category TEXT,
      is_validated INTEGER DEFAULT 0, last_validated_at TIMESTAMP,
      source_url TEXT, confidence_score INTEGER DEFAULT 0,
      last_validation_reasoning TEXT, last_suggested_diff TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  await testDb.execute({
    sql: "INSERT INTO technical_knowledge (id, topic, content) VALUES (?, ?, ?)",
    args: ["test-id-1", "Test Topic", "Test content here"],
  });
});

describe("validateKnowledgeItem zero-evidence guard", () => {
  test("when webSearch returns empty AND DDG fallback is disabled, skips LLM call and marks unverifiable", async () => {
    process.env.SYSQLOW_DDG_FALLBACK = "false";
    delete process.env.TAVILY_API_KEY;
    delete process.env.SEARXNG_URL;

    const { validateKnowledgeItem } = await import("./sentinel");
    const report = await validateKnowledgeItem("test-id-1", "daemon", {
      db: testDb,
      webSearch: async () => [],
      llm: async () => { throw new Error("LLM should not be called on zero-evidence path"); },
    });

    expect(report.status).toBe("unverifiable");
    expect(report.confidence_score).toBe(0);
    expect(report.reasoning).toContain("No search evidence");

    const row = await testDb.execute({ sql: "SELECT * FROM technical_knowledge WHERE id = ?", args: ["test-id-1"] });
    expect(Number(row.rows[0].is_validated)).toBe(0);
    expect(row.rows[0].last_validation_reasoning).toContain("No search evidence");
  });
});
