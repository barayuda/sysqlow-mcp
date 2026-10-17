import { describe, test, expect } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { ensureBudgetSchema, pacificDate, canSpend, record, markExhausted, parseRetryInfo, getBudgetSnapshot, setBudgetConfig } from "./llm-budget";

async function freshDb(): Promise<Client> {
  const db = createClient({ url: ":memory:" });
  await ensureBudgetSchema(db);
  return db;
}

describe("ensureBudgetSchema", () => {
  test("creates both tables and seeds default config", async () => {
    const db = await freshDb();
    const cfg = await db.execute("SELECT key, value FROM llm_budget_config ORDER BY key");
    const map = Object.fromEntries(cfg.rows.map((r) => [r.key, Number(r.value)]));
    expect(map.flash_daily_limit).toBe(20);
    expect(map.flash_daemon_reserve).toBe(8);
    expect(map.embed_daily_limit).toBe(100);
    expect(map.embed_catchup_per_pass).toBe(10);
    const log = await db.execute("SELECT count(*) AS n FROM llm_quota_log");
    expect(Number(log.rows[0].n)).toBe(0);
  });

  test("is idempotent and does not overwrite edited config", async () => {
    const db = await freshDb();
    await db.execute("UPDATE llm_budget_config SET value = 99 WHERE key = 'flash_daily_limit'");
    await ensureBudgetSchema(db);
    const res = await db.execute("SELECT value FROM llm_budget_config WHERE key = 'flash_daily_limit'");
    expect(Number(res.rows[0].value)).toBe(99);
  });
});

describe("pacificDate", () => {
  test("returns YYYY-MM-DD in America/Los_Angeles", () => {
    // 2026-05-29T05:00:00Z == 2026-05-28 22:00 PDT (still the 28th in LA)
    expect(pacificDate(new Date("2026-05-29T05:00:00Z"))).toBe("2026-05-28");
    // 2026-05-29T08:00:00Z == 2026-05-29 01:00 PDT
    expect(pacificDate(new Date("2026-05-29T08:00:00Z"))).toBe("2026-05-29");
  });

  test("handles PST (winter) offset", () => {
    // 2026-01-15T07:30:00Z == 2026-01-14 23:30 PST (still the 14th)
    expect(pacificDate(new Date("2026-01-15T07:30:00Z"))).toBe("2026-01-14");
  });
});

describe("canSpend / record", () => {
  const NOW = new Date("2026-05-29T20:00:00Z"); // 2026-05-29 in LA

  test("fresh day: both callers allowed", async () => {
    const db = await freshDb();
    expect(await canSpend("gemini-2.5-flash", "interactive", NOW, db)).toBe(true);
    expect(await canSpend("gemini-2.5-flash", "daemon", NOW, db)).toBe(true);
  });

  test("daemon blocked at limit-reserve, interactive still allowed", async () => {
    const db = await freshDb();
    // flash daemon ceiling = flash_daily_limit(20) - flash_daemon_reserve(8) = 12
    for (let i = 0; i < 12; i++) await record("gemini-2.5-flash", "gemini", NOW, db);
    expect(await canSpend("gemini-2.5-flash", "daemon", NOW, db)).toBe(false);
    expect(await canSpend("gemini-2.5-flash", "interactive", NOW, db)).toBe(true);
  });

  test("interactive blocked at absolute limit", async () => {
    const db = await freshDb();
    for (let i = 0; i < 20; i++) await record("gemini-2.5-flash", "gemini", NOW, db);
    expect(await canSpend("gemini-2.5-flash", "interactive", NOW, db)).toBe(false);
  });

  test("counter is per-model and per-day", async () => {
    const db = await freshDb();
    for (let i = 0; i < 20; i++) await record("gemini-2.5-flash", "gemini", NOW, db);
    expect(await canSpend("gemini-embedding-001", "interactive", NOW, db)).toBe(true);
    const tomorrow = new Date("2026-05-30T20:00:00Z");
    expect(await canSpend("gemini-2.5-flash", "interactive", tomorrow, db)).toBe(true);
  });

  test("markExhausted blocks today, clears tomorrow", async () => {
    const db = await freshDb();
    await markExhausted("gemini-2.5-flash", "gemini", NOW, db);
    expect(await canSpend("gemini-2.5-flash", "interactive", NOW, db)).toBe(false);
    const tomorrow = new Date("2026-05-30T20:00:00Z");
    expect(await canSpend("gemini-2.5-flash", "interactive", tomorrow, db)).toBe(true);
  });

  test("embeddings: daemon ceiling == full limit (no reserve)", async () => {
    const db = await freshDb();
    for (let i = 0; i < 99; i++) await record("gemini-embedding-001", "gemini", NOW, db);
    expect(await canSpend("gemini-embedding-001", "daemon", NOW, db)).toBe(true);
    await record("gemini-embedding-001", "gemini", NOW, db);
    expect(await canSpend("gemini-embedding-001", "daemon", NOW, db)).toBe(false);
  });
});

