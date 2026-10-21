import { defineConfig } from "vitest/config";

/** The DOM tests with React's scheduler late (src/test/slow-scheduler.ts): `pnpm test:slow`. */
export default defineConfig({
  test: {
    environment: "happy-dom",
    include: ["src/**/*.dom.test.{ts,tsx}"],
    setupFiles: ["./src/test/slow-scheduler.ts", "./src/test/dom-setup.ts"],
  },
});
