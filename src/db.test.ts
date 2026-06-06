import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// db.ts runs side effects (env validation, fs.mkdirSync, client creation) at
// module-load time, and Bun caches modules across tests within a single run.
// To test boot-time behavior honestly we spawn a fresh subprocess per case
// with a small inline harness that imports db.ts and prints the result.
//
// Two pitfalls the subprocess approach can fall into:
//   (1) Resolving "./src/db.ts" against the subprocess cwd couples the test
//       to being run from the repo root (`cd src && bun test ...` would
//       fail with a module-not-found error in the subprocess instead of a
//       meaningful test failure). We resolve an absolute path via
//       import.meta.dir and pass it through to the harness.
//   (2) The "flag off" probe leaves both SYSQLOW_DB_REMOTE_ONLY and
//       TURSO_DATABASE_URL empty, which falls through to local-only mode
//       and creates an actual SQLite file at LOCAL_DB_PATH (default
//       "sysqlow.db" in cwd). To prevent that file landing in the repo
//       tree, every probe gets LOCAL_DB_PATH pointed at a unique path
//       inside an OS tmp dir that we wipe in afterAll.

const DB_TS_PATH = resolve(import.meta.dir, "db.ts");
let tmpRoot: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "sysqlow-db-test-"));
});

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

async function probeDbBoot(env: Record<string, string>): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  const harness = `
    try {
      const mod = await import(${JSON.stringify(DB_TS_PATH)});
      console.log(JSON.stringify({
        ok: true,
        isRemoteOnly: mod.isRemoteOnly,
        isEmbeddedReplica: mod.isEmbeddedReplica,
      }));
    } catch (err) {
      console.log(JSON.stringify({ ok: false, message: String(err && err.message || err) }));
      process.exit(1);
    }
  `;
  // Per-call tmp DB path so concurrent / repeated probes don't share a file.
  // The caller can still override LOCAL_DB_PATH explicitly via the env arg
  // (none of the current tests do — they care about mode selection, not DB
  // behavior — but the override path stays open for future cases).
  const localDbPath = join(tmpRoot, `${crypto.randomUUID()}.db`);
  const proc = Bun.spawn({
    cmd: ["bun", "-e", harness],
    cwd: process.cwd(),
    env: {
      ...process.env,
      LOCAL_DB_PATH: localDbPath,
      ...env,
      // Explicit fall-through so an empty-string override from the caller
      // wins over an inherited shell value.
      SYSQLOW_DB_REMOTE_ONLY: env.SYSQLOW_DB_REMOTE_ONLY ?? "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

describe("SYSQLOW_DB_REMOTE_ONLY", () => {
  test("flag off: behavior unchanged (local-only when no URL set)", async () => {
    const { exitCode, stdout } = await probeDbBoot({
      SYSQLOW_DB_REMOTE_ONLY: "",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "",
    });
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result.ok).toBe(true);
    expect(result.isRemoteOnly).toBe(false);
    expect(result.isEmbeddedReplica).toBe(false);
  });

  test("flag on with valid libsql URL + token: boots in remote-only mode", async () => {
    const { exitCode, stdout, stderr } = await probeDbBoot({
      SYSQLOW_DB_REMOTE_ONLY: "1",
      TURSO_DATABASE_URL: "libsql://fake-host.turso.io",
      TURSO_AUTH_TOKEN: "fake-token",
    });
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result.ok).toBe(true);
    expect(result.isRemoteOnly).toBe(true);
    expect(result.isEmbeddedReplica).toBe(false);
    expect(stderr).toContain("mode=remote-only");
  });

  test("flag on without TURSO_DATABASE_URL: throws at boot", async () => {
    const { exitCode, stdout } = await probeDbBoot({
      SYSQLOW_DB_REMOTE_ONLY: "1",
      TURSO_DATABASE_URL: "",
      TURSO_AUTH_TOKEN: "fake-token",
    });
    expect(exitCode).not.toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("requires TURSO_DATABASE_URL");
  });

  test("flag on with file: URL: rejects (must be libsql/https)", async () => {
    const { exitCode, stdout } = await probeDbBoot({
      SYSQLOW_DB_REMOTE_ONLY: "1",
      TURSO_DATABASE_URL: "file:./sysqlow.db",
      TURSO_AUTH_TOKEN: "fake-token",
    });
    expect(exitCode).not.toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("libsql:// or https://");
  });

  test("flag on without TURSO_AUTH_TOKEN: throws at boot", async () => {
    const { exitCode, stdout } = await probeDbBoot({
      SYSQLOW_DB_REMOTE_ONLY: "1",
      TURSO_DATABASE_URL: "libsql://fake-host.turso.io",
      TURSO_AUTH_TOKEN: "",
    });
    expect(exitCode).not.toBe(0);
    const result = JSON.parse(stdout.trim().split("\n").pop()!);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("requires TURSO_AUTH_TOKEN");
  });

  test("accepts 'true' and 'yes' as truthy values", async () => {
    for (const value of ["true", "yes", "TRUE"]) {
      const { exitCode, stdout } = await probeDbBoot({
        SYSQLOW_DB_REMOTE_ONLY: value,
        TURSO_DATABASE_URL: "libsql://fake-host.turso.io",
        TURSO_AUTH_TOKEN: "fake-token",
      });
      expect(exitCode).toBe(0);
      const result = JSON.parse(stdout.trim().split("\n").pop()!);
      expect(result.isRemoteOnly).toBe(true);
    }
  });
});
