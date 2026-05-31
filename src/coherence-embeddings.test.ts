import { describe, test, expect } from "bun:test";
import { createClient } from "@libsql/client";
import { ensureBudgetSchema } from "./llm-budget";
import { selectMissingEmbeddingIds } from "./coherence";

describe("selectMissingEmbeddingIds", () => {
  test("returns only rows lacking an embedding, capped to limit", async () => {
    const db = createClient({ url: ":memory:" });
    await ensureBudgetSchema(db);
    // include created_at so the selector's ORDER BY created_at works (matches production schema)
    await db.execute(`CREATE TABLE technical_knowledge (id TEXT PRIMARY KEY, topic TEXT, content TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`);
    await db.execute(`CREATE TABLE technical_knowledge_embeddings (id TEXT PRIMARY KEY, embedding TEXT)`);
    for (const id of ["a", "b", "c"]) {
      await db.execute({ sql: `INSERT INTO technical_knowledge (id, topic, content) VALUES (?, ?, ?)`, args: [id, id, id] });
    }
    await db.execute({ sql: `INSERT INTO technical_knowledge_embeddings (id, embedding) VALUES (?, ?)`, args: ["b", "[]"] });

    const ids = await selectMissingEmbeddingIds(2, db);
    expect(ids.sort()).toEqual(["a", "c"]); // b excluded; cap 2 keeps both
  });
});
