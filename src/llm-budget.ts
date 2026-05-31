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

async function getConfig(key: string, db: Client): Promise<number> {
  const res = await db.execute({
    sql: `SELECT value FROM llm_budget_config WHERE key = ?`,
    args: [key],
  });
  if (res.rows.length === 0) {
    const fallback = DEFAULT_CONFIG[key];
    if (fallback === undefined) throw new Error(`Unknown budget config key: ${key}`);
    return fallback;
  }
  return Number(res.rows[0].value);
}

function limitKey(model: GeminiModel): string {
  return model === "gemini-2.5-flash" ? "flash_daily_limit" : "embed_daily_limit";
}

async function ceilingFor(model: GeminiModel, caller: Caller, db: Client): Promise<number> {
  const limit = await getConfig(limitKey(model), db);
  if (caller === "interactive") return limit;
  if (model === "gemini-2.5-flash") {
    return limit - (await getConfig("flash_daemon_reserve", db));
  }
  return limit;
}

async function readRow(
  model: GeminiModel,
  now: Date,
  db: Client,
): Promise<{ count: number; exhausted: boolean }> {
  const res = await db.execute({
    sql: `SELECT count, exhausted FROM llm_quota_log WHERE date = ? AND model = ?`,
    args: [pacificDate(now), model],
  });
  if (res.rows.length === 0) return { count: 0, exhausted: false };
  return { count: Number(res.rows[0].count), exhausted: Number(res.rows[0].exhausted) === 1 };
}

export async function canSpend(
  model: GeminiModel,
  caller: Caller,
  now: Date = new Date(),
  db: Client = defaultClient,
): Promise<boolean> {
  const { count, exhausted } = await readRow(model, now, db);
  if (exhausted) return false;
  const ceiling = await ceilingFor(model, caller, db);
  return count < ceiling;
}

export async function record(
  model: GeminiModel,
  now: Date = new Date(),
  db: Client = defaultClient,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO llm_quota_log (date, model, count) VALUES (?, ?, 1)
          ON CONFLICT(date, model) DO UPDATE SET count = count + 1`,
    args: [pacificDate(now), model],
  });
}

export async function markExhausted(
  model: GeminiModel,
  now: Date = new Date(),
  db: Client = defaultClient,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO llm_quota_log (date, model, count, exhausted) VALUES (?, ?, 0, 1)
          ON CONFLICT(date, model) DO UPDATE SET exhausted = 1`,
    args: [pacificDate(now), model],
  });
}

export function parseRetryInfo(body: any): { kind: "rpm" | "daily"; retryDelayMs: number | null } {
  const details: any[] = body?.error?.details ?? [];
  let retryDelayMs: number | null = null;
  let isDaily = false;

  for (const d of details) {
    const type = String(d?.["@type"] ?? "");
    if (type.includes("RetryInfo") && typeof d.retryDelay === "string") {
      const m = d.retryDelay.match(/^([\d.]+)s$/);
      if (m) retryDelayMs = Math.round(parseFloat(m[1]) * 1000);
    }
    if (type.includes("QuotaFailure")) {
      for (const v of d?.violations ?? []) {
        const tag = `${v?.quotaId ?? ""} ${v?.quotaMetric ?? ""}`.toLowerCase();
        if (tag.includes("perday") || tag.includes("per_day") || tag.includes("requests_per_day") || tag.includes("daily")) {
          isDaily = true;
        }
      }
    }
  }

  // A 429 we can't positively identify as per-minute is treated as daily so we
  // stop hammering a cap that won't clear until midnight.
  const kind: "rpm" | "daily" =
    isDaily ? "daily" : retryDelayMs !== null && retryDelayMs < 60_000 ? "rpm" : "daily";
  return { kind, retryDelayMs };
}

export interface BudgetStatus {
  model: GeminiModel;
  count: number;
  limit: number;
  daemonReserve: number;
  remaining: number;
  exhausted: boolean;
  resetsAt: string;
}

export async function getBudgetSnapshot(
  now: Date = new Date(),
  db: Client = defaultClient,
): Promise<BudgetStatus[]> {
  const models: GeminiModel[] = ["gemini-2.5-flash", "gemini-embedding-001"];
  const out: BudgetStatus[] = [];
  for (const model of models) {
    const { count, exhausted } = await readRow(model, now, db);
    const limit = await getConfig(limitKey(model), db);
    const daemonReserve =
      model === "gemini-2.5-flash" ? await getConfig("flash_daemon_reserve", db) : 0;
    out.push({
      model,
      count,
      limit,
      daemonReserve,
      remaining: Math.max(0, limit - count),
      exhausted,
      resetsAt: "midnight America/Los_Angeles",
    });
  }
  return out;
}

export async function setBudgetConfig(
  key: string,
  value: number,
  db: Client = defaultClient,
): Promise<void> {
  if (!(key in DEFAULT_CONFIG)) {
    throw new Error(
      `Unknown budget config key "${key}". Valid keys: ${Object.keys(DEFAULT_CONFIG).join(", ")}`,
    );
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Budget config value must be a non-negative integer, got ${value}.`);
  }
  await db.execute({
    sql: `INSERT INTO llm_budget_config (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = ?`,
    args: [key, value, value],
  });
}

const PACIFIC_DATE_FMT = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function pacificDate(now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return PACIFIC_DATE_FMT.format(now);
}
