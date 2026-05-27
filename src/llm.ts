export interface ValidationReport {
  status: "up_to_date" | "outdated" | "incorrect";
  reasoning: string;
  suggested_diff: string | null;
  source_url: string | null;
  confidence_score: number;
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openAIKey = process.env.OPENAI_API_KEY;
  
  try {
    if (geminiKey) {
      return await embedGemini(text, geminiKey);
    } else if (openAIKey) {
      return await embedOpenAI(text, openAIKey);
    }
  } catch (error) {
    console.error("Embedding generation failed:", error);
  }
  return null;
}

function cleanLLMJson(text: string): string {
  let cleaned = text.trim();
  
  // 1. Remove markdown wrapping if the LLM returned it anyway
  if (cleaned.startsWith("```json")) {
    cleaned = cleaned.substring(7);
  } else if (cleaned.startsWith("```")) {
    cleaned = cleaned.substring(3);
  }
  
  if (cleaned.endsWith("```")) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }
  
  cleaned = cleaned.trim();
  
  // 2. Repair lone backslashes (like PHP namespaces 'Illuminate\Support')
  // In JSON, valid escapes are \", \\, \/, \b, \f, \n, \r, \t, and \uXXXX
  // Using a negative lookbehind (?<!\\) ensures we don't match already-escaped backslashes
  // and turn them into triple backslashes.
  return cleaned.replace(/(?<!\\)\\(?!["\\/bfnrtu])/g, "\\\\");
}

export async function validateContentWithLLM(
  topic: string,
  content: string,
  searchResults: string
): Promise<ValidationReport> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openAIKey = process.env.OPENAI_API_KEY;
  
  const prompt = `You are a strict, self-validating engineering documentation expert.
Analyze the following technical snippet and verify its accuracy and modern-day relevance against the provided live search results and documentation snippets.

Topic: ${topic}

Stored Snippet Content:
"""
${content}
"""

Live Search Results and Docs:
"""
${searchResults}
"""

Evaluate if the stored snippet is:
1. "up_to_date": It is still completely correct and aligns with the latest documentation.
2. "outdated": The APIs, syntax, or practices have changed, but it can be updated.
3. "incorrect": The snippet contains fundamental errors or the technology is deprecated.

Provide a JSON object containing:
- "status": exactly one of "up_to_date", "outdated", or "incorrect".
- "reasoning": a clear, detailed explanation comparing the stored snippet with modern docs. Mention specific version numbers or changes.
- "suggested_diff": if the status is "outdated" or "incorrect", provide a clean, standard Git-style unified diff representation (e.g. using "--- old\n+++ new\n" lines with - and + markers) mapping out the precise text transitions to update the stored snippet's content. If "up_to_date", set this to null.
- "source_url": the absolute URL of the best reference source used for the validation.
- "confidence_score": integer from 1 to 10 representing your certainty.

Your response MUST be valid JSON matching this schema exactly. 
IMPORTANT: Since you are returning a JSON object, all backslashes (\\) in string values (such as PHP namespaces or file paths) MUST be properly double-escaped as (\\\\) to ensure the JSON is valid. Do not wrap in markdown or backticks.`;

  if (geminiKey) {
    return await runGeminiJSONGeneric<ValidationReport>(prompt, geminiKey);
  } else if (openAIKey) {
    return await runOpenAIJSONGeneric<ValidationReport>(prompt, openAIKey);
  }
  
  throw new Error("No LLM API key configured. Please set GEMINI_API_KEY or OPENAI_API_KEY.");
}

async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries = 3,
  initialDelay = 1000
): Promise<Response> {
  let retries = 0;
  while (true) {
    try {
      const res = await fetch(url, options);
      if (res.ok) {
        return res;
      }
      
      const isTransient = [429, 500, 502, 503, 504].includes(res.status);
      if (isTransient && retries < maxRetries) {
        retries++;
        const delay = initialDelay * Math.pow(2, retries - 1);
        console.error(
          `[SysQlow LLM] Transient HTTP status ${res.status} from endpoint. Retrying attempt ${retries}/${maxRetries} in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      
      return res;
    } catch (error: any) {
      if (retries < maxRetries) {
        retries++;
        const delay = initialDelay * Math.pow(2, retries - 1);
        console.error(
          `[SysQlow LLM] Fetch network error: ${error.message || error}. Retrying attempt ${retries}/${maxRetries} in ${delay}ms...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

async function runGeminiJSONGeneric<T>(prompt: string, apiKey: string): Promise<T> {
  const model = "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: "application/json"
      }
    })
  });
  
  if (!res.ok) {
    throw new Error(`Gemini generateContent failed with status ${res.status}: ${await res.text()}`);
  }
  
  const data = await res.json() as any;
  const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!jsonText) {
    throw new Error("No response content from Gemini");
  }
  
  const repairedJson = cleanLLMJson(jsonText);
  try {
    return JSON.parse(repairedJson) as T;
  } catch (e: any) {
    console.error("Failed to parse repaired JSON. Raw text:\n", jsonText);
    throw new Error(`JSON Parse error: ${e.message}`);
  }
}

