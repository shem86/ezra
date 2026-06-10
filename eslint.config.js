import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import { noNondeterminismInWorkflow } from './eslint-rules/no-nondeterminism-in-workflow.ts';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/'] },
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
