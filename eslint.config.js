import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

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
  // Slot reserved for the custom DBOS-determinism rule (T9):
  // local plugin from eslint-rules/no-nondeterminism-in-workflow.ts,
  // applied to files containing @DBOS.workflow bodies, severity 'error'.
);
