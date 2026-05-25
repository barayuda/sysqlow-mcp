import { FastMCP } from "fastmcp";
import { z } from "zod";
import { initDatabase, client, isEmbeddedReplica } from "./db";
import { validateKnowledgeItem } from "./sentinel";
import { learnCodebase } from "./learn";
import { dashboardHtml } from "./dashboard-html";

// 0. Intercept console logs to populate in-memory logs ring buffer for the admin dashboard
export const logsRingBuffer: string[] = [];
const maxLogs = 200;

const originalLog = console.log;
const originalError = console.error;

const addToBuffer = (type: "info" | "error", args: any[]) => {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [${type.toUpperCase()}] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" ")}`;
  logsRingBuffer.push(line);
  if (logsRingBuffer.length > maxLogs) {
    logsRingBuffer.shift();
  }
};

console.log = (...args: any[]) => {
  addToBuffer("info", args);
  originalLog(...args);
};

console.error = (...args: any[]) => {
  const logStr = args.map(a => typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ").toLowerCase();
  
  // Smart heuristic: FastMCP/LibSQL outputs startup and diagnostic information to stderr.
  // We classify it as info if it contains standard status keywords and no actual error terms.
  const hasErrorKeywords = ["error", "fail", "exception", "warn", "lock", "conflict"].some(kw => logStr.includes(kw));
  const hasStatusKeywords = ["start", "listen", "run", "sync", "replica", "schema", "init", "success", "connect", "check"].some(kw => logStr.includes(kw));
  
  const type = (!hasErrorKeywords && hasStatusKeywords) ? "info" : "error";
  
  addToBuffer(type, args);
  originalError(...args);
};

// 1. Initialize the database schema
try {
  await initDatabase();
} catch (e: any) {
  console.error("Failed to initialize database on startup:", e.message);
}

// 2. Initialize FastMCP server
const server = new FastMCP({
  name: "sysqlow-mcp",
  version: "1.0.0",
});

function buildSafeFtsQuery(rawQuery: string): string {
  // Remove punctuation that commonly breaks FTS5 parser, then require all terms.
  const normalized = rawQuery.replace(/[^\w\s-]+/g, " ").trim();
  const terms = normalized.split(/\s+/).filter(Boolean);

  if (terms.length === 0) {
    const escapedRaw = rawQuery.replace(/"/g, '""');
    return `"${escapedRaw}"`;
  }

  return terms
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" AND ");
}

// Tool 1: store_knowledge
server.addTool({
  name: "store_knowledge",
  description: "Persists a new technical snippet into the Turso database.",
  parameters: z.object({
    topic: z.string().describe("The subject of the technical knowledge (e.g., 'Laravel Rate Limiting')"),
    content: z.string().describe("The actual technical snippet, command, code block, or explanation"),
    category: z.string().optional().describe("Optional category to organize knowledge (e.g., 'Backend', 'Frontend', 'DevOps')"),
  }),
  execute: async (args) => {
    const id = crypto.randomUUID();
    const topic = args.topic.trim();
    const content = args.content.trim();
    const category = args.category?.trim() || null;
    
    try {
      await client.execute({
        sql: `INSERT INTO technical_knowledge (id, topic, content, category) 
              VALUES (?, ?, ?, ?)`,
        args: [id, topic, content, category],
      });
      
      // Sync replica with Turso in the background
      if (isEmbeddedReplica) {
        client.sync().catch((err: any) => console.error(`Replication sync error in store: ${err.message}`));
      }
      
      return JSON.stringify({
        status: "success",
        message: "Technical snippet stored successfully.",
        id,
        topic,
        category
      }, null, 2);
    } catch (error: any) {
      console.error(`Error in store_knowledge: ${error.message}`);
      return `Failed to store knowledge snippet: ${error.message}`;
    }
  }
});

// Tool 2: recall_knowledge
server.addTool({
  name: "recall_knowledge",
  description: "Searches and recalls stored technical snippets using Full-Text Search (FTS) with keyword fallback.",
  parameters: z.object({
    query: z.string().describe("The search term or query to find snippets (e.g., 'rate limit')"),
    category: z.string().optional().describe("Optional category to filter results"),
  }),
  execute: async (args) => {
    const query = args.query.trim();
    const category = args.category?.trim() || null;
    
    try {
      let rows: any[] = [];
      
      // If query is "*" or empty, retrieve all knowledge snippets
      if (query === "*" || query === "") {
        let sql = `
          SELECT id, topic, content, category, is_validated, last_validated_at, source_url, confidence_score 
          FROM technical_knowledge
        `;
        const sqlArgs: any[] = [];
        
        if (category) {
          sql += " WHERE category = ?";
          sqlArgs.push(category);
        }
        
        sql += " ORDER BY created_at DESC";
        
        const res = await client.execute({ sql, args: sqlArgs });
        rows = res.rows;
      } else {
        // Try FTS5 MATCH first
        try {
          const safeFtsQuery = buildSafeFtsQuery(query);
          let ftsSql = `
            SELECT id, topic, content, category, is_validated, last_validated_at, source_url, confidence_score 
            FROM technical_knowledge 
            WHERE id IN (
              SELECT id FROM technical_knowledge_fts WHERE technical_knowledge_fts MATCH ?
            )
          `;
          const ftsArgs: any[] = [safeFtsQuery];
          
          if (category) {
            ftsSql += " AND category = ?";
            ftsArgs.push(category);
          }
          
          const ftsRes = await client.execute({ sql: ftsSql, args: ftsArgs });
          rows = ftsRes.rows;
        } catch (ftsError: any) {
          console.error("FTS search failed or was not initialized, falling back to LIKE search:", ftsError.message);
        }
        
        // Fallback to LIKE search if FTS returned nothing or threw an error
        if (rows.length === 0) {
          let likeSql = `
            SELECT id, topic, content, category, is_validated, last_validated_at, source_url, confidence_score 
            FROM technical_knowledge 
            WHERE (topic LIKE ? OR content LIKE ? OR category LIKE ?)
          `;
          const likeArgs: any[] = [`%${query}%`, `%${query}%`, `%${query}%`];
          
          if (category) {
            likeSql += " AND category = ?";
            likeArgs.push(category);
          }
          
          const likeRes = await client.execute({ sql: likeSql, args: likeArgs });
          rows = likeRes.rows;
        }
      }
      
      if (rows.length === 0) {
        return `No snippets found matching query "${query}"${category ? ` in category "${category}"` : ""}.`;
      }
      
      const formattedResults = rows.map((r, idx) => {
        return `--- Result [${idx + 1}] ---\nID: ${r.id}\nTopic: ${r.topic}\nCategory: ${r.category || "None"}\nValidated: ${r.is_validated ? "Yes" : "No"}\nLast Validated At: ${r.last_validated_at}\nConfidence Score: ${r.confidence_score}/10\nSource URL: ${r.source_url || "N/A"}\n\nContent:\n${r.content}\n`;
      }).join("\n");
      
      return formattedResults;
    } catch (error: any) {
      console.error(`Error in recall_knowledge: ${error.message}`);
      return `Error retrieving technical knowledge: ${error.message}`;
    }
  }
});

// Tool 3: validate_knowledge
server.addTool({
  name: "validate_knowledge",
  description: "Triggers validation engine to cross-reference a snippet's relevance and accuracy against live web docs.",
  parameters: z.object({
    id: z.string().describe("The UUID of the stored snippet to validate"),
  }),
  execute: async (args) => {
    const id = args.id.trim();
    
    try {
      const report = await validateKnowledgeItem(id);
      
      return JSON.stringify({
        id,
        status: report.status,
        confidence_score: report.confidence_score,
        source_url: report.source_url,
        reasoning: report.reasoning,
        suggested_diff: report.suggested_diff
      }, null, 2);
    } catch (error: any) {
      console.error(`Error in validate_knowledge for ID "${id}": ${error.message}`);
      return `Validation failed: ${error.message}`;
    }
  }
});

// Tool 4: commit_update
server.addTool({
  name: "commit_update",
  description: "Applies validated updates or corrections to a stored snippet (requires human-in-the-loop review).",
  parameters: z.object({
    id: z.string().describe("The UUID of the snippet to update"),
    content: z.string().describe("The complete new content of the snippet to save"),
  }),
  execute: async (args) => {
    const id = args.id.trim();
    const content = args.content.trim();
    
    try {
      // 1. Verify existence
      const checkRes = await client.execute({
        sql: "SELECT topic FROM technical_knowledge WHERE id = ?",
        args: [id]
      });
      
      if (checkRes.rows.length === 0) {
        return `Error: Snippet with ID "${id}" does not exist.`;
      }
      
      const topic = checkRes.rows[0].topic as string;
      
      // 2. Perform the update and mark validated
      await client.execute({
        sql: `UPDATE technical_knowledge 
              SET content = ?, 
                  is_validated = 1, 
                  last_validated_at = CURRENT_TIMESTAMP 
              WHERE id = ?`,
        args: [content, id],
      });
      
      // Sync replica with Turso in the background
      if (isEmbeddedReplica) {
        client.sync().catch((err: any) => console.error(`Replication sync error in commit: ${err.message}`));
      }
      
      return JSON.stringify({
        status: "success",
        message: `Snippet "${topic}" has been successfully updated and marked as validated.`,
        id
      }, null, 2);
    } catch (error: any) {
      console.error(`Error in commit_update for ID "${id}": ${error.message}`);
      return `Failed to commit update: ${error.message}`;
    }
  }
});

// Tool 5: learn_codebase
server.addTool({
  name: "learn_codebase",
  description: "Inspects the active codebase directory, auto-detects the technology stack, summarizes key architectural conventions, and saves them as project context.",
  parameters: z.object({
    projectPath: z.string().optional().describe("Optional absolute path to the project root. Defaults to the server's current working directory."),
  }),
  execute: async (args) => {
    // Default to current working directory of the server process
    const projectPath = args.projectPath?.trim() || process.cwd();
    
    try {
      const result = await learnCodebase(projectPath);
      
      if (result.detectedFiles.length === 0) {
        return `No configuration or README files found at path "${projectPath}". Ensure the path is correct and contains package.json, composer.json, or README.md.`;
      }
      
      const snippetsSummary = result.snippets.map((s, idx) => {
        return `### [${idx + 1}] Topic: ${s.topic}\nCategory: ${s.category}\n\nContent:\n${s.content}\n`;
      }).join("\n---\n\n");
      
      return `## 🧠 Successfully Learned Project: "${result.projectName}"
Discovered and analyzed key metadata from: ${result.detectedFiles.join(", ")}
Stored **${result.snippets.length}** project-specific context snippets in the database.

---

${snippetsSummary}`;
    } catch (error: any) {
      console.error(`Error in learn_codebase: ${error.message}`);
      return `Failed to analyze and learn codebase: ${error.message}`;
    }
  }
});

