import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { QuotaExhaustedError } from "./llm-budget";

const realFetch = globalThis.fetch;

beforeEach(() => {
  delete process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_FALLBACK_MODEL;
  delete process.env.SYSQLOW_FALLBACK_ENABLED;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("OpenRouterProvider", () => {
  test("posts OpenAI-shaped JSON and parses the response", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    let capturedBody = "";
    let capturedAuth = "";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      capturedAuth = (init?.headers as any).Authorization;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              status: "outdated",
              reasoning: "looks stale",
              suggested_diff: "--- old\n+++ new",
              source_url: "https://example",
              confidence_score: 7,
            }),
          },
        }],
      }), { status: 200 });
    }) as typeof fetch;

    const { OpenRouterProvider } = await import("./llm-providers");
    const provider = new OpenRouterProvider();
    const result = await provider.runJSON<{ status: string }>("test prompt", "daemon");
    expect(result.status).toBe("outdated");
    expect(capturedAuth).toBe("Bearer or-test");
    const sent = JSON.parse(capturedBody);
    expect(sent.model).toBe("google/gemma-4-31b-it:free");
  });
});

describe("routeWithFallback", () => {
  test("returns Gemini result on success without engaging OpenRouter", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    let openrouterCalled = false;
    globalThis.fetch = (async () => {
      openrouterCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const { routeWithFallback } = await import("./llm-providers");
    const result = await routeWithFallback(
      async () => ({ ok: "gemini" }),
      "daemon",
      "test-call",
    );
    expect(result).toEqual({ ok: "gemini" });
    expect(openrouterCalled).toBe(false);
  });

  test("engages OpenRouter on QuotaExhaustedError from Gemini", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    globalThis.fetch = (async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"ok":"openrouter"}' } }],
    }), { status: 200 })) as unknown as typeof fetch;

    const { routeWithFallback } = await import("./llm-providers");
    const result = await routeWithFallback<{ ok: string }>(
      async () => { throw new QuotaExhaustedError("gemini-2.5-flash", null); },
      "daemon",
      "test prompt for openrouter",
    );
    expect(result).toEqual({ ok: "openrouter" });
  });

  test("does NOT engage OpenRouter on non-quota errors", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    let openrouterCalled = false;
    globalThis.fetch = (async () => {
      openrouterCalled = true;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const { routeWithFallback } = await import("./llm-providers");
    await expect(routeWithFallback(
      async () => { throw new Error("rpm 429"); },
      "daemon",
      "test",
    )).rejects.toThrow("rpm 429");
    expect(openrouterCalled).toBe(false);
  });

  test("propagates QuotaExhaustedError when OPENROUTER_API_KEY is unset", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { routeWithFallback } = await import("./llm-providers");
    await expect(routeWithFallback(
      async () => { throw new QuotaExhaustedError("gemini-2.5-flash", null); },
      "daemon",
      "test",
    )).rejects.toThrow("Gemini quota exhausted");
  });

  test("propagates QuotaExhaustedError when SYSQLOW_FALLBACK_ENABLED=false", async () => {
    process.env.OPENROUTER_API_KEY = "or-test";
    process.env.SYSQLOW_FALLBACK_ENABLED = "false";
    const { routeWithFallback } = await import("./llm-providers");
    await expect(routeWithFallback(
      async () => { throw new QuotaExhaustedError("gemini-2.5-flash", null); },
      "daemon",
      "test",
    )).rejects.toThrow("Gemini quota exhausted");
  });
});
