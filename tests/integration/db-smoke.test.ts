import { describe, expect, it } from 'vitest';
import { Client } from 'pg';

describe('dev database', () => {
  it('connects and can enable the pgvector extension', async () => {
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      const res = await client.query(
        "SELECT extversion FROM pg_extension WHERE extname = 'vector'",
      );
      expect(res.rows).toHaveLength(1);
    } finally {
      await client.end();
    }
  });
});
