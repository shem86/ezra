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

  it('extractToken prefers header, then query, then cookie', () => {
    expect(extractToken({ authorization: 'Bearer h' })).toEqual({ token: 'h', source: 'header' });
    expect(extractToken({ queryToken: 'q' })).toEqual({ token: 'q', source: 'query' });
    expect(extractToken({ cookie: `${SESSION_COOKIE}=c` })).toEqual({ token: 'c', source: 'cookie' });
    expect(extractToken({})).toBeUndefined();
  });

  // A PRESENTED credential outranks a STORED one. With the cookie winning, an
  // operator arriving with a good token after a rotation could not get in — the
  // good token was never even compared against the configured one.
  it('extractToken lets a presented token outrank a stored cookie', () => {
    expect(extractToken({ queryToken: 'q', cookie: `${SESSION_COOKIE}=stale` })).toEqual({
      token: 'q',
      source: 'query',
    });
    expect(extractToken({ authorization: 'Bearer h', cookie: `${SESSION_COOKIE}=stale`, queryToken: 'q' })).toEqual({
      token: 'h',
      source: 'header',
    });
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

  // Regression: failures used to accumulate forever, so 8 rejects spread over
  // WEEKS still tripped a lockout. Only failures inside the window count.
  it('forgets failures older than the window', () => {
    let t = 0;
    const rl = makeRateLimiter({ maxFailures: 3, lockoutMs: 1000, windowMs: 1000, now: () => t });
    rl.recordFailure('ip');
    rl.recordFailure('ip');
    t = 1001; // both fall out of the window
    rl.recordFailure('ip');
    rl.recordFailure('ip');
    expect(rl.isLocked('ip')).toBe(false);
    rl.recordFailure('ip'); // 3 inside the window → locked
    expect(rl.isLocked('ip')).toBe(true);
  });

  it('windowMs defaults to lockoutMs', () => {
    let t = 0;
    const rl = makeRateLimiter({ maxFailures: 2, lockoutMs: 500, now: () => t });
    rl.recordFailure('ip');
    t = 501;
    rl.recordFailure('ip');
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

// Self-service sign-in: the SPA shell is public so an unauthenticated visit can
// render a sign-in screen, and the session cookie renews on use so an active
// operator never falls off the 30-day cliff. /api/* remains the real gate.
describe('backoffice self-service sign-in', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const dist = await mkdtemp(join(tmpdir(), 'bo-dist-'));
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>ezra</title>');
    await writeFile(join(dist, 'app.js'), 'console.log(1)');
    server = createBackofficeServer({
      token: TOKEN,
      distDir: dist,
      rateLimiter: makeRateLimiter({ maxFailures: 8, lockoutMs: 60_000 }),
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('serves the SPA shell with no credential at all', async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('ezra');
  });

  it('serves static assets with no credential', async () => {
    const res = await fetch(`${base}/app.js`);
    expect(res.status).toBe(200);
  });

  it('still gates /api/* without a credential', async () => {
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(401);
  });

  it('signs in over /api/session with a bearer token and sets the cookie', async () => {
    const res = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie.toLowerCase()).toContain('samesite=strict');
  });

  it('rejects sign-in with a wrong token', async () => {
    const res = await fetch(`${base}/api/session`, { headers: { authorization: 'Bearer nope' } });
    expect(res.status).toBe(401);
  });

  // The 30-day cliff: a fixed Max-Age set once at first login eventually expires
  // mid-use. Every authenticated response now re-issues it.
  it('renews the session cookie on every authenticated request', async () => {
    const res = await fetch(`${base}/api/health`, { headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=`);
  });

  it('still promotes a ?token= shell load into a cookie (old bookmarks keep working)', async () => {
    const res = await fetch(`${base}/?token=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toContain(`${SESSION_COOKIE}=`);
  });

  // A stale bookmark carrying a dead token must still reach the sign-in screen
  // rather than a wall of JSON.
  it('serves the shell even when a wrong token rides along', async () => {
    const res = await fetch(`${base}/?token=wrong`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('ezra');
  });
});

// Regression suite for the SECOND shape of the same lockout, caught in review of
// the self-service sign-in change: after BACKOFFICE_TOKEN is rotated, every
// browser still replays the old token in its bo_session cookie. Because the
// shell now falls through and serves the SPA, that cookie rode along on the
// shell, on each hashed asset, and on the four /api calls the dashboard fires on
// mount — so ONE page load spent the whole 8-failure budget and the operator was
// 429'd before the sign-in form could render. The limiter is configured exactly
// as production does it (src/backoffice/cli.ts).
describe('backoffice stale-cookie recovery (post-rotation)', () => {
  let server: Server;
  let base: string;
  const STALE = 'the-previous-token-9876543210-zyxwvuts';

  beforeAll(async () => {
    const dist = await mkdtemp(join(tmpdir(), 'bo-dist-'));
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>ezra</title>');
    await writeFile(join(dist, 'app.js'), 'console.log(1)');
    await writeFile(join(dist, 'app.css'), 'body{}');
    server = createBackofficeServer({
      token: TOKEN,
      distDir: dist,
      rateLimiter: makeRateLimiter({ maxFailures: 8, lockoutMs: 15 * 60_000, windowMs: 15 * 60_000 }),
      api: { handle: async () => ({ status: 200, body: { ok: true } }) },
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  const withStale = (path: string): Promise<Response> =>
    fetch(`${base}${path}`, { headers: { cookie: `${SESSION_COOKIE}=${STALE}` } });

  it('never locks out across repeated page loads carrying a stale cookie', async () => {
    // Three full page loads: shell + two assets + a favicon miss, then the four
    // parallel /api calls the dashboard mounts with. 24 rejected-cookie requests
    // against a budget of 8 — under the old code the lockout tripped on the
    // FIRST load and every reload re-armed it.
    for (let load = 0; load < 3; load++) {
      for (const path of ['/', '/app.js', '/app.css', '/favicon.ico']) await withStale(path);
      const api = await Promise.all(
        ['/api/costs', '/api/status', '/api/logs', '/api/db'].map((p) => withStale(p)),
      );
      for (const res of api) {
        // 401 (not signed in) — never 429. 401 is what routes the SPA to the form.
        expect(res.status).toBe(401);
      }
    }
  });

  it('clears the dead cookie so the next request is credential-less', async () => {
    const shell = await withStale('/');
    expect(shell.status).toBe(200);
    expect(shell.headers.get('set-cookie') ?? '').toMatch(/bo_session=;.*Max-Age=0/);

    const api = await withStale('/api/health');
    expect(api.status).toBe(401);
    expect(api.headers.get('set-cookie') ?? '').toMatch(/bo_session=;.*Max-Age=0/);
  });

  it('accepts the correct token over a stale cookie, on the form and by bookmark', async () => {
    // The sign-in form's path: Bearer beats the cookie the browser replays.
    const viaForm = await fetch(`${base}/api/session`, {
      headers: { authorization: `Bearer ${TOKEN}`, cookie: `${SESSION_COOKIE}=${STALE}` },
    });
    expect(viaForm.status).toBe(200);
    expect(viaForm.headers.get('set-cookie') ?? '').toContain(encodeURIComponent(TOKEN));

    // The documented bookmark path (infra/runtime.md) must also replace it.
    const viaQuery = await fetch(`${base}/?token=${TOKEN}`, {
      headers: { cookie: `${SESSION_COOKIE}=${STALE}` },
    });
    expect(viaQuery.status).toBe(200);
    expect(viaQuery.headers.get('set-cookie') ?? '').toContain(encodeURIComponent(TOKEN));
  });

  // The throttle must still fire on actual guessing — this is the property the
  // exemption above must not cost us.
  it('still locks out an address presenting wrong tokens', async () => {
    let last = 0;
    for (let i = 0; i < 9; i++) {
      const res = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer wrong-${i}` } });
      last = res.status;
    }
    expect(last).toBe(429);
    // ...and the correct token still gets in while locked out (the #41 property).
    const rescue = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(rescue.status).toBe(200);
  });
});

describe('backoffice sign-out and cookie hardening', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const dist = await mkdtemp(join(tmpdir(), 'bo-dist-'));
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>ezra</title>');
    server = createBackofficeServer({
      token: TOKEN,
      distDir: dist,
      rateLimiter: makeRateLimiter({ maxFailures: 8, lockoutMs: 60_000 }),
    });
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(() => {
    server.close();
  });

  it('drops the session cookie on /api/signout', async () => {
    const res = await fetch(`${base}/api/signout`, { headers: { cookie: `${SESSION_COOKIE}=${TOKEN}` } });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie') ?? '').toMatch(/bo_session=;.*Max-Age=0/);
  });

  it('requires a credential to sign out', async () => {
    const res = await fetch(`${base}/api/signout`);
    expect(res.status).toBe(401);
  });

  // Secure is conditional: `tailscale serve` forwards x-forwarded-proto https,
  // but the raw container port is plain http over the tailnet and a Secure
  // cookie would be silently dropped there.
  it('marks the cookie Secure only when the request arrived over https', async () => {
    const https = await fetch(`${base}/api/session`, {
      headers: { authorization: `Bearer ${TOKEN}`, 'x-forwarded-proto': 'https' },
    });
    expect(https.headers.get('set-cookie') ?? '').toContain('Secure');

    const plain = await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(plain.headers.get('set-cookie') ?? '').not.toContain('Secure');
  });

  // The shell is public and renders a credential form, so it must not be
  // framable by anything else on the tailnet.
  it('refuses to be framed', async () => {
    const res = await fetch(`${base}/`);
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});

// Regression suite for the 2026-08-10 lockout incident: the operator's own
// machine was 429'd for 15 minutes while the console was perfectly healthy.
// Three separate defects conspired; each gets a test here.
describe('backoffice lockout behaviour', () => {
  const servers: Server[] = [];

  async function start(maxFailures: number): Promise<{ base: string; logs: string[] }> {
    const dist = await mkdtemp(join(tmpdir(), 'bo-dist-'));
    await writeFile(join(dist, 'index.html'), '<!doctype html><title>ezra</title>');
    const logs: string[] = [];
    const server = createBackofficeServer({
      token: TOKEN,
      distDir: dist,
      rateLimiter: makeRateLimiter({ maxFailures, lockoutMs: 60_000 }),
      logger: (msg) => logs.push(msg),
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as AddressInfo;
    return { base: `http://127.0.0.1:${port}`, logs };
  }

  afterAll(() => {
    for (const s of servers) s.close();
  });

  // Defect 1: every credential-less request counted as a failed ATTEMPT. The
  // dashboard fires 4 parallel /api calls on mount, so two loads with a stale
  // cookie locked the operator out before any password was ever guessed.
  it('does not count a credential-less request as a failed attempt', async () => {
    const { base } = await start(3);
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/api/health`);
      expect(res.status).toBe(401);
    }
    const res = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  // Defect 2: isLocked was checked BEFORE the token comparison, so a lockout
  // shut out the correct credential too — the operator could not recover by
  // presenting the right token, only by waiting.
  it('honours a correct token even while the address is locked out', async () => {
    const { base } = await start(3);
    for (let i = 0; i < 3; i++) {
      await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer wrong' } });
    }
    // Locked: a further WRONG token is throttled...
    const throttled = await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer wrong' } });
    expect(throttled.status).toBe(429);
    // ...but the real credential still gets in.
    const res = await fetch(`${base}/api/health`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  // The throttle that actually matters is unchanged: a guesser is still capped
  // after maxFailures wrong tokens, and stays capped.
  it('still throttles repeated wrong tokens', async () => {
    const { base } = await start(3);
    const wrong = { headers: { authorization: 'Bearer wrong' } };
    expect((await fetch(`${base}/api/health`, wrong)).status).toBe(401);
    expect((await fetch(`${base}/api/health`, wrong)).status).toBe(401);
    // The 3rd wrong token trips the lock and is told so on the spot.
    const tripped = await fetch(`${base}/api/health`, wrong);
    expect(tripped.status).toBe(429);
    expect(tripped.headers.get('retry-after')).toBeTruthy();
    expect((await fetch(`${base}/api/health`, wrong)).status).toBe(429);
  });

  // Defect 3: none of this was observable — two log lines in two weeks.
  it('logs rejected attempts and the lockout, never the token', async () => {
    const { base, logs } = await start(2);
    await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer wrong-token-value' } });
    await fetch(`${base}/api/health`, { headers: { authorization: 'Bearer wrong-token-value' } });
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(logs.some((l) => l.includes('locked out'))).toBe(true);
    expect(logs.join('\n')).not.toContain('wrong-token-value');
    expect(logs.join('\n')).not.toContain(TOKEN);
  });
});
