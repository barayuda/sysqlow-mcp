export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export async function webSearch(query: string): Promise<SearchResult[]> {
  const braveKey = process.env.BRAVE_API_KEY;
  if (braveKey) {
    console.error(`Using Brave Search API for query: "${query}"`);
    try {
      return await searchBrave(query, braveKey);
    } catch (e) {
      console.error("Brave Search failed, falling back to DuckDuckGo scraper:", e);
    }
  }
  
  console.error(`Using DuckDuckGo fallback scraper for query: "${query}"`);
  return await searchDuckDuckGo(query);
}

async function searchBrave(query: string, apiKey: string): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`;
  const res = await fetch(url, {
    headers: {
      "X-Subscription-Token": apiKey,
      "Accept": "application/json"
    }
  });
  
  if (!res.ok) {
    throw new Error(`Brave Search API failed with status ${res.status}: ${await res.text()}`);
  }
  
  const data = await res.json() as any;
  const webResults = data.web?.results || [];
  return webResults.map((r: any) => ({
    title: r.title || "",
    url: r.url || "",
    snippet: r.description || ""
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