describe("parseRetryInfo", () => {
  const rpmBody = {
    error: {
      code: 429,
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaMetric: "generativelanguage.googleapis.com/generate_content_requests_per_minute" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "27s" },
      ],
    },
  };
  const dailyBody = {
    error: {
      code: 429,
      details: [
        { "@type": "type.googleapis.com/google.rpc.QuotaFailure",
          violations: [{ quotaId: "GenerateRequestsPerDayPerProjectPerModel-FreeTier",
                         quotaMetric: "generativelanguage.googleapis.com/generate_content_requests_per_day" }] },
        { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "53s" },
      ],
    },
  };

  test("classifies per-minute throttle as rpm with delay", () => {
    expect(parseRetryInfo(rpmBody)).toEqual({ kind: "rpm", retryDelayMs: 27000 });
  });
  test("classifies per-day cap as daily regardless of short retryDelay", () => {
    expect(parseRetryInfo(dailyBody)).toEqual({ kind: "daily", retryDelayMs: 53000 });
  });
  test("missing QuotaFailure tag defaults to rpm (never persist exhaustion on ambiguous 429)", () => {
    expect(parseRetryInfo({ error: { code: 429 } })).toEqual({ kind: "rpm", retryDelayMs: null });
  });
  test("RetryInfo-only with multi-minute delay classifies as rpm (not daily)", () => {
    // Real-world burst limits can hand back 90s+ RetryInfo without any
    // QuotaFailure violation tag. Previously these were misclassified as
    // daily and persisted markExhausted; now they stay rpm.
    const body = {
      error: {
        code: 429,
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "90s" }],
      },
    };
    expect(parseRetryInfo(body)).toEqual({ kind: "rpm", retryDelayMs: 90000 });
  });
});

