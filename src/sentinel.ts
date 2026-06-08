import { client as defaultClient } from "./db";
import { webSearch as defaultWebSearch } from "./search";
import { validateContentWithLLM, ValidationReport } from "./llm";
import type { Client } from "@libsql/client";

interface SentinelDeps {
  db?: Client;
  webSearch?: typeof defaultWebSearch;
  llm?: typeof validateContentWithLLM;
}

export async function validateKnowledgeItem(
  id: string,
  caller: "interactive" | "daemon" = "interactive",
  deps: SentinelDeps = {},
): Promise<ValidationReport> {
  const db = deps.db ?? defaultClient;
  const webSearch = deps.webSearch ?? defaultWebSearch;
  const llm = deps.llm ?? validateContentWithLLM;

  const res = await db.execute({
    sql: "SELECT * FROM technical_knowledge WHERE id = ?",
    args: [id],
  });

  if (res.rows.length === 0) {
    throw new Error(`Knowledge item with ID "${id}" not found.`);
  }

  const item = res.rows[0];
  const topic = item.topic as string;
  const content = item.content as string;

  const searchQuery = `${topic} documentation reference standard usage`;
  const searchResults = await webSearch(searchQuery);

  // Zero-evidence guard: refuse to "validate" against pure training data.
  // A snippet with no search hits gets marked unverifiable instead of
  // burning an LLM call that would return a confidently wrong "up_to_date".
  if (searchResults.length === 0) {
    console.error(`No search results for "${topic}" — skipping LLM, marking unverifiable.`);
    const report: ValidationReport = {
      status: "unverifiable",
      reasoning: "No search evidence available; skipped LLM validation. Configure TAVILY_API_KEY or SEARXNG_URL, or disable SYSQLOW_DDG_FALLBACK=false if DDG was the only tier and is being IP-blocked.",
      suggested_diff: null,
      source_url: null,
      confidence_score: 0,
    };
    await db.execute({
      sql: `UPDATE technical_knowledge
            SET is_validated = 0,
                last_validated_at = CURRENT_TIMESTAMP,
                source_url = NULL,
                confidence_score = 0,
                last_validation_reasoning = ?,
                last_suggested_diff = NULL
            WHERE id = ?`,
      args: [report.reasoning, id],
    });
    console.error(`Validation skipped for ID "${id}". Status: unverifiable`);
    return report;
  }

  const searchContext = searchResults
    .map((r, idx) => `Result [${idx + 1}]:\nTitle: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}\n`)
    .join("\n");

  console.error(`Prompting LLM to validate content for topic: "${topic}"...`);
  const report = await llm(topic, content, searchContext, caller);

  // We set is_validated to true only if the LLM states it is completely "up_to_date".
  // For outdated/incorrect we persist reasoning/diff so list_outdated_knowledge can surface
  // *what* needs fixing without forcing a re-validation (which would cost another Gemini call).
  const isValidated = report.status === "up_to_date" ? 1 : 0;
  const persistedReasoning = report.status === "up_to_date" ? null : report.reasoning;
  const persistedDiff = report.status === "up_to_date" ? null : report.suggested_diff;
  await db.execute({
    sql: `UPDATE technical_knowledge
          SET is_validated = ?,
              last_validated_at = CURRENT_TIMESTAMP,
              source_url = ?,
              confidence_score = ?,
              last_validation_reasoning = ?,
              last_suggested_diff = ?
          WHERE id = ?`,
    args: [
      isValidated,
      report.source_url || "",
      report.confidence_score,
      persistedReasoning,
      persistedDiff,
      id,
    ],
  });

  console.error(`Validation complete for ID "${id}". Status: ${report.status}`);
  return report;
}
