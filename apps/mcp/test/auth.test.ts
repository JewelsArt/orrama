import { describe, expect, it } from "vitest";
import { authHeader } from "../src/auth.js";

describe("authHeader", () => {
  it("sends the token once-prefixed, whether it was pasted whole or bare", () => {
    expect(authHeader("bslt_abc123")).toBe("Bearer bslt_abc123");
    expect(authHeader("abc123")).toBe("Bearer bslt_abc123"); // configs that stripped it keep working
    expect(authHeader("  bslt_abc123\n")).toBe("Bearer bslt_abc123");
    expect(authHeader("Bearer bslt_abc123")).toBe("Bearer bslt_abc123");
  });
});
