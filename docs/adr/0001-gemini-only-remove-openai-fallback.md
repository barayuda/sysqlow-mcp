# Gemini-only: remove the OpenAI fallback

**Status:** accepted

The problem we are solving is *free-tier Gemini quota exhaustion* (gemini-2.5-flash, ~20 generate-content requests/day). That problem is specific to a free, daily-capped key. OpenAI is a paid API with different limits and no daily-cap failure mode, so it does not participate in the quota we are protecting.

We decided to **delete the OpenAI fallback paths** (`runOpenAIJSONGeneric`, `embedOpenAI`, and the `OPENAI_API_KEY` branches in `validateContentWithLLM`, `extractDocumentationWithLLM`, `analyzeCodebaseWithLLM`, `generateEmbedding`) and commit to Gemini-only. The exported LLM helpers now throw if `GEMINI_API_KEY` is unset.

## Considered options

- **Leave OpenAI dormant** (inert when `OPENAI_API_KEY` is unset). Zero churn, but leaves an *unbudgeted* code path: if the key is ever set, those calls bypass the budget guard entirely, and the two key-presence branches in every helper are dead weight a future reader must reason about.
- **Budget-wrap OpenAI too.** Contradicts the goal — OpenAI is paid and has no daily-cap problem to solve.
- **Remove entirely (chosen).** Single LLM provider means one budgeting story, no bypass, less surface to maintain. Aligns with the org preference for maintainable long-term solutions over carrying unused fallbacks.

## Consequences

- `OPENAI_API_KEY` is removed from the docs/env table.
- The fallback is gone permanently; re-introducing OpenAI later means restoring the helpers *and* deciding how they interact with the budget guard. Git history preserves the deleted code.
