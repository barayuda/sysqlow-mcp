import { createClient } from "@libsql/client";
import schemaSql from "../schema.sql" with { type: "text" };
import fs from "node:fs";
import path from "node:path";

const dbUrl = process.env.TURSO_DATABASE_URL;
const dbToken = process.env.TURSO_AUTH_TOKEN;

// Configurable local SQLite file path, defaulting to sysqlow.db in the Cwd
const localDbPath = process.env.LOCAL_DB_PATH || "sysqlow.db";

// Ensure parent directory exists for the SQLite database file
const cleanPath = localDbPath.startsWith("file:") ? localDbPath.slice(5) : localDbPath;
if (cleanPath && cleanPath !== "sysqlow.db" && !cleanPath.startsWith(":memory:")) {
  const dir = path.dirname(cleanPath);
  if (dir && dir !== "." && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const localDbUrl = localDbPath.startsWith("file:") ? localDbPath : `file:${localDbPath}`;

// Detect if we should use Turso's Embedded Replicas (local-first SQLite sync'd to cloud)
export const isEmbeddedReplica = !!(dbUrl && (dbUrl.startsWith("libsql://") || dbUrl.startsWith("https://")));

const effectiveDbMode = isEmbeddedReplica
  ? "embedded-replica-sync"
  : !dbUrl
    ? "local-only"
    : dbUrl.startsWith("file:")
      ? "local-file-url"
      : "direct-url-no-embedded-sync";

const syncTarget = isEmbeddedReplica ? dbUrl : "none";

console.error(
  `[DB Mode Guard] mode=${effectiveDbMode} | local=${localDbUrl} | syncTarget=${syncTarget}`
);

if (!isEmbeddedReplica && dbUrl && (dbUrl.startsWith("libsql://") || dbUrl.startsWith("https://")) === false) {
  console.error(
    `[DB Mode Guard] TURSO_DATABASE_URL is set but not libsql/https. Embedded replica sync is disabled.`
  );
}

if (isEmbeddedReplica && !dbToken) {
  console.error("[DB Mode Guard] Embedded replica mode detected, but TURSO_AUTH_TOKEN is missing.");
}

if (isEmbeddedReplica) {
  console.error(`Configuring database as local-first Embedded Replica (local SQLite "${localDbUrl}" synced with remote Turso)...`);
} else if (!dbUrl) {
  console.error(`TURSO_DATABASE_URL environment variable is not defined. Using standalone local SQLite database: ${localDbUrl}`);
} else {
  console.error("Using remote database directly.");
}

export const client = createClient(
  isEmbeddedReplica
    ? {
        url: localDbUrl, // Use the dynamically configured path!
        syncUrl: dbUrl!,
        authToken: dbToken,
        syncInterval: 60, // Auto-sync every 60 seconds in the background
      }
    : {
        url: dbUrl || localDbUrl,
        authToken: dbToken,
      }
);

function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inTrigger = false;
  
  const lines = sql.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("--")) {
      continue;
    }
    
    current += line + "\n";
    
    // Check if we are starting a trigger DDL
    if (trimmed.toUpperCase().includes("CREATE TRIGGER")) {
      inTrigger = true;
    }
    
    // Triggers end with END; (case insensitive check)
    if (inTrigger && trimmed.toUpperCase() === "END;") {
      statements.push(current.trim());
      current = "";
      inTrigger = false;
    } else if (!inTrigger && trimmed.endsWith(";")) {
      statements.push(current.trim());
      current = "";
    }
  }
  
  if (current.trim().length > 0) {
    statements.push(current.trim());
  }
  
  return statements;
}

export async function initDatabase() {
  try {
    // Sync replica on startup to load remote tables and data
    if (isEmbeddedReplica) {
      console.error("Synchronizing local replica with Turso cloud on startup...");
      await client.sync();
      console.error("Local replica synchronization complete.");
    }
    
    const statements = splitSqlStatements(schemaSql);
      
    if (statements.length > 0) {
      console.error("Initializing database schema...");
      // Execute DDL statements sequentially to prevent transaction conflicts with FTS/triggers in Turso
      for (const stmt of statements) {
        await client.execute(stmt);
      }
      console.error("Database schema initialized successfully.");
    }

    // Auto-migration: safely add parent_id column to existing databases if it is missing
    try {
      await client.execute("ALTER TABLE technical_knowledge ADD COLUMN parent_id TEXT REFERENCES technical_knowledge(id) ON DELETE SET NULL");
      console.error("[DB Migration] Successfully added parent_id column to existing technical_knowledge table.");
    } catch (_) {
      // Column already exists, ignore error
    }

    // Auto-migration: safely create embeddings table in existing databases if missing
    try {
      await client.execute(`
        CREATE TABLE IF NOT EXISTS technical_knowledge_embeddings (
          id TEXT PRIMARY KEY REFERENCES technical_knowledge(id) ON DELETE CASCADE,
          embedding TEXT NOT NULL
        )
      `);
      console.error("[DB Migration] Successfully verified technical_knowledge_embeddings table.");
    } catch (err: any) {
      console.error(`[DB Migration Warn] Failed to create embeddings table: ${err.message}`);
    }

    // Force replica sync to push DDL schema creations to primary cloud
    if (isEmbeddedReplica) {
      console.error("Pushing database schema changes to cloud primary...");
      await client.sync();
      console.error("Cloud synchronization complete.");
    }
  } catch (error) {
    console.error("Error initializing database schema:", error);
    throw error;
  }
}
