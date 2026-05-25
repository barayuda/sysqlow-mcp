import { client, isEmbeddedReplica } from "./db";

console.log("==========================================================");
console.log("🌱 Seeding SysQlow-MCP Meta-Blueprint into Database...");
console.log("==========================================================");

const id = crypto.randomUUID();
const topic = "SysQlow-MCP Architecture & Deployment";
const category = "DevOps";
const content = `### SysQlow-MCP: Core Architecture & Deployment Blueprint

SysQlow-MCP is an intelligent, local-first, self-validating Model Context Protocol (MCP) server.

#### 1. Local-First Embedded Replica Sync (Turso & libSQL)
Reads are executed instantly in microseconds against a local SQLite replica file. Writes are forwarded to the primary cloud instance at Turso, then synced locally.
\`\`\`typescript
import { createClient } from "@libsql/client";
const client = createClient({
  url: "file:sysqlow.db",
  syncUrl: "libsql://...",
  authToken: "...",
  syncInterval: 60
});
await client.sync();
\`\`\`
*Note: SQLite triggers and virtual tables (FTS5) DDLs must be executed sequentially outside of batch transactions to prevent LibSQL locking conflicts.*

#### 2. Native Standalone Mac Compilation
The server compiles into a standalone binary requiring no local runtime (Node/Bun) on the host Mac, using Bun's text-based compile-time assets to embed the database schema in-memory:
\`\`\`typescript
import schemaSql from "../schema.sql" with { type: "text" };
\`\`\`
Compilation Command:
\`\`\`bash
bun build ./src/index.ts --compile --outfile ./dist/sysqlow-mcp \\
  --external sury --external @valibot/to-json-schema --external effect \\
  --external arktype --external typia --external valibot
\`\`\`

#### 3. Secure Docker Deployment (Best Practice Volume Mounting)
Replicas require both '.db' and '.db-info' metadata files. Mount the parent directory to keep data persistent and secure:
\`\`\`bash
docker run -i --rm --name sysqlow-mcp \\
  -v /Users/barayuda/Projects/personal/sysqlow-mcp/data:/app/db \\
  -e TURSO_DATABASE_URL="libsql://..." \\
  -e TURSO_AUTH_TOKEN="..." \\
  -e GEMINI_API_KEY="..." \\
  sysqlow-mcp
\`\`\`

#### 4. LLM JSON Namespace Repair (Regex Lookbehind)
PHP/C++ namespaces contain backslashes that violate standard JSON values. Repair lone backslashes using a negative lookbehind regex to avoid breaking already-escaped double backslashes:
\`\`\`typescript
cleaned.replace(/(?<!\\\\)\\\\(?!["\\\\/bfnrtu])/g, "\\\\\\\\");
\`\`\`
`;

try {
  // Clear any previous blueprint entry to prevent duplicates
  await client.execute({
    sql: "DELETE FROM technical_knowledge WHERE topic = ?",
    args: [topic]
  });

  // Insert the meta blueprint
  await client.execute({
    sql: "INSERT INTO technical_knowledge (id, topic, content, category) VALUES (?, ?, ?, ?)",
    args: [id, topic, content, category]
  });

  // Sync to Turso cloud immediately
  if (isEmbeddedReplica) {
    console.log("☁️  Synchronizing database blueprint to Turso cloud...");
    await client.sync();
  }
  
  console.log("\n==========================================================");
  console.log("✔ SysQlow-MCP blueprint successfully seeded and synchronized!");
  console.log(`📌 Topic: "${topic}"`);
  console.log(`🆔 ID: ${id}`);
  console.log("==========================================================");
  process.exit(0);
} catch (error: any) {
  console.error("❌ Failed to seed metadata:", error.message);
  process.exit(1);
}
