import { describe, test, expect } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { ensureBudgetSchema } from "./llm-budget";

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
