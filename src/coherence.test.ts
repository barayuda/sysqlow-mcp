import { describe, test, expect } from "bun:test";
import { canRelate } from "./coherence";

describe("canRelate", () => {
  test("two nulls (both generic) → true", () => {
    expect(canRelate(null, null)).toBe(true);
  });
  test("source null, target project → true (generic→project allowed)", () => {
    expect(canRelate(null, "proj-a")).toBe(true);
  });
  test("source project, target null → true (project→generic allowed)", () => {
    expect(canRelate("proj-a", null)).toBe(true);
  });
  test("same project on both sides → true", () => {
    expect(canRelate("proj-a", "proj-a")).toBe(true);
  });
  test("different projects → false (the invariant)", () => {
    expect(canRelate("proj-a", "proj-b")).toBe(false);
  });
});
