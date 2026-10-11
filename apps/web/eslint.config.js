// ESLint for the web app: the two React hooks rules and nothing else (audit
// REG-016). The code carried `eslint-disable react-hooks/exhaustive-deps`
// comments for years with no linter installed, so a hook whose dependency list
// went stale by accident looked exactly like one left short on purpose.
// Types are tsc's job; style is nobody's. `pnpm lint` runs this; CI runs it.
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "react-hooks": reactHooks },
    // A suppression for a rule that is not on, or one that no longer
    // suppresses anything, is an error too: every eslint-disable stays true.
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
