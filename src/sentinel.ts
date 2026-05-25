import { client } from "./db";
import { webSearch } from "./search";
import { validateContentWithLLM, ValidationReport } from "./llm";

export async function validateKnowledgeItem(id: string): Promise<ValidationReport> {
  // 1. Fetch item from DB
  const res = await client.execute({
    sql: "SELECT * FROM technical_knowledge WHERE id = ?",
    args: [id]
  });
  
  if (res.rows.length === 0) {
    throw new Error(`Knowledge item with ID "${id}" not found.`);
  }
  
  const item = res.rows[0];
  const topic = item.topic as string;
  const content = item.content as string;
  
  // 2. Perform web search
  // We search for the topic + "documentation reference standard usage" to get top-quality docs
  const searchQuery = `${topic} documentation reference standard usage`;
  const searchResults = await webSearch(searchQuery);
  
  if (searchResults.length === 0) {
    console.error(`No search results returned for query: "${searchQuery}"`);
  }
  
  // 3. Format search results for LLM context
  const searchContext = searchResults.length > 0 
    ? searchResults.map((r, idx) => 
        `Result [${idx + 1}]:\nTitle: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}\n`
      ).join("\n")
    : "No search results could be retrieved.";
  
  // 4. Validate with LLM
  console.error(`Prompting LLM to validate content for topic: "${topic}"...`);
  const report = await validateContentWithLLM(topic, content, searchContext);
  
  // 5. Update validation metadata in DB
  // We set is_validated to true only if the LLM states it is completely "up_to_date".
  const isValidated = report.status === "up_to_date" ? 1 : 0;
  await client.execute({
    sql: `UPDATE technical_knowledge 
          SET is_validated = ?, 
              last_validated_at = CURRENT_TIMESTAMP, 
              source_url = ?, 
              confidence_score = ? 
          WHERE id = ?`,
    args: [isValidated, report.source_url || "", report.confidence_score, id]
  });
  
  console.error(`Validation complete for ID "${id}". Status: ${report.status}`);
  return report;
}
