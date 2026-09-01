# Resilience Fallbacks: OpenRouter (chat) + multi-tier search

**Status:** accepted
**Extends:** ADR-0001 (Gemini-only). Does NOT supersede it.

## Context

ADR-0001 committed sysqlow-mcp to Gemini as the sole LLM provider, arguing that
a single budgeting story beats carrying unused fallback paths. That argument
still holds for the *primary* path. What it does NOT address is the failure mode
where the primary path is *unavailable for the next ~12 hours* — daily quota
exhaustion on the Gemini free tier. Under that condition the Sentinel daemon,
the codebase-learner, and the documentation-extractor all hard-fail until midnight
Pacific.

The same shape of fragility exists on the web-search axis: Sentinel needs fresh
documentation snippets to ground its LLM validation, and the previous Brave →
DDG-HTML chain degraded silently when Brave was unkeyed AND DDG's HTML endpoint
was IP-blocked (a routine occurrence on Docker / data-center egress).

## Decision

Add two narrowly-scoped fallback chains:

1. **Chat-completion fallback (OpenRouter).** `validateContentWithLLM`,
   `analyzeCodebaseWithLLM`, and `extractDocumentationWithLLM` are wrapped in
   `routeWithFallback`. The fallback engages *only* on `QuotaExhaustedError`
   (daily-quota signal from the budget guard) — not on rpm-429s, not on
   transient 5xx, not on network errors. Embeddings stay Gemini-only;
   semantic search already degrades to FTS5/LIKE when embeddings fail.
2. **Search-provider chain.** Tavily → SearXNG → DDG (last-resort, opt-out via
   `SYSQLOW_DDG_FALLBACK=false`). When every tier returns empty, Sentinel
   short-circuits with `validation_status="unverifiable"` rather than calling
   the LLM with no evidence — eliminating false-positive "up_to_date" stamps
   produced from LLM training data alone.

Both fallbacks are off by default and require explicit env-var configuration
(`OPENROUTER_API_KEY`, `SEARXNG_URL`/`TAVILY_API_KEY`).

## Why this is an extension, not a supersession of ADR-0001

ADR-0001 deleted the *paid* OpenAI fallback because OpenAI did not solve the
daily-cap problem we were protecting. OpenRouter, used here specifically against
Gemini's daily cap, is the opposite: it exists *only* to bridge the daily-cap
gap. The maintenance-simplicity argument from ADR-0001 stays honest because:

- Embeddings remain single-provider.
- The fallback is one OpenAI-compatible HTTP shape, not a parallel SDK and
  parallel call-sites in every helper.
- All calls (Gemini primary + OpenRouter fallback) flow through the same
  budget log, just on different `provider` tuples.

## Naming discipline

User-facing surfaces (MCP tools, dashboard, env docs) say **"fallback"** —
never "OpenRouter". Provider lock-in by name was an ADR-0001 anti-pattern;
this ADR preserves the lesson.

## Cost reality

OpenRouter free tier is 50 requests/day account-wide without credits — usable
as a true emergency floor only. The realistic per-account ceiling is the
one-time $10 credit purchase which permanently raises the cap to 1,000
requests/day. The roadmap and env docs state this explicitly.

## Consequences

- Two new optional env vars at the LLM layer: `OPENROUTER_API_KEY`,
  `OPENROUTER_FALLBACK_MODEL` (default `google/gemma-4-31b-it:free`),
  `SYSQLOW_FALLBACK_ENABLED`.
- Two new optional env vars at the search layer: `SEARXNG_URL`,
  `SYSQLOW_DDG_FALLBACK`.
- `llm_quota_log` PK grows to `(date, provider, model)` via auto-migration
  that backfills `provider='gemini'` for existing rows.
- ValidationReport gains an `unverifiable` status. Downstream consumers
  (list_outdated_knowledge MCP tool, dashboard) treat it the same as
  `outdated`/`incorrect` for triage purposes.

Re-introducing OpenAI later (against the ADR-0001 decision) is still
discouraged. Adding a different chat fallback provider would mean
swapping `OpenRouterProvider` for another `LLMProvider` implementation —
the interface keeps that swap narrow.
