import { describe, expect, it } from 'vitest';
import {
  loadConfig,
  loadDatabaseUrl,
  loadTransportOpsConfig,
  loadWaSessionDir,
} from '../../src/ops/config.js';

// Shape-faithful service-account key (T39/ADR-0004): the real file has more
// fields; config must tolerate them and extract exactly these two.
const saKey = {
  type: 'service_account',
  project_id: 'hh-assistant-test',
  client_email: 'hh-agent@hh-assistant-test.iam.gserviceaccount.com',
  private_key: '-----BEGIN PRIVATE KEY-----\nMIItest\n-----END PRIVATE KEY-----\n',
};
const saKeyB64 = Buffer.from(JSON.stringify(saKey)).toString('base64');

const validEnv = {
  DATABASE_URL: 'postgres://hh:hh@localhost:5432/hh_assistant',
  ANTHROPIC_API_KEY: 'sk-ant-test',
  VOYAGE_API_KEY: 'vk-test',
  LANGFUSE_PUBLIC_KEY: 'pk-lf-test',
  LANGFUSE_SECRET_KEY: 'sk-lf-test',
  ALERT_CHANNEL_TOKEN: 'tg-bot-token',
  ALERT_CHANNEL_CHAT_ID: '123456789',
  DEADMAN_PING_URL: 'https://hc-ping.com/some-uuid',
  GOOGLE_SA_KEY_B64: saKeyB64,
  CALENDAR_ID_HUSBAND: 'husband@gmail.com',
  CALENDAR_ID_WIFE: 'wife@gmail.com',
};

describe('loadConfig', () => {
  it('returns a typed config from a valid environment', () => {
    const config = loadConfig(validEnv);

    expect(config.databaseUrl).toBe(validEnv.DATABASE_URL);
    expect(config.anthropicApiKey).toBe(validEnv.ANTHROPIC_API_KEY);
    expect(config.voyageApiKey).toBe(validEnv.VOYAGE_API_KEY);
    expect(config.langfusePublicKey).toBe(validEnv.LANGFUSE_PUBLIC_KEY);
    expect(config.langfuseSecretKey).toBe(validEnv.LANGFUSE_SECRET_KEY);
    expect(config.alertChannelToken).toBe(validEnv.ALERT_CHANNEL_TOKEN);
    expect(config.alertChannelChatId).toBe(validEnv.ALERT_CHANNEL_CHAT_ID);
    expect(config.deadmanPingUrl).toBe(validEnv.DEADMAN_PING_URL);
  });

  it('requires the alert chat id and dead-man ping URL (T12 ops are not optional)', () => {
    const { ALERT_CHANNEL_CHAT_ID: _chat, DEADMAN_PING_URL: _ping, ...partial } = validEnv;

    expect(() => loadConfig(partial)).toThrowError(/ALERT_CHANNEL_CHAT_ID/);
    expect(() => loadConfig(partial)).toThrowError(/DEADMAN_PING_URL/);
  });

  it('rejects a malformed dead-man ping URL', () => {
    expect(() => loadConfig({ ...validEnv, DEADMAN_PING_URL: 'not-a-url' })).toThrowError(
      /DEADMAN_PING_URL/,
    );
  });

  it('defaults the Langfuse base URL to the cloud endpoint', () => {
    const config = loadConfig(validEnv);
    expect(config.langfuseBaseUrl).toBe('https://cloud.langfuse.com');
  });

  it('defaults the approval TTL to 12 hours (Open Q1, resolved at T34) and accepts overrides', () => {
    expect(loadConfig(validEnv).approvalTtlHours).toBe(12);
    expect(loadConfig({ ...validEnv, APPROVAL_TTL_HOURS: '24' }).approvalTtlHours).toBe(24);
    expect(() => loadConfig({ ...validEnv, APPROVAL_TTL_HOURS: '0' })).toThrowError(
      /APPROVAL_TTL_HOURS/,
    );
  });

  it('decodes the service-account key and exposes email + private key (T39/ADR-0004)', () => {
    const config = loadConfig(validEnv);
    expect(config.googleServiceAccount.clientEmail).toBe(saKey.client_email);
    expect(config.googleServiceAccount.privateKey).toBe(saKey.private_key);
  });

  it('rejects a service-account key that is not valid base64 JSON, naming the variable', () => {
    expect(() => loadConfig({ ...validEnv, GOOGLE_SA_KEY_B64: 'not-base64!!!' })).toThrowError(
      /GOOGLE_SA_KEY_B64/,
    );
  });

  it('rejects a decodable key missing client_email or private_key', () => {
    const incomplete = Buffer.from(JSON.stringify({ type: 'service_account' })).toString('base64');
    expect(() => loadConfig({ ...validEnv, GOOGLE_SA_KEY_B64: incomplete })).toThrowError(
      /GOOGLE_SA_KEY_B64/,
    );
  });

  it('exposes the per-owner calendar ids (ADR-0004 requester routing)', () => {
    const config = loadConfig(validEnv);
    expect(config.calendarIds.husband).toBe('husband@gmail.com');
    expect(config.calendarIds.wife).toBe('wife@gmail.com');
  });

  it('requires both calendar ids — half a household map is a misconfiguration', () => {
    const { CALENDAR_ID_WIFE: _wife, ...partial } = validEnv;
    expect(() => loadConfig(partial)).toThrowError(/CALENDAR_ID_WIFE/);
  });

  it('fails loudly naming every missing variable', () => {
    const { DATABASE_URL: _db, ANTHROPIC_API_KEY: _key, ...partial } = validEnv;

    expect(() => loadConfig(partial)).toThrowError(/DATABASE_URL/);
    expect(() => loadConfig(partial)).toThrowError(/ANTHROPIC_API_KEY/);
  });

  it('rejects an empty value, not just an absent one', () => {
    expect(() => loadConfig({ ...validEnv, ANTHROPIC_API_KEY: '' })).toThrowError(
      /ANTHROPIC_API_KEY/,
    );
  });

  it('rejects a malformed Langfuse base URL', () => {
    expect(() =>
      loadConfig({ ...validEnv, LANGFUSE_BASE_URL: 'not-a-url' }),
    ).toThrowError(/LANGFUSE_BASE_URL/);
  });
});

