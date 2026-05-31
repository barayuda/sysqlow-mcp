import { describe, test, expect } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { ensureBudgetSchema, pacificDate, canSpend, record, markExhausted } from "./llm-budget";

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
    for (let i = 0; i < 12; i++) await record("gemini-2.5-flash", NOW, db);
    expect(await canSpend("gemini-2.5-flash", "daemon", NOW, db)).toBe(false);
    expect(await canSpend("gemini-2.5-flash", "interactive", NOW, db)).toBe(true);
  });

  test("interactive blocked at absolute limit", async () => {
    const db = await freshDb();
    for (let i = 0; i < 20; i++) await record("gemini-2.5-flash", NOW, db);
    expect(await canSpend("gemini-2.5-flash", "interactive", NOW, db)).toBe(false);
  });

  test("counter is per-model and per-day", async () => {
    const db = await freshDb();
    for (let i = 0; i < 20; i++) await record("gemini-2.5-flash", NOW, db);
    expect(await canSpend("gemini-embedding-001", "interactive", NOW, db)).toBe(true);
    const tomorrow = new Date("2026-05-30T20:00:00Z");
    expect(await canSpend("gemini-2.5-flash", "interactive", tomorrow, db)).toBe(true);
  });

  test("markExhausted blocks today, clears tomorrow", async () => {
    const db = await freshDb();
    await markExhausted("gemini-2.5-flash", NOW, db);
    expect(await canSpend("gemini-2.5-flash", "interactive", NOW, db)).toBe(false);
    const tomorrow = new Date("2026-05-30T20:00:00Z");
    expect(await canSpend("gemini-2.5-flash", "interactive", tomorrow, db)).toBe(true);
  });

  test("embeddings: daemon ceiling == full limit (no reserve)", async () => {
    const db = await freshDb();
    for (let i = 0; i < 99; i++) await record("gemini-embedding-001", NOW, db);
    expect(await canSpend("gemini-embedding-001", "daemon", NOW, db)).toBe(true);
    await record("gemini-embedding-001", NOW, db);
    expect(await canSpend("gemini-embedding-001", "daemon", NOW, db)).toBe(false);
  });
});
