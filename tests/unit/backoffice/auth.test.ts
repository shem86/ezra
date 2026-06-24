import { mkdtemp, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  extractToken,
  makeRateLimiter,
  parseCookies,
  safeEqual,
  SESSION_COOKIE,
} from '../../../src/backoffice/auth.js';
import { createBackofficeServer } from '../../../src/backoffice/server.js';

const TOKEN = 'test-token-0123456789-abcdefghijklmnop';

describe('auth helpers', () => {
  it('safeEqual is true only for identical strings', () => {
    expect(safeEqual(TOKEN, TOKEN)).toBe(true);
    expect(safeEqual(TOKEN, TOKEN + 'x')).toBe(false);
    expect(safeEqual('a', 'b')).toBe(false);
  });

  it('parseCookies splits a cookie header', () => {
    expect(parseCookies('a=1; bo_session=xyz; c=2')).toMatchObject({ a: '1', bo_session: 'xyz', c: '2' });
    expect(parseCookies(undefined)).toEqual({});
  });

  it('extractToken prefers header, then cookie, then query', () => {
    expect(extractToken({ authorization: 'Bearer h' })).toEqual({ token: 'h', source: 'header' });
    expect(extractToken({ cookie: `${SESSION_COOKIE}=c` })).toEqual({ token: 'c', source: 'cookie' });
    expect(extractToken({ queryToken: 'q' })).toEqual({ token: 'q', source: 'query' });
    expect(extractToken({})).toBeUndefined();
  });

  it('rate limiter locks out after maxFailures and reset clears it', () => {
    let t = 0;
    const rl = makeRateLimiter({ maxFailures: 3, lockoutMs: 1000, now: () => t });
    rl.recordFailure('ip');
    rl.recordFailure('ip');
    expect(rl.isLocked('ip')).toBe(false);
    rl.recordFailure('ip'); // 3rd → locked
    expect(rl.isLocked('ip')).toBe(true);
    t = 1001; // lock expires
    expect(rl.isLocked('ip')).toBe(false);
    rl.recordFailure('ip');
    rl.reset('ip');
    expect(rl.isLocked('ip')).toBe(false);
  });
});

describe('backoffice server', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const dist = await mkdtemp(join(tmpdir(), 'bo-dist-'));
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>ezra</title>');
    server = createBackofficeServer({
      token: TOKEN,
      distDir: dist,
      rateLimiter: makeRateLimiter({ maxFailures: 100, lockoutMs: 1000 }),
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  const auth = { headers: { authorization: `Bearer ${TOKEN}` } };

  it('rejects an unauthenticated /api request with 401', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects a bad token with 401', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  it('serves /api/health with a valid bearer token', async () => {
    const res = await fetch(`${base}/api/health`, auth);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body).toMatchObject({ status: 'ok', service: 'backoffice' });
  });

  it('promotes a ?token= load into an httpOnly session cookie', async () => {
    const res = await fetch(`${base}/api/health?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
  });

  it('is read-only — a POST returns 405 with no token even checked', async () => {
    const res = await fetch(`${base}/api/health`, { method: 'POST', ...auth });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toContain('GET');
  });

  it('404s an unknown /api endpoint when authed', async () => {
    const res = await fetch(`${base}/api/nope`, auth);
    expect(res.status).toBe(404);
  });

  it('serves the SPA index.html for an authed app route', async () => {
    const res = await fetch(`${base}/`, auth);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('ezra');
  });
});
