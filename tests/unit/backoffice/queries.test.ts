import { describe, expect, it } from 'vitest';
import { isTableKey, TABLE_KEYS, TABLES } from '../../../src/backoffice/queries.js';

// The product is read-only by construction (guardrail 1). This proves the
// query LAYER authors only SELECTs — no mutating SQL is reachable. The running
// service additionally connects through a SELECT-only role (BO-17), so a write
// is blocked at two independent layers.
const MUTATING = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY|MERGE)\b/i;

describe('queries are SELECT-only', () => {
  it('every table query starts with SELECT and contains no mutating keyword', () => {
    for (const key of TABLE_KEYS) {
      const sql = TABLES[key].sql;
      expect(sql.trimStart()).toMatch(/^SELECT\b/i);
      expect(sql).not.toMatch(MUTATING);
    }
  });

  it('parameterizes the row limit and never interpolates the table name', () => {
    for (const key of TABLE_KEYS) {
      const sql = TABLES[key].sql;
      expect(sql).toContain('$1');
      // The literal table name comes only from the static registry, not the SQL
      // being built from input — the FROM clause is a fixed identifier.
      expect(sql).toMatch(/FROM\s+\w+/i);
    }
  });

  it('household_facts exposes only key/value/updated_at (no credential columns)', () => {
    // The user-facing secret-fact class was dropped (migration 0003 / ADR-0001);
    // the table holds no secrets. Guard that the projection stays minimal.
    expect(TABLES.household_facts.columns).toEqual(['key', 'value', 'updated_at']);
    expect(TABLES.household_facts.sql).not.toMatch(MUTATING);
  });

  it('isTableKey gates unknown names', () => {
    expect(isTableKey('lists')).toBe(true);
    expect(isTableKey('lists; DROP TABLE lists')).toBe(false);
    expect(isTableKey('pg_user')).toBe(false);
  });
});
