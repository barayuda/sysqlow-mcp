import { client as defaultClient } from "./db";
import type { Client } from "@libsql/client";

export type GeminiModel = "gemini-2.5-flash" | "gemini-embedding-001";
export type Caller = "interactive" | "daemon";
export type Provider = "gemini" | "openrouter";

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
  // 1. Config table (unchanged).
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

  // 2. Create the quota log table with the new shape if it doesn't exist.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS llm_quota_log (
      date      TEXT NOT NULL,
      provider  TEXT NOT NULL DEFAULT 'gemini',
      model     TEXT NOT NULL,
      count     INTEGER NOT NULL DEFAULT 0,
      exhausted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (date, provider, model)
    )
  `);

  // 3. Migration: pre-existing databases have (date, model) as the PK and no
  //    provider column. Detect via PRAGMA and rebuild.
  const colInfo = await db.execute("PRAGMA table_info(llm_quota_log)");
  const hasProvider = colInfo.rows.some((r: any) => r.name === "provider");
  if (!hasProvider) {
    await db.execute("BEGIN IMMEDIATE");
    try {
      await db.execute("ALTER TABLE llm_quota_log RENAME TO llm_quota_log_old");
      await db.execute(`
        CREATE TABLE llm_quota_log (
          date      TEXT NOT NULL,
          provider  TEXT NOT NULL DEFAULT 'gemini',
          model     TEXT NOT NULL,
          count     INTEGER NOT NULL DEFAULT 0,
          exhausted INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (date, provider, model)
        )
      `);
      await db.execute(`
        INSERT INTO llm_quota_log (date, provider, model, count, exhausted)
        SELECT date, 'gemini', model, count, exhausted FROM llm_quota_log_old
      `);
      await db.execute("DROP TABLE llm_quota_log_old");
      await db.execute("COMMIT");
    } catch (err) {
      await db.execute("ROLLBACK");
      throw err;
    }
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
    // Defense in depth: clamp at 0 in case a pre-existing config row has the
    // reserve ≥ limit. setBudgetConfig rejects this combination going forward,
    // but historical rows or direct DB writes could still produce it.
    return Math.max(0, limit - (await getConfig("flash_daemon_reserve", db)));
  }
  return limit;
}

async function readRow(
  model: string,
  provider: Provider,
  now: Date,
  db: Client,
): Promise<{ count: number; exhausted: boolean }> {
  const res = await db.execute({
    sql: `SELECT count, exhausted FROM llm_quota_log WHERE date = ? AND provider = ? AND model = ?`,
    args: [pacificDate(now), provider, model],
  });
  if (res.rows.length === 0) return { count: 0, exhausted: false };
  return { count: Number(res.rows[0].count), exhausted: Number(res.rows[0].exhausted) === 1 };
}

export async function canSpend(
  model: GeminiModel,
  caller: Caller,
  now: Date = new Date(),
  db: Client = defaultClient,
  provider: Provider = "gemini",
): Promise<boolean> {
  // canSpend stays gemini-typed for now — Task B4 will generalize it.
  // The provider param exists so callers can be explicit; default keeps
  // existing behavior unchanged.
  const { count, exhausted } = await readRow(model, provider, now, db);
  if (exhausted) return false;
  const ceiling = await ceilingFor(model, caller, db);
  return count < ceiling;
}

export async function record(
  model: string,
  provider: Provider = "gemini",
  now: Date = new Date(),
  db: Client = defaultClient,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO llm_quota_log (date, provider, model, count) VALUES (?, ?, ?, 1)
          ON CONFLICT(date, provider, model) DO UPDATE SET count = count + 1`,
    args: [pacificDate(now), provider, model],
  });
}

export async function markExhausted(
  model: string,
  provider: Provider = "gemini",
  now: Date = new Date(),
  db: Client = defaultClient,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO llm_quota_log (date, provider, model, count, exhausted) VALUES (?, ?, ?, 0, 1)
          ON CONFLICT(date, provider, model) DO UPDATE SET exhausted = 1`,
    args: [pacificDate(now), provider, model],
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

  // Only persist a full-day exhaustion when Gemini *explicitly* tags the
  // violation as per-day. Everything else — RetryInfo-only responses, missing
  // details, even multi-minute retry delays from burst limits — classifies as
  // rpm. If we get it wrong, the next 429 will carry the QuotaFailure tag
  // (Gemini is consistent about including it once the daily cap actually
  // breaches) and snap the model shut properly. The cost of that one extra
  // request is much smaller than nuking the model until midnight on a
  // short-lived burst limit.
  const kind: "rpm" | "daily" = isDaily ? "daily" : "rpm";
  return { kind, retryDelayMs };
}

export interface BudgetStatus {
  model: GeminiModel;
  count: number;
  limit: number;
  daemonReserve: number;
  daemonCeiling: number;
  daemonExhausted: boolean;
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
    const { count, exhausted } = await readRow(model, "gemini", now, db);
    const limit = await getConfig(limitKey(model), db);
    const daemonReserve =
      model === "gemini-2.5-flash" ? await getConfig("flash_daemon_reserve", db) : 0;
    const daemonCeiling =
      model === "gemini-2.5-flash" ? Math.max(0, limit - daemonReserve) : limit;
    out.push({
      model,
      count,
      limit,
      daemonReserve,
      daemonCeiling,
      daemonExhausted: count >= daemonCeiling,
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
  // Reject combinations that would wedge the daemon at ceiling=0 forever.
  // Without this guard, every daemon canSpend() silently returns false and no
  // operator-visible error ever fires.
  if (key === "flash_daemon_reserve") {
    const limit = await getConfig("flash_daily_limit", db);
    if (value >= limit) {
      throw new Error(
        `flash_daemon_reserve (${value}) must be strictly less than flash_daily_limit (${limit}); otherwise the daemon ceiling collapses to 0.`,
      );
    }
  }
  if (key === "flash_daily_limit") {
    const reserve = await getConfig("flash_daemon_reserve", db);
    if (value <= reserve) {
      throw new Error(
        `flash_daily_limit (${value}) must be strictly greater than flash_daemon_reserve (${reserve}); otherwise the daemon ceiling collapses to 0.`,
      );
    }
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
