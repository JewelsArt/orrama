import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Many suites write their fixture notes into a temp vault and then seed it.
    // Outside the tests, seed refuses a vault that already holds notes (audit
    // REG-013); this is the explicit "I know, it is a scratch vault".
    env: { ORRAMA_SEED_INTO_EXISTING_VAULT: "1" },
    setupFiles: ["test/helpers/open-databases.ts"],
  },
});
