import { describe, expect, it } from 'vitest';
import {
  databaseNameOf,
  deriveTestDatabaseUrl,
} from '../integration/helpers/test-database-url.ts';

describe('deriveTestDatabaseUrl', () => {
  it('suffixes the database name with _test, preserving server/credentials', () => {
    expect(deriveTestDatabaseUrl('postgres://hh:hh@localhost:5432/hh_assistant')).toBe(
      'postgres://hh:hh@localhost:5432/hh_assistant_test',
    );
  });

  it('preserves query parameters (e.g. sslmode)', () => {
    expect(
      deriveTestDatabaseUrl('postgres://hh:hh@db.example.com:5432/hh_assistant?sslmode=require'),
    ).toBe('postgres://hh:hh@db.example.com:5432/hh_assistant_test?sslmode=require');
  });

  it('is idempotent: an already-_test URL passes through unchanged', () => {
    const testUrl = 'postgres://hh:hh@localhost:5432/hh_assistant_test';
    expect(deriveTestDatabaseUrl(testUrl)).toBe(testUrl);
  });

  it('throws when the URL carries no database name', () => {
    expect(() => deriveTestDatabaseUrl('postgres://hh:hh@localhost:5432/')).toThrow(
      /no database name/,
    );
  });

  it('rejects a database name that is not a safe identifier', () => {
    expect(() =>
      deriveTestDatabaseUrl('postgres://hh:hh@localhost:5432/has-a-dash'),
    ).toThrow(/unsupported database name/);
  });
});

describe('databaseNameOf', () => {
  it('extracts the database name from the connection string path', () => {
    expect(databaseNameOf('postgres://hh:hh@localhost:5432/hh_assistant')).toBe('hh_assistant');
  });
});
