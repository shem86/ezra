import { mkdtempSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSessionStore } from '../../src/transport/session-store.ts';

function freshDir(): string {
  return join(mkdtempSync(join(tmpdir(), 'hh-session-test-')), 'session');
}

describe('session store', () => {
  it('creates the session directory on first load', async () => {
    const dir = freshDir();
    const store = createSessionStore({ dir });

    expect(store.isPaired()).toBe(false);
    await store.loadAuthState();
    expect(existsSync(dir)).toBe(true);
  });

  it('reports paired once credentials have been persisted', async () => {
    const dir = freshDir();
    const store = createSessionStore({ dir });
    const { saveCreds } = await store.loadAuthState();

    expect(store.isPaired()).toBe(false);
    await saveCreds();
    expect(store.isPaired()).toBe(true);
    expect(() => JSON.parse(readFileSync(join(dir, 'creds.json'), 'utf8'))).not.toThrow();
  });

  it('round-trips auth state across store instances (restart without re-pair)', async () => {
    const dir = freshDir();
    const first = createSessionStore({ dir });
    const { state, saveCreds } = await first.loadAuthState();
    await saveCreds();

    const second = createSessionStore({ dir });
    const reloaded = await second.loadAuthState();
    expect(reloaded.state.creds.noiseKey.public).toEqual(state.creds.noiseKey.public);
  });

  it('refuses to load corrupt credentials and names re-pairing as the recovery', async () => {
    const dir = freshDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'creds.json'), '{"truncated":');

    const store = createSessionStore({ dir });
    await expect(store.loadAuthState()).rejects.toThrow(/re-pair/i);
  });

  it('clear() wipes the session so a fresh pairing starts clean', async () => {
    const dir = freshDir();
    const store = createSessionStore({ dir });
    const { saveCreds } = await store.loadAuthState();
    await saveCreds();
    expect(store.isPaired()).toBe(true);

    await store.clear();
    expect(store.isPaired()).toBe(false);
    await expect(store.loadAuthState()).resolves.toBeDefined();
  });

  it('serializes concurrent saveCreds calls without rejection', async () => {
    const dir = freshDir();
    const store = createSessionStore({ dir });
    const { saveCreds } = await store.loadAuthState();

    await expect(Promise.all([saveCreds(), saveCreds(), saveCreds()])).resolves.toBeDefined();
    expect(store.isPaired()).toBe(true);
  });
});
