import { describe, test, expect } from "bun:test";
import { QuotaExhaustedError } from "./llm-budget";

describe("QuotaExhaustedError", () => {
  test("carries model and retryAfterMs", () => {
    const e = new QuotaExhaustedError("gemini-2.5-flash", 27000);
    expect(e).toBeInstanceOf(Error);
    expect(e.model).toBe("gemini-2.5-flash");
    expect(e.retryAfterMs).toBe(27000);
    expect(e.name).toBe("QuotaExhaustedError");
  });
});
