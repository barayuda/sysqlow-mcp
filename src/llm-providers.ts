import { QuotaExhaustedError, record as recordQuota, type Caller } from "./llm-budget";

const DEFAULT_OPENROUTER_MODEL = "google/gemma-4-31b-it:free";
const OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

function cleanLLMJson(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```json")) cleaned = cleaned.substring(7);
  else if (cleaned.startsWith("```")) cleaned = cleaned.substring(3);
  if (cleaned.endsWith("```")) cleaned = cleaned.substring(0, cleaned.length - 3);
  cleaned = cleaned.trim();
  return cleaned.replace(/(?<!\\)\\(?!["\\/bfnrtu])/g, "\\\\");
}

export interface LLMProvider {
  readonly name: "gemini" | "openrouter";
  runJSON<T>(prompt: string, caller: Caller): Promise<T>;
}

export class OpenRouterProvider implements LLMProvider {
  readonly name = "openrouter" as const;

  async runJSON<T>(prompt: string, caller: Caller): Promise<T> {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not set");
    const model = process.env.OPENROUTER_FALLBACK_MODEL || DEFAULT_OPENROUTER_MODEL;

    const res = await fetch(OPENROUTER_ENDPOINT, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/barayuda/sysqlow-mcp",
        "X-Title": "sysqlow-mcp",
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      throw new Error(`OpenRouter request failed with status ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as any;
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new Error(`OpenRouter response missing choices[0].message.content: ${JSON.stringify(data).slice(0, 200)}`);
    }

    // Record the spend on the OpenRouter axis so the budget tile and snapshot reflect it.
    await recordQuota(model, "openrouter").catch(() => {/* non-fatal */});

    return JSON.parse(cleanLLMJson(content)) as T;
  }
}

const orProvider = new OpenRouterProvider();

/**
 * Wraps a primary-provider (Gemini) call so that a daily-quota exhaustion
 * automatically routes the same prompt through OpenRouter.
 *
 * Only `QuotaExhaustedError` from the budget guard triggers the fallback.
 * RPM-429 throttles, transient 5xx, network errors etc. propagate as-is —
 * those are handled by the existing retry loop in src/llm.ts and do not
 * justify burning OpenRouter's monthly cap on transient blips.
 */
export async function routeWithFallback<T>(
  primary: () => Promise<T>,
  caller: Caller,
  prompt: string,
): Promise<T> {
  try {
    return await primary();
  } catch (err: any) {
    if (err?.name !== "QuotaExhaustedError") throw err;
    // ADR-0002: fallback only engages on a true *daily* exhaustion. RPM-429
    // throttles share the same error class but set isDaily=false; they should
    // propagate so the caller's retry loop handles them, not burn OpenRouter
    // budget.
    if (err?.isDaily !== true) throw err;
    const fallbackEnabled = (process.env.SYSQLOW_FALLBACK_ENABLED ?? "true").toLowerCase() !== "false";
    if (!fallbackEnabled || !process.env.OPENROUTER_API_KEY) throw err;
    console.error(`[LLM Fallback] Gemini daily quota exhausted; routing to OpenRouter.`);
    return await orProvider.runJSON<T>(prompt, caller);
  }
}