describe("getBudgetSnapshot / setBudgetConfig", () => {
  const NOW = new Date("2026-05-29T20:00:00Z");
  test("snapshot reports per-model count/limit/remaining", async () => {
    const db = await freshDb();
    await record("gemini-2.5-flash", "gemini", NOW, db);
    await record("gemini-2.5-flash", "gemini", NOW, db);
    const snap = await getBudgetSnapshot(NOW, db);
    const flash = snap.find((s) => s.model === "gemini-2.5-flash")!;
    expect(flash.count).toBe(2);
    expect(flash.limit).toBe(20);
    expect(flash.remaining).toBe(18);
    expect(flash.daemonReserve).toBe(8);
    expect(flash.exhausted).toBe(false);
  });
  test("setBudgetConfig updates an existing key and rejects unknown keys", async () => {
    const db = await freshDb();
    await setBudgetConfig("flash_daily_limit", 30, db);
    const snap = await getBudgetSnapshot(NOW, db);
    expect(snap.find((s) => s.model === "gemini-2.5-flash")!.limit).toBe(30);
    await expect(setBudgetConfig("bogus_key", 1, db)).rejects.toThrow();
    await expect(setBudgetConfig("flash_daily_limit", -1, db)).rejects.toThrow();
  });

  test("setBudgetConfig rejects reserve >= limit and limit <= reserve", async () => {
    const db = await freshDb();
    // defaults: flash_daily_limit=20, flash_daemon_reserve=8
    await expect(setBudgetConfig("flash_daemon_reserve", 20, db)).rejects.toThrow(/strictly less/);
    await expect(setBudgetConfig("flash_daemon_reserve", 25, db)).rejects.toThrow(/strictly less/);
    await expect(setBudgetConfig("flash_daily_limit", 8, db)).rejects.toThrow(/strictly greater/);
    await expect(setBudgetConfig("flash_daily_limit", 5, db)).rejects.toThrow(/strictly greater/);
    // valid edge: reserve = limit - 1 is allowed
    await setBudgetConfig("flash_daemon_reserve", 19, db);
  });

  test("snapshot reports daemonCeiling and daemonExhausted", async () => {
    const db = await freshDb();
    // defaults: limit 20, reserve 8 → daemon ceiling 12
    for (let i = 0; i < 12; i++) await record("gemini-2.5-flash", "gemini", NOW, db);
    const snap = await getBudgetSnapshot(NOW, db);
    const flash = snap.find((s) => s.model === "gemini-2.5-flash")!;
    expect(flash.daemonCeiling).toBe(12);
    expect(flash.daemonExhausted).toBe(true);
    expect(flash.exhausted).toBe(false); // interactive still has 8 left
  });

  test("snapshot reflects markExhausted", async () => {
    const db = await freshDb();
    await markExhausted("gemini-2.5-flash", "gemini", NOW, db);
    const snap = await getBudgetSnapshot(NOW, db);
    expect(snap.find((s) => s.model === "gemini-2.5-flash")!.exhausted).toBe(true);
  });
});

describe("getBudgetSnapshot — per-provider", () => {
  test("returns an entry per (provider, model) tuple seen today", async () => {
    const db = await freshDb();
    const NOW = new Date("2026-06-08T20:00:00Z");
    await record("gemini-2.5-flash", "gemini", NOW, db);
    await record("google/gemma-4-31b-it:free", "openrouter", NOW, db);
    const snap = await getBudgetSnapshot(NOW, db);
    const providers = snap.map((s: any) => s.provider).sort();
    expect(providers).toContain("gemini");
    expect(providers).toContain("openrouter");
  });
});

describe("provider-aware quota log migration", () => {
  test("ensureBudgetSchema backfills provider='gemini' on pre-existing rows", async () => {
    const db = createClient({ url: ":memory:" });
    // Simulate an *old* schema (pre-migration) and pre-existing data
    await db.execute(`
      CREATE TABLE llm_quota_log (
        date TEXT NOT NULL, model TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 0,
        exhausted INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (date, model)
      )
    `);
    await db.execute({
      sql: "INSERT INTO llm_quota_log (date, model, count) VALUES (?, ?, ?)",
      args: ["2026-06-01", "gemini-2.5-flash", 15],
    });

    await ensureBudgetSchema(db);

    const res = await db.execute("SELECT date, provider, model, count FROM llm_quota_log");
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0].provider).toBe("gemini");
    expect(Number(res.rows[0].count)).toBe(15);
  });

  test("canSpend and record operate on a (date, provider, model) tuple", async () => {
    const db = await freshDb();
    const NOW = new Date("2026-06-08T20:00:00Z");
    await record("gemini-2.5-flash", "gemini", NOW, db);
    await record("google/gemma-4-31b-it:free", "openrouter", NOW, db);
    const rows = await db.execute("SELECT provider, model, count FROM llm_quota_log ORDER BY provider");
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows[0].provider).toBe("gemini");
    expect(rows.rows[1].provider).toBe("openrouter");

    // Bug-trap: if canSpend's WHERE clause ignored the provider column,
    // the 1 openrouter record above would count toward gemini's daily cap.
    const canSpendGemini = await canSpend("gemini-2.5-flash", "interactive", NOW, db);
    expect(canSpendGemini).toBe(true);
  });
});
