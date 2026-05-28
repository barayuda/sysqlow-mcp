import { FastMCP } from "fastmcp";
import { z } from "zod";
import { initDatabase, client, isEmbeddedReplica } from "./db";
import { validateKnowledgeItem } from "./sentinel";
import { learnCodebase } from "./learn";
import { dashboardHtml } from "./dashboard-html";
import { generateEmbedding, extractDocumentationWithLLM } from "./llm";
import { cosineSimilarity } from "./search";
import { detectCurrentProject, mergeProjects, reassignProject } from "./coherence";

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

async function resolveScope(scope: string | undefined): Promise<{ where: string; args: any[] }> {
  if (scope === "all") return { where: "", args: [] };
  if (scope === "generic") return { where: "AND project_id IS NULL", args: [] };
  if (scope && scope !== "current") {
    // explicit project UUID
    return { where: "AND (project_id = ? OR project_id IS NULL)", args: [scope] };
  }
  // default = current
  try {
    const proj = await detectCurrentProject();
    return { where: "AND (project_id = ? OR project_id IS NULL)", args: [proj.id] };
  } catch (err) {
    console.error("[resolveScope] detectCurrentProject failed; falling back to scope=all", err);
    return { where: "", args: [] };
  }
}

async function storeEmbeddingForSnippet(id: string, topic: string, content: string) {
  try {
    const combinedText = `${topic}\n${content}`;
    const vector = await generateEmbedding(combinedText);
    if (vector && vector.length > 0) {
      await client.execute({
        sql: `INSERT OR REPLACE INTO technical_knowledge_embeddings (id, embedding)
              VALUES (?, ?)`,
        args: [id, JSON.stringify(vector)],
      });
      if (isEmbeddedReplica) {
        client.sync().catch((err: any) => console.error(`Replication sync error in embeddings save: ${err.message}`));
      }
    }
  } catch (err: any) {
    console.error(`Failed to store semantic embedding for snippet "${id}": ${err.message}`);
  }
}

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

const CANONICAL_CATEGORIES = [
  "Backend",
  "Frontend",
  "DevOps",
  "Project Context",
  "Database",
  "Testing",
  "Tooling"
] as const;

