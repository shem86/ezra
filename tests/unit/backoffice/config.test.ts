import { describe, expect, it } from 'vitest';
import { loadBackofficeConfig } from '../../../src/ops/config.js';

const saKey = {
  client_email: 'hh@x.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIItest\n-----END PRIVATE KEY-----\n',
};
const TOKEN = 'x'.repeat(40);
const validEnv = {
  BACKOFFICE_TOKEN: TOKEN,
  BACKOFFICE_DATABASE_URL: 'postgres://hh_readonly:pw@localhost:5432/hh_assistant',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  VOYAGE_API_KEY: 'vk-test',
  GOOGLE_SA_KEY_B64: Buffer.from(JSON.stringify(saKey)).toString('base64'),
  CALENDAR_ID_HUSBAND: 'h@gmail.com',
  CALENDAR_ID_WIFE: 'w@gmail.com',
};

describe('loadBackofficeConfig', () => {
  it('returns a typed config with sensible defaults', () => {
    const config = loadBackofficeConfig(validEnv);
    expect(config.token).toBe(TOKEN);
    expect(config.databaseUrl).toBe(validEnv.BACKOFFICE_DATABASE_URL);
    expect(config.port).toBe(8787);
    expect(config.distDir).toBe('backoffice/dist');
    expect(config.monthlyBudgetUsd).toBe(50);
    expect(config.langfuse.publicKey).toBe('pk-lf-test');
    expect(config.langfuse.baseUrl).toBe('https://cloud.langfuse.com');
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