// Helper to run auto-scanning for a session's workspace roots
const triggerAutoScan = async (session: any) => {
  console.error("[SysQlow Info] Client session active. Scheduling workspace roots check...");
  
  // A 1000ms delay ensures client-server handshake is fully established 
  // and prevents early JSON-RPC roots/list timeouts (e.g. MCP error -32001)
  setTimeout(async () => {
    try {
      const roots = session.roots;
      if (roots && roots.length > 0) {
        // Resolve standard file URIs (e.g. file:///Users/... -> /Users/...)
        const rootPath = roots[0].uri.replace(/^file:\/\//, "");
        console.error(`[SysQlow Auto-Hook] Automatically learning codebase at workspace root: ${rootPath}`);
        
        await learnCodebase(rootPath);
        console.error("[SysQlow Auto-Hook] Codebase auto-learning completed successfully!");
      } else {
        console.error("[SysQlow Info] No workspace roots are currently open or active in the client session.");
      }
    } catch (err: any) {
      console.error(`[SysQlow Warn] Failed to automatically learn codebase: ${err.message}`);
    }
  }, 1000);
};

// Auto-Hook: Listens for incoming client sessions and triggers automated learning on startup
server.on("connect", ({ session }) => {
  console.error(`[SysQlow Info] New client session connected: ${session.sessionId || "default"}`);
  
  // Prevent race condition: if session is already ready, run scan immediately. Otherwise wait for ready event.
  if (session.isReady) {
    triggerAutoScan(session);
  } else {
    session.on("ready", () => triggerAutoScan(session));
  }

  // B. Triggered proactively when developer changes/adds workspace folders in the IDE
  session.on("rootsChanged", async (event) => {
    console.error("[SysQlow Info] Workspace folders updated in client. Re-scanning roots...");
    try {
      const roots = event.roots;
      if (roots && roots.length > 0) {
        const rootPath = roots[0].uri.replace(/^file:\/\//, "");
        console.error(`[SysQlow Auto-Hook] Re-learning updated codebase at root: ${rootPath}`);
        
        await learnCodebase(rootPath);
        console.error("[SysQlow Auto-Hook] Updated codebase auto-learning completed successfully!");
      }
    } catch (err: any) {
      console.error(`[SysQlow Warn] Failed to automatically learn codebase on rootsChanged: ${err.message}`);
    }
  });
});

// Get Hono instance
const app = server.getApp();

// 1. Dashboard Web UI Route
app.get("/", async (c) => {
  return c.html(dashboardHtml);
});

// 2. Knowledge Graph Entities API
app.get("/api/graph", async (c) => {
  try {
    const res = await client.execute({
      sql: `SELECT id, topic, content, category, is_validated, confidence_score, last_validated_at, source_url 
            FROM technical_knowledge`,
      args: []
    });
    
    const nodes = res.rows.map((r: any) => ({
      id: r.id,
      label: r.topic,
      category: r.category || "None",
      validated: r.is_validated,
      confidence: r.confidence_score,
      last_validated: r.last_validated_at,
      source_url: r.source_url,
      content: r.content
    }));

    const edges: any[] = [];
    
    // Build edges dynamically
    for (let i = 0; i < nodes.length; i++) {
      const nodeA = nodes[i];
      
      for (let j = i + 1; j < nodes.length; j++) {
        const nodeB = nodes[j];
        
        // Connect nodes sharing the same category
        if (nodeA.category && nodeA.category !== "None" && nodeA.category === nodeB.category) {
          edges.push({
            from: nodeA.id,
            to: nodeB.id,
            label: "Same Category",
            arrows: undefined
          });
        }
      }
      
      // Directed reference connection if snippet content mentions another topic
      for (let j = 0; j < nodes.length; j++) {
        const nodeB = nodes[j];
        if (nodeA.id === nodeB.id) continue;
        
        // Escape special chars in regex
        const escapedLabel = nodeB.label.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const topicRegex = new RegExp(escapedLabel, 'i');
        if (topicRegex.test(nodeA.content)) {
          edges.push({
            from: nodeA.id,
            to: nodeB.id,
            label: "Mentions",
            arrows: "to"
          });
        }
      }
    }

    return c.json({ nodes, edges });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// 3. Manual Validation Trigger
app.post("/api/validate/:id", async (c) => {
  const id = c.req.param("id");
  try {
    const report = await validateKnowledgeItem(id);
    return c.json({ status: "success", report });
  } catch (err: any) {
    return c.json({ status: "error", message: err.message }, 500);
  }
});

// 4. Console Log Terminal Stream
app.get("/api/logs", async (c) => {
  return c.json({ logs: logsRingBuffer });
});

// 5. Redacted Environment Configuration Listing
app.get("/api/env", async (c) => {
  const redactedEnv: Record<string, string> = {};
  const keysToRedact = ["KEY", "TOKEN", "SECRET", "PASS", "CREDENTIAL"];
  
  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue;
    const needsRedaction = keysToRedact.some(k => key.toUpperCase().includes(k));
    if (needsRedaction) {
      redactedEnv[key] = val.substring(0, Math.min(6, val.length)) + "... [REDACTED]";
    } else {
      redactedEnv[key] = val;
    }
  }
  return c.json({ env: redactedEnv });
});

// Start the server using the configured transport mode
// If MCP_TRANSPORT is set to "sse", it boots as an HTTP/SSE server. Otherwise, it defaults to stdio.
const transportMode = process.env.MCP_TRANSPORT === "sse" ? "httpStream" : "stdio";
const port = parseInt(process.env.PORT || "50741", 10);

if (transportMode === "httpStream") {
  console.error(`Starting SysQlow-MCP server on SSE/HTTP transport (port ${port})...`);
  await server.start({
    transportType: "httpStream",
    httpStream: {
      port: port,
      host: "0.0.0.0", // Necessary for Docker to expose the port to your Mac
      endpoint: "/sse" // Standard SSE endpoint
    }
  });
  console.error(`SysQlow-MCP server is running and listening at: http://localhost:${port}/sse`);
} else {
  console.error("Starting SysQlow-MCP server on stdio transport...");
  await server.start({ transportType: "stdio" });
  console.error("SysQlow-MCP server started successfully!");
}