function normalizeCategory(raw?: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const normalized = trimmed.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

  const aliases: Record<string, string> = {
    backend: "Backend",
    server: "Backend",
    api: "Backend",
    frontend: "Frontend",
    ui: "Frontend",
    client: "Frontend",
    devops: "DevOps",
    infra: "DevOps",
    infrastructure: "DevOps",
    "project context": "Project Context",
    context: "Project Context",
    database: "Database",
    db: "Database",
    testing: "Testing",
    test: "Testing",
    tooling: "Tooling",
    tools: "Tooling"
  };

  if (aliases[normalized]) {
    return aliases[normalized];
  }

  return trimmed
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function formatCategoryGuidance(): string {
  return `Use consistent categories for better recall: ${CANONICAL_CATEGORIES.join(", ")}.`;
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
    const category = normalizeCategory(args.category);

    // Resolve project scope: Project Context snippets are scoped to the current workspace,
    // everything else stays generic unless the caller passes an explicit project_id.
    let resolvedProjectId: string | null = null;
    if (category === "Project Context") {
      try {
        const proj = await detectCurrentProject();
        resolvedProjectId = proj.id;
      } catch (err: any) {
        console.error(`detectCurrentProject failed in store_knowledge: ${err.message}`);
      }
    }

    try {
      await client.execute({
        sql: `INSERT INTO technical_knowledge (id, topic, content, category, project_id)
              VALUES (?, ?, ?, ?, ?)`,
        args: [id, topic, content, category, resolvedProjectId],
      });
      
      // Generate embedding in the background
      storeEmbeddingForSnippet(id, topic, content).catch(() => {});
      
      // Sync replica with Turso in the background
      if (isEmbeddedReplica) {
        client.sync().catch((err: any) => console.error(`Replication sync error in store: ${err.message}`));
      }
      
      return JSON.stringify({
        status: "success",
        message: `Technical snippet stored successfully. ${formatCategoryGuidance()}`,
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
    projectScope: z.union([z.enum(["all", "current", "generic"]), z.string().uuid()]).optional()
      .describe("'all' = no project filter; 'current' (default) = current project ∪ generic; 'generic' = generic only; or an explicit project UUID."),
  }),
  execute: async (args) => {
    const query = args.query.trim();
    const category = normalizeCategory(args.category);
    const scope = await resolveScope(args.projectScope);

    try {
      let rows: any[] = [];

      // If query is "*" or empty, retrieve all knowledge snippets
      if (query === "*" || query === "") {
        let sql = `
          SELECT id, topic, content, category, is_validated, last_validated_at, source_url, confidence_score
          FROM technical_knowledge
          WHERE 1=1
        `;
        const sqlArgs: any[] = [];

        if (category) {
          sql += " AND category = ?";
          sqlArgs.push(category);
        }

        if (scope.where) {
          sql += " " + scope.where;
          sqlArgs.push(...scope.args);
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

          if (scope.where) {
            ftsSql += " " + scope.where;
            ftsArgs.push(...scope.args);
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

          if (scope.where) {
            likeSql += " " + scope.where;
            likeArgs.push(...scope.args);
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
  description: "Applies validated updates or corrections to a stored snippet (requires human-in-the-loop review). By default it re-validates before commit.",
  parameters: z.object({
    id: z.string().describe("The UUID of the snippet to update"),
    content: z.string().describe("The complete new content of the snippet to save"),
    revalidateBeforeCommit: z.boolean().optional().describe("If true (default), runs validate_knowledge logic before committing."),
  }),
  execute: async (args) => {
    const id = args.id.trim();
    const content = args.content.trim();
    const revalidateBeforeCommit = args.revalidateBeforeCommit ?? true;
    
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

      let validationStatus: string | null = null;
      let validationConfidence: number | null = null;
      if (revalidateBeforeCommit) {
        const validationReport = await validateKnowledgeItem(id);
        validationStatus = validationReport.status;
        validationConfidence = validationReport.confidence_score;
      }
      
      // 2. Perform the update and mark validated
      await client.execute({
        sql: `UPDATE technical_knowledge 
              SET content = ?, 
                  is_validated = 1, 
                  last_validated_at = CURRENT_TIMESTAMP 
              WHERE id = ?`,
        args: [content, id],
      });
      
      // Regenerate embedding in the background
      storeEmbeddingForSnippet(id, topic, content).catch(() => {});
      
      // Sync replica with Turso in the background
      if (isEmbeddedReplica) {
        client.sync().catch((err: any) => console.error(`Replication sync error in commit: ${err.message}`));
      }
      
      return JSON.stringify({
        status: "success",
        message: `Snippet "${topic}" has been successfully updated and marked as validated.`,
        id,
        revalidated_before_commit: revalidateBeforeCommit,
        validation_status: validationStatus,
        validation_confidence_score: validationConfidence
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

// Tool 7: list_knowledge
server.addTool({
  name: "list_knowledge",
  description: "Lists all stored technical snippets in your second brain, optionally filtered by category.",
  parameters: z.object({
    category: z.string().optional().describe("Optional category to filter the list."),
  }),
  execute: async (args) => {
    const category = normalizeCategory(args.category);
    
    try {
      let sql = `
        SELECT id, topic, category, is_validated, confidence_score, created_at
        FROM technical_knowledge
      `;
      const sqlArgs: any[] = [];
      
      if (category) {
        sql += " WHERE category = ?";
        sqlArgs.push(category);
      }
      
      sql += " ORDER BY category ASC, topic ASC";
      
      const res = await client.execute({ sql, args: sqlArgs });
      const rows = res.rows;
      
      if (rows.length === 0) {
        return `🧠 Your second brain is currently empty${category ? ` in category "${category}"` : ""}. Use store_knowledge to add your first technical snippet!`;
      }
      
      const header = `🧠 **Saved Second Brain: ${rows.length} Snippet(s) Found**\n\n` +
                     `Use \`recall_knowledge\` with a specific query or ID to view the full content of any snippet.\n\n` +
                     `| # | Topic | Category | Validated | Confidence | Created At |\n` +
                     `|---|---|---|---|---|---|\n`;
      
      const tableRows = rows.map((r, idx) => {
        const validatedEmoji = r.is_validated ? "✅" : "⚠️";
        const confidenceStr = r.confidence_score ? `${r.confidence_score}/10` : "N/A";
        const createdDate = String(r.created_at || "").substring(0, 10);
        return `| ${idx + 1} | **${r.topic}** | \`${r.category || "None"}\` | ${validatedEmoji} | ${confidenceStr} | ${createdDate} |`;
      }).join("\n");
      
      return header + tableRows;
    } catch (error: any) {
      console.error(`Error in list_knowledge: ${error.message}`);
      return `Failed to list knowledge: ${error.message}`;
    }
  }
});

// Tool 8: delete_knowledge
server.addTool({
  name: "delete_knowledge",
  description: "Deletes a stored technical snippet from the database by its UUID.",
  parameters: z.object({
    id: z.string().describe("The UUID of the snippet to delete."),
  }),
  execute: async (args) => {
    const id = args.id.trim();
    
    try {
      const checkRes = await client.execute({
        sql: "SELECT topic FROM technical_knowledge WHERE id = ?",
        args: [id]
      });
      
      if (checkRes.rows.length === 0) {
        return JSON.stringify({
          status: "error",
          message: `Snippet with ID "${id}" does not exist.`
        }, null, 2);
      }
      
      const topic = checkRes.rows[0].topic as string;
      
      await client.execute({
        sql: "DELETE FROM technical_knowledge WHERE id = ?",
        args: [id]
      });
      
      if (isEmbeddedReplica) {
        client.sync().catch((err: any) => console.error(`Replication sync error in delete: ${err.message}`));
      }
      
      return JSON.stringify({
        status: "success",
        message: `Snippet "${topic}" has been successfully deleted.`,
        id
      }, null, 2);
} catch (error: any) {
      console.error(`Error in delete_knowledge for ID "${id}": ${error.message}`);
      return JSON.stringify({
        status: "error",
        message: `Failed to delete snippet: ${error.message}`
      }, null, 2);
    }
  }
});

// Tool 9: merge_knowledge
server.addTool({
  name: "merge_knowledge",
  description: "Merges two snippets: either merges contents into parent and deletes child, or links child to parent hierarchically.",
  parameters: z.object({
    parentId: z.string().describe("The UUID of the parent snippet."),
    childId: z.string().describe("The UUID of the child snippet to merge or link."),
    mode: z.enum(["merge_content", "link_child"]).describe("Merge mode: merge content (deletes child) or link hierarchically."),
  }),
  execute: async (args) => {
    const parentId = args.parentId.trim();
    const childId = args.childId.trim();
    const mode = args.mode;

    try {
      const parentRes = await client.execute({
        sql: "SELECT topic, content, category FROM technical_knowledge WHERE id = ?",
        args: [parentId]
      });
      const childRes = await client.execute({
        sql: "SELECT topic, content FROM technical_knowledge WHERE id = ?",
        args: [childId]
      });

      if (parentRes.rows.length === 0) {
        return JSON.stringify({ status: "error", message: `Parent snippet with ID "${parentId}" does not exist.` }, null, 2);
      }
      if (childRes.rows.length === 0) {
        return JSON.stringify({ status: "error", message: `Child snippet with ID "${childId}" does not exist.` }, null, 2);
      }

      const parentTopic = parentRes.rows[0].topic as string;
      const childTopic = childRes.rows[0].topic as string;
      const parentContent = parentRes.rows[0].content as string;
      const childContent = childRes.rows[0].content as string;

      if (mode === "merge_content") {
        const mergedContent = `${parentContent}\n\n---\n### 🔗 Merged Subtopic: ${childTopic}\n${childContent}`;
        
        await client.execute({
          sql: "UPDATE technical_knowledge SET content = ?, is_validated = 0 WHERE id = ?",
          args: [mergedContent, parentId]
        });

        await client.execute({
          sql: "DELETE FROM technical_knowledge WHERE id = ?",
          args: [childId]
        });

        if (isEmbeddedReplica) {
          client.sync().catch((err: any) => console.error(`Replication sync error in merge/content: ${err.message}`));
        }

        return JSON.stringify({
          status: "success",
          mode,
          parentId,
          parentTopic,
          message: `Snippet "${childTopic}" content has been successfully merged into "${parentTopic}". Child snippet deleted.`
        }, null, 2);
      } else {
        await client.execute({
          sql: "UPDATE technical_knowledge SET parent_id = ? WHERE id = ?",
          args: [parentId, childId]
        });

        if (isEmbeddedReplica) {
          client.sync().catch((err: any) => console.error(`Replication sync error in merge/link: ${err.message}`));
        }

        return JSON.stringify({
          status: "success",
          mode,
          parentId,
          childId,
          parentTopic,
          childTopic,
          message: `Snippet "${childTopic}" is now linked as a child sub-topic of "${parentTopic}".`
        }, null, 2);
      }
    } catch (error: any) {
      console.error(`Error in merge_knowledge: ${error.message}`);
      return JSON.stringify({ status: "error", message: `Merge failed: ${error.message}` }, null, 2);
    }
  }
});

// Tool 10: semantic_search
server.addTool({
  name: "semantic_search",
  description: "Performs vector similarity semantic search on stored knowledge snippets using embeddings.",
  parameters: z.object({
    query: z.string().describe("The search term or conceptual phrase to query (e.g. 'caching databases')."),
    category: z.string().optional().describe("Optional category to filter results."),
    limit: z.number().optional().describe("Max number of matches to return. Defaults to 5."),
    projectScope: z.union([z.enum(["all", "current", "generic"]), z.string().uuid()]).optional()
      .describe("'all' = no project filter; 'current' (default) = current project ∪ generic; 'generic' = generic only; or an explicit project UUID."),
  }),
  execute: async (args) => {
    const query = args.query.trim();
    const category = normalizeCategory(args.category);
    const limit = args.limit ?? 5;
    const scope = await resolveScope(args.projectScope);
    // Aliased variant for queries that use `k` as alias for technical_knowledge
    const scopeAliased = {
      where: scope.where ? scope.where.replace(/\bproject_id\b/g, "k.project_id") : "",
      args: scope.args,
    };

    try {
      const queryVector = await generateEmbedding(query);
      if (!queryVector || queryVector.length === 0) {
        console.error("[Semantic Search] Failed to generate embedding for query. Falling back to keyword search...");

        let rows: any[] = [];
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
          if (scope.where) {
            ftsSql += " " + scope.where;
            ftsArgs.push(...scope.args);
          }
          const ftsRes = await client.execute({ sql: ftsSql, args: ftsArgs });
          rows = ftsRes.rows;
        } catch {
          // Ignore FTS error
        }

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
          if (scope.where) {
            likeSql += " " + scope.where;
            likeArgs.push(...scope.args);
          }
          const likeRes = await client.execute({ sql: likeSql, args: likeArgs });
          rows = likeRes.rows;
        }

        return JSON.stringify({
          status: "fallback_success",
          query,
          category,
          message: "Gemini embedding key exhausted or unavailable. Fell back to FTS5 search.",
          results: rows
        }, null, 2);
      }

      let sql = `
        SELECT k.id, k.topic, k.content, k.category, k.is_validated, k.confidence_score, e.embedding
        FROM technical_knowledge k
        JOIN technical_knowledge_embeddings e ON k.id = e.id
        WHERE 1=1
      `;
      const sqlArgs: any[] = [];
      if (category) {
        sql += " AND k.category = ?";
        sqlArgs.push(category);
      }
      if (scopeAliased.where) {
        sql += " " + scopeAliased.where;
        sqlArgs.push(...scopeAliased.args);
      }

      const dbRes = await client.execute({ sql, args: sqlArgs });
      const rows = dbRes.rows;

      if (rows.length === 0) {
        return JSON.stringify({
          status: "success",
          query,
          category,
          count: 0,
          results: [],
          message: "No snippets with embeddings found. Try scanning your codebase first!"
        }, null, 2);
      }

      const rankedMatches = rows.map((r: any) => {
        let storedVector: number[] = [];
        try {
          storedVector = JSON.parse(r.embedding);
        } catch (_) {}

        const similarity = cosineSimilarity(queryVector, storedVector);
        return {
          id: r.id,
          topic: r.topic,
          content: r.content,
          category: r.category || "None",
          is_validated: r.is_validated,
          confidence_score: r.confidence_score,
          similarity_score: Math.round(similarity * 1000) / 1000
        };
      });

      const filteredMatches = rankedMatches
        .filter((item) => item.similarity_score > 0.35)
        .sort((a, b) => b.similarity_score - a.similarity_score)
        .slice(0, limit);

      return JSON.stringify({
        status: "success",
        query,
        category,
        count: filteredMatches.length,
        results: filteredMatches
      }, null, 2);
    } catch (error: any) {
      console.error(`Error in semantic_search: ${error.message}`);
      return JSON.stringify({ status: "error", message: `Semantic search failed: ${error.message}` }, null, 2);
    }
  }
});

// Tool 11: import_documentation
server.addTool({
  name: "import_documentation",
  description: "Scrapes external HTML documentation from a URL, converts it to clean markdown using Gemini, and stores it in the database.",
  parameters: z.object({
    url: z.string().describe("The URL of the technical documentation to scrape and import."),
    category: z.string().optional().describe("Optional category to organize the imported knowledge (e.g. 'Backend', 'Frontend', 'DevOps'). Defaults to 'Backend'."),
  }),
  execute: async (args) => {
    const url = args.url.trim();
    const category = args.category || "Backend";

    try {
      console.error(`[Web Importer] Fetching raw HTML documentation from: "${url}"`);
      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP request failed with status ${response.status}`);
      }

      const html = await response.text();
      let cleaned = html
        .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
        .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
        .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, "")
        .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
        .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (cleaned.length > 20000) {
        cleaned = cleaned.substring(0, 20000) + "... [Content truncated for context safety]";
      }

      console.error(`[Web Importer] Prompting LLM to extract documentation snippets...`);
      const extracted = await extractDocumentationWithLLM(url, cleaned);

      const id = crypto.randomUUID();
      const normalizedCategory = normalizeCategory(category);

      await client.execute({
        sql: `INSERT INTO technical_knowledge (id, topic, content, category, is_validated, confidence_score, source_url) 
              VALUES (?, ?, ?, ?, 1, 10, ?)`,
        args: [id, extracted.topic, extracted.content, normalizedCategory, url]
      });

      storeEmbeddingForSnippet(id, extracted.topic, extracted.content).catch(() => {});

      if (isEmbeddedReplica) {
        client.sync().catch((err: any) => console.error(`Replication sync error in import: ${err.message}`));
      }

      return JSON.stringify({
        status: "success",
        id,
        topic: extracted.topic,
        category: normalizedCategory,
        message: `Successfully scraped and imported documentation from "${url}".`
      }, null, 2);
    } catch (error: any) {
      console.error(`Error in import_documentation: ${error.message}`);
      return JSON.stringify({ status: "error", message: `Documentation import failed: ${error.message}` }, null, 2);
    }
  }
});

server.addTool({
  name: "merge_projects",
  description: "Merge two projects: move all snippets from drop_id into keep_id, then delete drop_id. Use after audit_coherence flags a duplicate proto-project.",
  parameters: z.object({
    keep_id: z.string().uuid().describe("Project to retain."),
    drop_id: z.string().uuid().describe("Project to absorb and delete."),
  }),
  execute: async ({ keep_id, drop_id }) => {
    const result = await mergeProjects(keep_id, drop_id);
    return `Merged ${result.snippetsMoved} snippet(s) from ${drop_id} into ${keep_id}.`;
  },
});

server.addTool({
  name: "reassign_project",
  description: "Move a single snippet to a different project, or pass new_project_id=null to promote it to generic (shared across projects).",
  parameters: z.object({
    snippet_id: z.string().uuid(),
    new_project_id: z.string().uuid().nullable(),
  }),
  execute: async ({ snippet_id, new_project_id }) => {
    await reassignProject(snippet_id, new_project_id);
    return new_project_id === null
      ? `Promoted snippet ${snippet_id} to generic.`
      : `Reassigned snippet ${snippet_id} to project ${new_project_id}.`;
  },
});

// Tool 6: knowledge_workflow
server.addTool({
  name: "knowledge_workflow",
  description: "High-level orchestration tool for common intents: analyze/learn, save/store, find/search, audit/validate, and apply/commit.",
  parameters: z.object({
    intent: z.enum(["learn", "save", "search", "validate", "apply", "list", "delete", "merge", "semantic", "import"]).describe("Workflow intent to execute."),
    projectPath: z.string().optional().describe("Used by intent=learn."),
    topic: z.string().optional().describe("Used by intent=save."),
    content: z.string().optional().describe("Used by intent=save or intent=apply."),
    query: z.string().optional().describe("Used by intent=search."),
    category: z.string().optional().describe("Optional category for save/search."),
    id: z.string().optional().describe("Used by intent=validate or intent=apply or intent=delete."),
    revalidateBeforeCommit: z.boolean().optional().describe("Used by intent=apply. Defaults to true."),
    parentId: z.string().optional().describe("Used by intent=merge."),
    childId: z.string().optional().describe("Used by intent=merge."),
    mode: z.enum(["merge_content", "link_child"]).optional().describe("Used by intent=merge. Defaults to link_child."),
    url: z.string().optional().describe("Used by intent=import."),
  }),
  execute: async (args) => {
    const intent = args.intent;

    try {
      if (intent === "learn") {
        const projectPath = args.projectPath?.trim() || process.cwd();
        const result = await learnCodebase(projectPath);

        if (result.detectedFiles.length === 0) {
          return `No configuration or README files found at path "${projectPath}".`;
        }

        return JSON.stringify({
          status: "success",
          intent,
          project: result.projectName,
          detected_files: result.detectedFiles,
          snippets_stored: result.snippets.length
        }, null, 2);
      }

      if (intent === "save") {
        if (!args.topic?.trim() || !args.content?.trim()) {
          return JSON.stringify({
            status: "error",
            message: "For intent=save, both topic and content are required."
          }, null, 2);
        }

        const id = crypto.randomUUID();
        const topic = args.topic.trim();
        const content = args.content.trim();
        const category = normalizeCategory(args.category);

        await client.execute({
          sql: `INSERT INTO technical_knowledge (id, topic, content, category) VALUES (?, ?, ?, ?)`,
          args: [id, topic, content, category],
        });

        // Generate embedding in the background
        storeEmbeddingForSnippet(id, topic, content).catch(() => {});

        if (isEmbeddedReplica) {
          client.sync().catch((err: any) => console.error(`Replication sync error in workflow/save: ${err.message}`));
        }

        return JSON.stringify({
          status: "success",
          intent,
          id,
          topic,
          category,
          guidance: formatCategoryGuidance()
        }, null, 2);
      }

      if (intent === "search") {
        const query = args.query?.trim() || "*";
        const category = normalizeCategory(args.category);
        let sql = `
          SELECT id, topic, content, category, is_validated, last_validated_at, source_url, confidence_score
          FROM technical_knowledge
        `;
        const sqlArgs: any[] = [];

        if (query === "*" || query === "") {
          if (category) {
            sql += " WHERE category = ?";
            sqlArgs.push(category);
          }
          sql += " ORDER BY created_at DESC";
        } else {
          const safeFtsQuery = buildSafeFtsQuery(query);
          sql += ` WHERE id IN (SELECT id FROM technical_knowledge_fts WHERE technical_knowledge_fts MATCH ?)`;
          sqlArgs.push(safeFtsQuery);
          if (category) {
            sql += " AND category = ?";
            sqlArgs.push(category);
          }
          sql += " ORDER BY created_at DESC";
        }

        let rows: any[] = [];
        try {
          const res = await client.execute({ sql, args: sqlArgs });
          rows = res.rows;
        } catch {
          if (query !== "*" && query !== "") {
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
            likeSql += " ORDER BY created_at DESC";
            const likeRes = await client.execute({ sql: likeSql, args: likeArgs });
            rows = likeRes.rows;
          }
        }

        return JSON.stringify({
          status: "success",
          intent,
          query,
          category,
          count: rows.length,
          results: rows
        }, null, 2);
      }

      if (intent === "validate") {
        const id = args.id?.trim();
        if (!id) {
          return JSON.stringify({
            status: "error",
            message: "For intent=validate, id is required."
          }, null, 2);
        }
        const report = await validateKnowledgeItem(id);
        return JSON.stringify({
          status: "success",
          intent,
          id,
          report
        }, null, 2);
      }

      if (intent === "apply") {
        const id = args.id?.trim();
        const content = args.content?.trim();
        const revalidateBeforeCommit = args.revalidateBeforeCommit ?? true;

        if (!id || !content) {
          return JSON.stringify({
            status: "error",
            message: "For intent=apply, both id and content are required."
          }, null, 2);
        }

        const checkRes = await client.execute({
          sql: "SELECT topic FROM technical_knowledge WHERE id = ?",
          args: [id]
        });
        if (checkRes.rows.length === 0) {
          return JSON.stringify({
            status: "error",
            message: `Snippet with ID "${id}" does not exist.`
          }, null, 2);
        }

        let validationStatus: string | null = null;
        let validationConfidence: number | null = null;
        if (revalidateBeforeCommit) {
          const validationReport = await validateKnowledgeItem(id);
          validationStatus = validationReport.status;
          validationConfidence = validationReport.confidence_score;
        }

        await client.execute({
          sql: `UPDATE technical_knowledge
                SET content = ?, is_validated = 1, last_validated_at = CURRENT_TIMESTAMP
                WHERE id = ?`,
          args: [content, id],
        });

        // Regenerate embedding in the background
        const topic = checkRes.rows[0].topic as string;
        storeEmbeddingForSnippet(id, topic, content).catch(() => {});

        if (isEmbeddedReplica) {
          client.sync().catch((err: any) => console.error(`Replication sync error in workflow/apply: ${err.message}`));
        }

        return JSON.stringify({
          status: "success",
          intent,
          id,
          revalidated_before_commit: revalidateBeforeCommit,
          validation_status: validationStatus,
          validation_confidence_score: validationConfidence
        }, null, 2);
      }

      if (intent === "list") {
        const category = normalizeCategory(args.category);
        let sql = `
          SELECT id, topic, category, is_validated, confidence_score, created_at
          FROM technical_knowledge
        `;
        const sqlArgs: any[] = [];
        
        if (category) {
          sql += " WHERE category = ?";
          sqlArgs.push(category);
        }
        
        sql += " ORDER BY category ASC, topic ASC";
        
        const res = await client.execute({ sql, args: sqlArgs });
        const rows = res.rows;
        
        return JSON.stringify({
          status: "success",
          intent,
          category,
          count: rows.length,
          results: rows
        }, null, 2);
      }

      if (intent === "delete") {
        const id = args.id?.trim();
        if (!id) {
          return JSON.stringify({
            status: "error",
            message: "For intent=delete, id is required."
          }, null, 2);
        }

        const checkRes = await client.execute({
          sql: "SELECT topic FROM technical_knowledge WHERE id = ?",
          args: [id]
        });
        if (checkRes.rows.length === 0) {
          return JSON.stringify({
            status: "error",
            message: `Snippet with ID "${id}" does not exist.`
          }, null, 2);
        }

        const topic = checkRes.rows[0].topic as string;

        await client.execute({
          sql: "DELETE FROM technical_knowledge WHERE id = ?",
          args: [id]
        });

        if (isEmbeddedReplica) {
          client.sync().catch((err: any) => console.error(`Replication sync error in workflow/delete: ${err.message}`));
        }

        return JSON.stringify({
          status: "success",
          intent,
          id,
          topic,
          message: `Snippet "${topic}" has been successfully deleted.`
        }, null, 2);
      }

      if (intent === "merge") {
        const parentId = args.parentId?.trim();
        const childId = args.childId?.trim();
        const mode = args.mode || "link_child";

        if (!parentId || !childId) {
          return JSON.stringify({
            status: "error",
            message: "For intent=merge, both parentId and childId are required."
          }, null, 2);
        }

        const parentRes = await client.execute({
          sql: "SELECT topic, content FROM technical_knowledge WHERE id = ?",
          args: [parentId]
        });
        const childRes = await client.execute({
          sql: "SELECT topic, content FROM technical_knowledge WHERE id = ?",
          args: [childId]
        });

        if (parentRes.rows.length === 0) {
          return JSON.stringify({ status: "error", message: `Parent snippet with ID "${parentId}" does not exist.` }, null, 2);
        }
        if (childRes.rows.length === 0) {
          return JSON.stringify({ status: "error", message: `Child snippet with ID "${childId}" does not exist.` }, null, 2);
        }

        const parentTopic = parentRes.rows[0].topic as string;
        const childTopic = childRes.rows[0].topic as string;
        const parentContent = parentRes.rows[0].content as string;
        const childContent = childRes.rows[0].content as string;

        if (mode === "merge_content") {
          const mergedContent = `${parentContent}\n\n---\n### 🔗 Merged Subtopic: ${childTopic}\n${childContent}`;
          
          await client.execute({
            sql: "UPDATE technical_knowledge SET content = ?, is_validated = 0 WHERE id = ?",
            args: [mergedContent, parentId]
          });

          await client.execute({
            sql: "DELETE FROM technical_knowledge WHERE id = ?",
            args: [childId]
          });

          if (isEmbeddedReplica) {
            client.sync().catch((err: any) => console.error(`Replication sync error in workflow/merge/content: ${err.message}`));
          }

          return JSON.stringify({
            status: "success",
            intent,
            mode,
            parentId,
            parentTopic,
            message: `Snippet "${childTopic}" content has been successfully merged into "${parentTopic}". Child snippet deleted.`
          }, null, 2);
        } else {
          await client.execute({
            sql: "UPDATE technical_knowledge SET parent_id = ? WHERE id = ?",
            args: [parentId, childId]
          });

          if (isEmbeddedReplica) {
            client.sync().catch((err: any) => console.error(`Replication sync error in workflow/merge/link: ${err.message}`));
          }

          return JSON.stringify({
            status: "success",
            intent,
            mode,
            parentId,
            childId,
            parentTopic,
            childTopic,
            message: `Snippet "${childTopic}" is now linked as a child sub-topic of "${parentTopic}".`
          }, null, 2);
        }
      }

      if (intent === "semantic") {
        const query = args.query?.trim();
        if (!query) {
          return JSON.stringify({
            status: "error",
            message: "For intent=semantic, query is required."
          }, null, 2);
        }
        const category = normalizeCategory(args.category);

        try {
          const queryVector = await generateEmbedding(query);
          if (!queryVector || queryVector.length === 0) {
            console.error("[Semantic Workflow] Failed to generate embedding for query. Falling back to keyword search...");

            let rows: any[] = [];
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
            } catch {
              // Ignore FTS error
            }

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

            return JSON.stringify({
              status: "fallback_success",
              intent,
              query,
              category,
              message: "Gemini embedding key exhausted or unavailable. Fell back to FTS5 search.",
              results: rows
            }, null, 2);
          }

          let sql = `
            SELECT k.id, k.topic, k.content, k.category, k.is_validated, k.confidence_score, e.embedding
            FROM technical_knowledge k
            JOIN technical_knowledge_embeddings e ON k.id = e.id
          `;
          const sqlArgs: any[] = [];
          if (category) {
            sql += " WHERE k.category = ?";
            sqlArgs.push(category);
          }

          const dbRes = await client.execute({ sql, args: sqlArgs });
          const rows = dbRes.rows;

          if (rows.length === 0) {
            return JSON.stringify({
              status: "success",
              intent,
              query,
              category,
              count: 0,
              results: [],
              message: "No snippets with embeddings found. Try scanning your codebase first!"
            }, null, 2);
          }

          const rankedMatches = rows.map((r: any) => {
            let storedVector: number[] = [];
            try {
              storedVector = JSON.parse(r.embedding);
            } catch (_) {}

            const similarity = cosineSimilarity(queryVector, storedVector);
            return {
              id: r.id,
              topic: r.topic,
              content: r.content,
              category: r.category || "None",
              is_validated: r.is_validated,
              confidence_score: r.confidence_score,
              similarity_score: Math.round(similarity * 1000) / 1000
            };
          });

          const filteredMatches = rankedMatches
            .filter((item) => item.similarity_score > 0.35)
            .sort((a, b) => b.similarity_score - a.similarity_score)
            .slice(0, 5);

          return JSON.stringify({
            status: "success",
            intent,
            query,
            category,
            count: filteredMatches.length,
            results: filteredMatches
          }, null, 2);
        } catch (error: any) {
          console.error(`Error in semantic workflow: ${error.message}`);
          return JSON.stringify({ status: "error", message: `Semantic workflow search failed: ${error.message}` }, null, 2);
        }
      }

      if (intent === "import") {
        const url = args.url?.trim();
        if (!url) {
          return JSON.stringify({
            status: "error",
            message: "For intent=import, url is required."
          }, null, 2);
        }
        const category = args.category || "Backend";

        try {
          console.error(`[Web Importer Workflow] Fetching raw HTML documentation from: "${url}"`);
          const response = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
              "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
            }
          });

          if (!response.ok) {
            throw new Error(`HTTP request failed with status ${response.status}`);
          }

          const html = await response.text();
          let cleaned = html
            .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
            .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "")
            .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, "")
            .replace(/<nav\b[^<]*(?:(?!<\/nav>)<[^<]*)*<\/nav>/gi, "")
            .replace(/<footer\b[^<]*(?:(?!<\/footer>)<[^<]*)*<\/footer>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();

          if (cleaned.length > 20000) {
            cleaned = cleaned.substring(0, 20000) + "... [Content truncated for context safety]";
          }

          console.error(`[Web Importer Workflow] Prompting LLM to extract documentation snippets...`);
          const extracted = await extractDocumentationWithLLM(url, cleaned);

          const id = crypto.randomUUID();
          const normalizedCategory = normalizeCategory(category);

          await client.execute({
            sql: `INSERT INTO technical_knowledge (id, topic, content, category, is_validated, confidence_score, source_url) 
                  VALUES (?, ?, ?, ?, 1, 10, ?)`,
            args: [id, extracted.topic, extracted.content, normalizedCategory, url]
          });

          storeEmbeddingForSnippet(id, extracted.topic, extracted.content).catch(() => {});

          if (isEmbeddedReplica) {
            client.sync().catch((err: any) => console.error(`Replication sync error in workflow/import: ${err.message}`));
          }

          return JSON.stringify({
            status: "success",
            intent,
            id,
            topic: extracted.topic,
            category: normalizedCategory,
            message: `Successfully scraped and imported documentation from "${url}".`
          }, null, 2);
        } catch (error: any) {
          console.error(`Error in workflow/import: ${error.message}`);
          return JSON.stringify({ status: "error", message: `Documentation import failed: ${error.message}` }, null, 2);
        }
      }

      return JSON.stringify({
        status: "error",
        message: `Unsupported workflow intent: ${intent}`
      }, null, 2);
    } catch (error: any) {
      console.error(`Error in knowledge_workflow (${intent}): ${error.message}`);
      return JSON.stringify({
        status: "error",
        message: `knowledge_workflow failed for intent "${intent}": ${error.message}`
      }, null, 2);
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
      sql: `SELECT id, topic, content, category, parent_id, project_id, is_validated, confidence_score, last_validated_at, source_url
            FROM technical_knowledge`,
      args: []
    });

    const nodes = res.rows.map((r: any) => ({
      id: r.id,
      label: r.topic,
      category: r.category || "None",
      parent_id: r.parent_id || null,
      project_id: r.project_id === null || r.project_id === undefined ? null : String(r.project_id),
      validated: r.is_validated,
      confidence: r.confidence_score,
      last_validated: r.last_validated_at,
      source_url: r.source_url,
      content: r.content
    }));

    // Edges now come from the materialized knowledge_relations table.
    // The isolation trigger guarantees no cross-project edges exist here.
    const edgeRows = await client.execute(`
      SELECT source_id, target_id, weight, relation_type
      FROM knowledge_relations
    `);

    const edges: any[] = edgeRows.rows.map((r: any) => ({
      from: String(r.source_id),
      to: String(r.target_id),
      value: Number(r.weight),
      label: String(r.relation_type),
      title: String(r.relation_type),
    }));

    // Add Parent-Child hierarchy edges (still derived directly from technical_knowledge)
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      if (node.parent_id) {
        edges.push({
          from: node.id,
          to: node.parent_id,
          label: "Hierarchy",
          arrows: "to",
          color: { color: "#a855f7", highlight: "#c084fc", hover: "#a855f7" }, // Premium purple edge
          width: 3
        });
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

// Background Sentinel Cron Auditor (Option C)
if (transportMode === "httpStream") {
  console.error("[Sentinel Daemon] Initializing background validation worker loop...");
  
  // Runs every 12 hours. We can define a helper interval.
  const intervalMs = 12 * 60 * 60 * 1000;
  
  const runBackgroundAudit = async () => {
    try {
      console.error("[Sentinel Daemon] Checking for outdated or unvalidated snippets...");
      
      // Query for snippets that have never been validated or where last_validated_at is older than 7 days,
      // sorted by created_at.
      const queryRes = await client.execute({
        sql: `SELECT id, topic FROM technical_knowledge 
              WHERE is_validated = 0 
                 OR datetime(last_validated_at) < datetime('now', '-7 days')
              ORDER BY created_at ASC
              LIMIT 3`,
        args: []
      });
      
      const targets = queryRes.rows;
      if (targets.length === 0) {
        console.error("[Sentinel Daemon] No outdated or unvalidated snippets found. Sleep cycle active.");
        return;
      }
      
      console.error(`[Sentinel Daemon] Discovered ${targets.length} candidates. Initiating audit cycle...`);
      for (const target of targets) {
        const id = String(target.id);
        const topic = String(target.topic);
        console.error(`[Sentinel Daemon] Auditing snippet: "${topic}" (ID: ${id})`);
        
        try {
          await validateKnowledgeItem(id);
          // Wait 3 seconds between LLM calls to prevent rate limits
          await new Promise(resolve => setTimeout(resolve, 3000));
        } catch (auditErr: any) {
          console.error(`[Sentinel Daemon Warn] Failed to audit snippet "${topic}": ${auditErr.message}`);
        }
      }
      
      if (isEmbeddedReplica) {
        client.sync().catch((err: any) => console.error(`[Sentinel Daemon Warn] Sync failed after daemon audit: ${err.message}`));
      }
      
      console.error("[Sentinel Daemon] Audit cycle completed successfully.");
    } catch (err: any) {
      console.error(`[Sentinel Daemon Error] Background worker execution failed: ${err.message}`);
    }
  };

  // Run immediately on boot after 10 seconds to allow standard startup activities to settle
  setTimeout(() => {
    runBackgroundAudit().catch(() => {});
  }, 10000);

  // Then schedule periodically
  setInterval(() => {
    runBackgroundAudit().catch(() => {});
  }, intervalMs);
}
