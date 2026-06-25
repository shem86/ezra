// Isolated frontend lint config (flat). Mirrors infra/pulumi: the backoffice
// SPA lints itself and never enters the app's eslint.config.js / DBOS-determinism
// scope. Type-aware rules off by default to keep it light; the strict tsconfig
// (pnpm -C backoffice build → tsc --noEmit) is the real type gate.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ExportDefaultDeclaration',
          message: 'No default exports (repo convention).',
        },
      ],
    },
  },
  {
    files: ['vite.config.ts', 'eslint.config.js'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // Node ops scripts (the ui-debug script) — Node globals, not the browser.
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { console: 'readonly', process: 'readonly' },
    },
  },
);