async function runOpenAIJSONGeneric<T>(prompt: string, apiKey: string): Promise<T> {
  const url = "https://api.openai.com/v1/chat/completions";
  
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" }
    })
  });
  
  if (!res.ok) {
    throw new Error(`OpenAI Chat completion failed with status ${res.status}: ${await res.text()}`);
  }
  
  const data = await res.json() as any;
  const jsonText = data.choices?.[0]?.message?.content;
  if (!jsonText) {
    throw new Error("No response content from OpenAI");
  }
  
  const repairedJson = cleanLLMJson(jsonText);
  try {
    return JSON.parse(repairedJson) as T;
  } catch (e: any) {
    console.error("Failed to parse repaired JSON. Raw text:\n", jsonText);
    throw new Error(`JSON Parse error: ${e.message}`);
  }
}
export interface ImportedDocumentation {
  topic: string;
  content: string;
}

export async function extractDocumentationWithLLM(
  url: string,
  rawContent: string
): Promise<ImportedDocumentation> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openAIKey = process.env.OPENAI_API_KEY;

  const prompt = `You are a world-class documentation ingestion bot.
Analyze the following raw documentation stream crawled from the URL "${url}".
Your task is to extract key architectural principles, configuration parameters, key concepts, standard commands, and boilerplates/code blocks from this content, and organize it as a single, beautifully structured Markdown snippet.

Raw crawled stream:
"""
${rawContent}
"""

Produce a JSON object containing:
- "topic": A descriptive, professional title for the documentation (e.g. "Laravel: Query Builder", "Vite: CSS Options", "Turso: Local Replicas").
- "content": A clean, comprehensive Markdown block representing the structured documentation. Make sure to preserve code blocks, arguments, and details.

Your response MUST be valid JSON matching this schema exactly.
IMPORTANT: All backslashes (\\\\) in string values (such as paths, namespaces, or escapes in code blocks) MUST be double-escaped to ensure the JSON is valid.`;

  if (geminiKey) {
    return await runGeminiJSONGeneric<ImportedDocumentation>(prompt, geminiKey);
  } else if (openAIKey) {
    return await runOpenAIJSONGeneric<ImportedDocumentation>(prompt, openAIKey);
  }

  throw new Error("No LLM API key configured. Please set GEMINI_API_KEY or OPENAI_API_KEY.");
}

export interface LearnedKnowledgeItem {
  topic: string;
  content: string;
  category: string;
}

export async function analyzeCodebaseWithLLM(
  projectName: string,
  collectedFiles: string
): Promise<LearnedKnowledgeItem[]> {
  const geminiKey = process.env.GEMINI_API_KEY;
  const openAIKey = process.env.OPENAI_API_KEY;
  
  const prompt = `You are a world-class software engineering architect.
Analyze the following core configuration and metadata files collected from the root of the project "${projectName}".
Your task is to identify and extract the project's exact technology stack, key dependencies, architectural decisions, and custom code conventions/rules.

Collected File Contents:
\"\"\"
${collectedFiles}
\"\"\"

Produce a list of structured knowledge snippets that represent this project's technical context.
Each snippet must have:
- "topic": A specific title (e.g. "${projectName}: Tech Stack & Dependencies", "${projectName}: Database & Models", "${projectName}: Architecture & Style Guidelines").
- "content": A highly professional, comprehensive technical explanation or reference block. Include exact framework versions and custom directories/conventions discovered.
- "category": Always use "Project Context".

Return a JSON array of these items. Do not wrap in markdown or backticks.
Example:
[
  {
    "topic": "MyProject: Technology Stack",
    "content": "This project is built using Bun runtime and FastMCP...",
    "category": "Project Context"
  }
]

Your response MUST be valid JSON matching this schema exactly.
IMPORTANT: All backslashes (\\\\) in string values (such as paths or namespaces) MUST be double-escaped to ensure the JSON is valid.`;

  if (geminiKey) {
    return await runGeminiJSONGeneric<LearnedKnowledgeItem[]>(prompt, geminiKey);
  } else if (openAIKey) {
    return await runOpenAIJSONGeneric<LearnedKnowledgeItem[]>(prompt, openAIKey);
  }
  
  throw new Error("No LLM API key configured. Please set GEMINI_API_KEY or OPENAI_API_KEY.");
}

async function embedGemini(text: string, apiKey: string): Promise<number[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${apiKey}`;
  
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "models/gemini-embedding-001",
      content: { parts: [{ text }] }
    })
  });
  
  if (!res.ok) {
    throw new Error(`Gemini embedContent failed: ${await res.text()}`);
  }
  
  const data = await res.json() as any;
  return data.embedding?.values || [];
}

async function embedOpenAI(text: string, apiKey: string): Promise<number[]> {
  const url = "https://api.openai.com/v1/embeddings";
  
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text
    })
  });
  
  if (!res.ok) {
    throw new Error(`OpenAI embeddings failed: ${await res.text()}`);
  }
  
  const data = await res.json() as any;
  return data.data?.[0]?.embedding || [];
}
