// ESLint for the web app: the two React hooks rules, and one of our own (audit
// REG-016, WEB-010). The code carried `eslint-disable react-hooks/exhaustive-deps`
// comments for years with no linter installed, so a hook whose dependency list
// went stale by accident looked exactly like one left short on purpose.
// Types are tsc's job; style is nobody's. `pnpm lint` runs this; CI runs it.
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * A failed write is never silent (WEB-010): `onClick={async () => { await api(…) }}` stops at
 * the first line when the server says no, and only the console hears it. An async function
 * handed straight to an element's event (`on…=` on a DOM element or a control that passes
 * events through) must catch what it awaits — or be written with `attempt`/`useWrite` from
 * ui/writes.ts, which do. Callbacks a component awaits itself (NameDialog's onSubmit, a
 * Confirm's onConfirm) are that component's business and are not judged here.
 */
const PASSES_EVENTS = new Set(["Button", "LinkButton", "Form", "Input", "Select", "Textarea", "SearchField", "Checkbox", "Switch", "Chip"]);
const asyncHandlerCatches = {
  meta: {
    type: "problem",
    messages: {
      uncaught:
        "This async {{name}} awaits outside a try/catch: a failed write would be silent (WEB-010). Use attempt() or useWrite() from ui/writes.ts, or catch it.",
    },
    schema: [],
  },
  create(context) {
    /** Is there an await in `node` that no try-with-catch around it handles? Nested functions are their own business. */
    const uncaughtAwait = (node, guarded) => {
      if (!node || typeof node.type !== "string") return false;
      if (node.type === "AwaitExpression" || (node.type === "ForOfStatement" && node.await)) {
        if (!guarded) return true;
      }
      if (node.type === "ArrowFunctionExpression" || node.type === "FunctionExpression" || node.type === "FunctionDeclaration") return false;
      if (node.type === "TryStatement") {
        if (uncaughtAwait(node.block, guarded || !!node.handler)) return true;
        return uncaughtAwait(node.handler?.body, guarded) || uncaughtAwait(node.finalizer, guarded);
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === "parent") continue;
        const kids = Array.isArray(value) ? value : [value];
        for (const kid of kids) if (kid && typeof kid === "object" && uncaughtAwait(kid, guarded)) return true;
      }
      return false;
    };
    return {
      JSXAttribute(attr) {
        const name = attr.name?.name;
        if (typeof name !== "string" || !/^on[A-Z]/.test(name)) return;
        const el = attr.parent?.name;
        const tag = el?.type === "JSXIdentifier" ? el.name : null;
        if (!tag || !(/^[a-z]/.test(tag) || PASSES_EVENTS.has(tag))) return;
        const fn = attr.value?.type === "JSXExpressionContainer" ? attr.value.expression : null;
        if (!fn || !(fn.type === "ArrowFunctionExpression" || fn.type === "FunctionExpression") || !fn.async) return;
        if (uncaughtAwait(fn.body, false)) context.report({ node: attr, messageId: "uncaught", data: { name } });
      },
    };
  },
};

export default [
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: { parser: tsParser, parserOptions: { ecmaFeatures: { jsx: true } } },
    plugins: { "react-hooks": reactHooks, basalt: { rules: { "async-handler-catches": asyncHandlerCatches } } },
    // A suppression for a rule that is not on, or one that no longer
    // suppresses anything, is an error too: every eslint-disable stays true.
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      "basalt/async-handler-catches": "error",
    },
  },
];