describe('loadWaSessionDir', () => {
  it('defaults to .wa-session without requiring the rest of the environment', () => {
    expect(loadWaSessionDir({})).toBe('.wa-session');
  });

  it('respects an explicit override', () => {
    expect(loadWaSessionDir({ WA_SESSION_DIR: '/var/lib/hh/wa-session' })).toBe(
      '/var/lib/hh/wa-session',
    );
  });

  it('is exposed on the full config too', () => {
    expect(loadConfig(validEnv).waSessionDir).toBe('.wa-session');
  });
});

describe('loadTransportOpsConfig', () => {
  const transportEnv = {
    ALERT_CHANNEL_TOKEN: validEnv.ALERT_CHANNEL_TOKEN,
    ALERT_CHANNEL_CHAT_ID: validEnv.ALERT_CHANNEL_CHAT_ID,
    DEADMAN_PING_URL: validEnv.DEADMAN_PING_URL,
  };

  it('returns the transport/ops slice without requiring LLM or DB keys', () => {
    const config = loadTransportOpsConfig(transportEnv);

    expect(config.waSessionDir).toBe('.wa-session');
    expect(config.alertChannelToken).toBe(validEnv.ALERT_CHANNEL_TOKEN);
    expect(config.alertChannelChatId).toBe(validEnv.ALERT_CHANNEL_CHAT_ID);
    expect(config.deadmanPingUrl).toBe(validEnv.DEADMAN_PING_URL);
  });

  it('fails loudly naming the missing alert/dead-man variables', () => {
    expect(() => loadTransportOpsConfig({})).toThrowError(/ALERT_CHANNEL_TOKEN/);
    expect(() => loadTransportOpsConfig({})).toThrowError(/ALERT_CHANNEL_CHAT_ID/);
    expect(() => loadTransportOpsConfig({})).toThrowError(/DEADMAN_PING_URL/);
  });
});

describe('loadDatabaseUrl', () => {
  it('returns the database URL without requiring the rest of the environment', () => {
    const url = loadDatabaseUrl({ DATABASE_URL: validEnv.DATABASE_URL });
    expect(url).toBe(validEnv.DATABASE_URL);
  });

  it('fails loudly when DATABASE_URL is missing or empty', () => {
    expect(() => loadDatabaseUrl({})).toThrowError(/DATABASE_URL/);
    expect(() => loadDatabaseUrl({ DATABASE_URL: '' })).toThrowError(/DATABASE_URL/);
  });
});
