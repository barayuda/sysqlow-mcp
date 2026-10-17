import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { collectCodebaseFiles } from "./learn";

describe("collectCodebaseFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sysqlow-learn-test-"));
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  });

  test("returns empty result when path does not exist", async () => {
    const result = await collectCodebaseFiles(join(dir, "nope-does-not-exist"));
    expect(result.detectedFiles).toEqual([]);
    expect(result.files).toEqual([]);
    expect(result.combinedContent).toBe("");
  });

  test("reads manifest files and prefers package.json name over basename", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "mc-id-frontend", version: "1.0.0" }));
    writeFileSync(join(dir, "README.md"), "# MC-ID Frontend\n\nThis is the readme.");
    writeFileSync(join(dir, "tsconfig.json"), `{"compilerOptions":{"strict":true}}`);
    // Noise file — should be ignored.
    writeFileSync(join(dir, "random.txt"), "not a manifest");

    const result = await collectCodebaseFiles(dir);

    expect(result.projectName).toBe("mc-id-frontend");
    expect(result.detectedFiles.sort()).toEqual(["README.md", "package.json", "tsconfig.json"]);
    expect(result.files).toHaveLength(3);
    expect(result.combinedContent).toContain("=== FILE: package.json ===");
    expect(result.combinedContent).toContain("=== FILE: README.md ===");
    expect(result.combinedContent).toContain("=== FILE: tsconfig.json ===");
  });

  test("truncates files larger than 6KB and flags the truncation", async () => {
    const big = "x".repeat(10_000);
    writeFileSync(join(dir, "README.md"), big);

    const result = await collectCodebaseFiles(dir);

    expect(result.files).toHaveLength(1);
    expect(result.files[0].truncated).toBe(true);
    expect(result.files[0].content.length).toBeLessThan(big.length);
    expect(result.files[0].content).toContain("[... content truncated for brevity ...]");
  });

  test("falls back to directory basename when package.json has no name", async () => {
    const subdir = join(dir, "no-name-project");
    mkdirSync(subdir);
    writeFileSync(join(subdir, "package.json"), JSON.stringify({ version: "1.0.0" }));

    const result = await collectCodebaseFiles(subdir);

    expect(result.projectName).toBe("no-name-project");
    expect(result.detectedFiles).toEqual(["package.json"]);
  });

  test("uses composer.json name when package.json is absent", async () => {
    writeFileSync(join(dir, "composer.json"), JSON.stringify({ name: "vendor/laravel-app", type: "project" }));

    const result = await collectCodebaseFiles(dir);

    expect(result.projectName).toBe("vendor/laravel-app");
    expect(result.detectedFiles).toEqual(["composer.json"]);
  });
});
