import { defineConfig } from "vitest/config";

/**
 * Two kinds of test. Plain `*.test.ts(x)` run in Node: pure functions, the API client with a
 * stubbed fetch, static markup. `*.dom.test.ts(x)` run in happy-dom with Testing Library, for
 * what only a DOM can show: focus, keys, dialogs, routing, a component's effects (WEB-020).
 */
export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: { name: "unit", environment: "node", include: ["src/**/*.test.{ts,tsx}"], exclude: ["src/**/*.dom.test.{ts,tsx}"] },
      },
      {
        extends: true,
        test: { name: "dom", environment: "happy-dom", include: ["src/**/*.dom.test.{ts,tsx}"], setupFiles: ["./src/test/dom-setup.ts"] },
      },
    ],
  },
});
