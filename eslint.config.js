import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { noNondeterminismInWorkflow } from './eslint-rules/no-nondeterminism-in-workflow.ts';

export default tseslint.config(
  // `.claude/worktrees/` holds transient git worktree copies from parallel
  // sessions; each carries its own tsconfig, which otherwise makes the typed
  // parser see "multiple candidate TSConfigRootDirs" and fail every file. They
  // are never source-of-truth — lint the real tree only.
  { ignores: ['dist/', 'node_modules/', '.claude/'] },
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  {
    files: ['src/**/*.ts'],
    plugins: {
      hh: { rules: { 'no-nondeterminism-in-workflow': noNondeterminismInWorkflow } },
    },
    rules: {
      'hh/no-nondeterminism-in-workflow': 'error',
    },
  },
);
