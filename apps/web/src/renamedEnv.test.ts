import { describe, expect, it } from "vitest";
import { renamedEnvProblems } from "../renamedEnv";

describe("the dev server's renamed port variables", () => {
  it("refuses BASALT_API_PORT without ORRAMA_API_PORT, which would proxy to the live agent", () => {
    expect(renamedEnvProblems({ BASALT_API_PORT: "4627" })).toEqual([
      "BASALT_API_PORT is set but ORRAMA_API_PORT is not: set ORRAMA_API_PORT instead (BASALT_ names are no longer read)",
    ]);
    expect(renamedEnvProblems({ BASALT_WEB_PORT: "4625" })[0]).toMatch(/^BASALT_WEB_PORT is set but ORRAMA_WEB_PORT is not/);
    expect(renamedEnvProblems({ BASALT_API_PORT: "4627", ORRAMA_API_PORT: "4627" })).toEqual([]);
    expect(renamedEnvProblems({})).toEqual([]);
  });
});
