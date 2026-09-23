// Flat ESLint config shared by every workspace.
//
// Linting stays type-agnostic (no project service) so it is fast in CI — the
// TypeScript compiler already owns type checking (`npm run typecheck`). Format
// rules are delegated to Prettier via `eslint-config-prettier`, which must stay
// last.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";
import globals from "globals";

export default tseslint.config(
  {
    // Generated and vendored trees are never linted. `dist`/`bundle` include
    // the build output that is intentionally committed to git.
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/bundle/**",
      "**/coverage/**",
      "packages/jev-py/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: { ...globals.node },
    },
    rules: {
      // Operator-facing CLI output is intentional in this repo.
      "no-console": "off",
      // Host-agnostic adapter and test code legitimately narrows to `any`.
      "@typescript-eslint/no-explicit-any": "off",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" },
      ],
    },
  },
  {
    // The compiler already resolves identifiers; `no-undef` only misfires on
    // TypeScript type-only names.
    files: ["**/*.{ts,mts,cts}"],
    rules: { "no-undef": "off" },
  },
  {
    // The VS Code extension is CommonJS, loaded by the extension host.
    files: ["packages/vscode/**/*.js"],
    languageOptions: { sourceType: "commonjs" },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  prettier,
);
