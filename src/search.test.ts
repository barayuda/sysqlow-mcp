import { describe, test, expect, beforeEach, afterEach } from "bun:test";

const realFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.TAVILY_API_KEY;
  delete process.env.SEARXNG_URL;
  delete process.env.SYSQLOW_DDG_FALLBACK;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    return handler(url, init);
  }) as typeof fetch;
}

describe("searchSearXNG (via webSearch)", () => {
  test("returns parsed results when SEARXNG_URL is set and Tavily is absent", async () => {
    process.env.SEARXNG_URL = "http://searxng.local:8080";
    const fakeBody = {
      results: [
        { title: "Doc A", url: "https://a.example", content: "snippet A" },
        { title: "Doc B", url: "https://b.example", content: "snippet B" },
      ],
    };
    mockFetch(async (url) => {
      expect(url).toContain("http://searxng.local:8080/search");
      expect(url).toContain("q=hello+world");
      expect(url).toContain("format=json");
      return new Response(JSON.stringify(fakeBody), { status: 200 });
    });

    const { webSearch } = await import("./search");
    const results = await webSearch("hello world");
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ title: "Doc A", url: "https://a.example", snippet: "snippet A" });
  });
});

describe("DDG fallback opt-out", () => {
  test("returns empty when no provider configured and SYSQLOW_DDG_FALLBACK=false", async () => {
    process.env.SYSQLOW_DDG_FALLBACK = "false";
    // No TAVILY_API_KEY, no SEARXNG_URL, DDG disabled
    let fetchCalled = false;
    mockFetch(async () => {
      fetchCalled = true;
      return new Response("should not be called", { status: 200 });
    });

    const { webSearch } = await import("./search");
    const results = await webSearch("anything");
    expect(results).toEqual([]);
    expect(fetchCalled).toBe(false);
  });

  test("DDG fires when SYSQLOW_DDG_FALLBACK is unset (default true)", async () => {
    let lastUrl = "";
    mockFetch(async (url) => {
      lastUrl = url;
      return new Response("<html><body>no results blocks here</body></html>", { status: 200 });
    });

    const { webSearch } = await import("./search");
    await webSearch("test");
    expect(lastUrl).toContain("html.duckduckgo.com");
  });
});
