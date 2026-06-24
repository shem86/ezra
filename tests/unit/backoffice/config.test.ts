import { describe, expect, it } from 'vitest';
import { loadBackofficeConfig } from '../../../src/ops/config.js';

const TOKEN = 'x'.repeat(40);
const validEnv = {
  BACKOFFICE_TOKEN: TOKEN,
  BACKOFFICE_DATABASE_URL: 'postgres://hh_readonly:pw@localhost:5432/hh_assistant',
};

describe('loadBackofficeConfig', () => {
  it('returns a typed config with sensible defaults', () => {
    const config = loadBackofficeConfig(validEnv);
    expect(config.token).toBe(TOKEN);
    expect(config.databaseUrl).toBe(validEnv.BACKOFFICE_DATABASE_URL);
    expect(config.port).toBe(8787);
    expect(config.distDir).toBe('backoffice/dist');
    expect(config.monthlyBudgetUsd).toBe(50);
  });

  it('coerces port and budget from strings', () => {
    const config = loadBackofficeConfig({
      ...validEnv,
      BACKOFFICE_PORT: '9000',
      BACKOFFICE_MONTHLY_BUDGET_USD: '30',
    });
    expect(config.port).toBe(9000);
    expect(config.monthlyBudgetUsd).toBe(30);
  });

  it('rejects a short token', () => {
    expect(() => loadBackofficeConfig({ ...validEnv, BACKOFFICE_TOKEN: 'short' })).toThrowError(
      /BACKOFFICE_TOKEN/,
    );
  });

  it('requires the SELECT-only database url (no silent fallback)', () => {
    const { BACKOFFICE_DATABASE_URL: _omit, ...partial } = validEnv;
    expect(() => loadBackofficeConfig(partial)).toThrowError(/BACKOFFICE_DATABASE_URL/);
  });
});
