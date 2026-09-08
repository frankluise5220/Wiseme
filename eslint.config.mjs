import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@next/next/no-html-link-for-pages": "off",
      "no-var": "off",
      "prefer-const": "off",
      "react/no-unescaped-entities": "off",
      "react-hooks/immutability": "off",
      "react-hooks/preserve-manual-memoization": "off",
      "react-hooks/purity": "off",
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/static-components": "off",
      "react-hooks/unsupported-syntax": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",

    // Local scratch / IDE
    ".obsidian/**",
    ".kombai/**",
    "AI_CONTEXT.md",
    "page-backup.tsx",
    "patch*.txt",
    "tmp-*.js",
    "tmp-*.ts",
    "_*.cjs",
    "_*.js",
    "_*.ts",
    "_*.mjs",
    "_*.mts",
    "*.new",

    // Local artifacts
    "public/test-results.json",
    "release-artifacts/**",
    "src/app/test-results/**",
    ".codex-logs/**",
    ".npm-cache-tmp/**",
    ".pnpm-local/**",
    "mmh-doc-edit/**",
    "tmp-*.cjs",
    "verify*.js",
    "verify*.cjs",

    // Utility scripts (not part of app runtime)
    "scripts/**",
  ]),
]);

export default eslintConfig;
