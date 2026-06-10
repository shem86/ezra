import { defineConfig } from 'vitest/config';

// Integration tests need the dev Postgres (docker compose); skip the whole
// suite when no DATABASE_URL is configured so unit tests stay runnable anywhere.
const hasDb = Boolean(process.env.DATABASE_URL);

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'tests/unit/**/*.test.ts',
      'eslint-rules/**/*.test.ts',
      ...(hasDb ? ['tests/integration/**/*.test.ts'] : []),
    ],
  },
});
