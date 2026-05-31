import { client as defaultClient } from "./db";
import type { Client } from "@libsql/client";

export type GeminiModel = "gemini-2.5-flash" | "gemini-embedding-001";
export type Caller = "interactive" | "daemon";

export class QuotaExhaustedError extends Error {
  constructor(public model: GeminiModel, public retryAfterMs: number | null) {
    super(`Gemini quota exhausted for model ${model}`);
    this.name = "QuotaExhaustedError";
  }
}

const DEFAULT_CONFIG: Record<string, number> = {
  flash_daily_limit: 20,
  flash_daemon_reserve: 8,
  embed_daily_limit: 100,
  embed_catchup_per_pass: 10,
};

export async function ensureBudgetSchema(db: Client = defaultClient): Promise<void> {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS llm_quota_log (
      date      TEXT NOT NULL,
      model     TEXT NOT NULL,
      count     INTEGER NOT NULL DEFAULT 0,
      -- 1 = daily cap reached for this Pacific date; resets automatically when tomorrow's row is read
      exhausted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, model)
    )
  `);
  await db.execute(`
    CREATE TABLE IF NOT EXISTS llm_budget_config (
      key   TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    )
  `);
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    await db.execute({
      sql: `INSERT OR IGNORE INTO llm_budget_config (key, value) VALUES (?, ?)`,
      args: [key, value],
    });
  }
}
