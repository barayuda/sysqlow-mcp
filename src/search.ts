export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(query: string): Promise<SearchResult[]> {
  const tavilyKey = process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    console.error(`Using Tavily Search API for query: "${query}"`);
    try {
      return await searchTavily(query, tavilyKey);
    } catch (e) {
      console.error("Tavily Search failed, falling back to DuckDuckGo scraper:", e);
    }
  }

  console.error(`Using DuckDuckGo fallback scraper for query: "${query}"`);
  return await searchDuckDuckGo(query);
}

async function searchTavily(query: string, apiKey: string): Promise<SearchResult[]> {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      max_results: 5,
      search_depth: "basic"
    })
  });

  if (!res.ok) {
    throw new Error(`Tavily Search API failed with status ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as any;
  const results = data.results || [];
  return results.map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.content || ""
  }));
}

async function searchDuckDuckGo(query: string): Promise<SearchResult[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9"
      }
    });
    
    if (!response.ok) {
      throw new Error(`DuckDuckGo HTTP request failed with status ${response.status}`);
    }
    
    const html = await response.text();
    const results: SearchResult[] = [];
    
    // DuckDuckGo HTML contains blocks starting with '<div class="result results_links'
    const blocks = html.split('<div class="result results_links');
    
    // Skip the first block as it contains pre-results content
    for (let i = 1; i < blocks.length; i++) {
      const block = blocks[i];
      
      // Extract URL & title
      // Format: <a class="result__url" href="[url]">[title]</a>
      const linkMatch = block.match(/<a class="result__url" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
      if (!linkMatch) continue;
      
      let rawUrl = linkMatch[1];
      let title = linkMatch[2].replace(/<[^>]*>/g, "").trim(); // Remove nested HTML tags
      
      // Decode DuckDuckGo redirect link
      // DuckDuckGo redirect URL format: //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com...
      let actualUrl = rawUrl;
      if (actualUrl.includes("uddg=")) {
        const parts = actualUrl.split("uddg=");
        if (parts.length > 1) {
          const encodedUrl = parts[1].split("&")[0];
          try {
            actualUrl = decodeURIComponent(encodedUrl);
          } catch {
            actualUrl = encodedUrl;
          }
        }
      }
      
      // Extract snippet
      // Format: <a class="result__snippet"[^>]*>[snippet]</a>
      const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
      const snippet = snippetMatch 
        ? snippetMatch[1].replace(/<[^>]*>/g, "").trim()
        : "";
        
      results.push({ title, url: actualUrl, snippet });
      
      if (results.length >= 5) break;
    }
    
    return results;
  } catch (error) {
    console.error("DuckDuckGo scraper failed completely:", error);
    return [];
  }
}

export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}
