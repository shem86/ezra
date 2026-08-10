// verify-signin — end-to-end check of the self-service sign-in flow against the
// REAL built server (dist/backoffice/server.js) serving the REAL built SPA
// (backoffice/dist), driven by a headless browser.
//
// Unit tests cover the server gate and the form in isolation; this covers the
// thing that actually broke on 2026-08-10 — can a human who knows the token get
// into the console without editing the URL? It asserts:
//
//   1. an unauthenticated visit renders the sign-in form, not raw JSON
//   2. a wrong token stays on the form (no sign-out loop, no lockout)
//   3. the right token loads the console
//   4. the token never reaches the address bar
//   5. the session cookie is httpOnly
//   6. a reload stays signed in (cookie carries it)
//   7. sign-out returns to the form and does not stay signed in on reload
//   8. a STALE cookie (what a rotated BACKOFFICE_TOKEN leaves in every browser)
//      lands on the form across repeated reloads and never trips the throttle
//
// Check 8 is the one this harness existed for and missed: the browser replays a
// dead cookie on the shell, on each asset, and on the four /api calls the
// dashboard mounts with, so with those counted as guesses ONE page load spent
// the whole failure budget and the console showed error cards with no way back
// in. The rate limiter below is therefore configured EXACTLY as production does
// it (src/backoffice/cli.ts) — the earlier 60s lockout hid the problem.
//
// The /api/* responses are stubbed to the shapes in backoffice/src/api/types.ts
// so no database, Langfuse, or model credentials are needed.
//
// Prereqs:  pnpm build (repo root)  +  pnpm --dir backoffice build
// Run:      node backoffice/scripts/verify-signin.mjs
// Env:      VERIFY_OUT  screenshot dir (default backoffice/artifacts/signin)

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const OUT = process.env['VERIFY_OUT'] ?? resolve(ROOT, 'backoffice/artifacts/signin');

const imp = (p) => import(pathToFileURL(resolve(ROOT, p)).href);
const { createBackofficeServer } = await imp('dist/backoffice/server.js');
const { makeRateLimiter } = await imp('dist/backoffice/auth.js');
const { chromium } = await imp('backoffice/node_modules/playwright/index.mjs');

const TOKEN = 'verification-token-0123456789-abcdefghij';

// Stubbed read-only API — shapes mirror backoffice/src/api/types.ts. A missing
// field here blanks the console (the SPA has no error boundary), so keep these
// complete when the contract changes.
const api = {
  handle: async (_method, url) => {
    switch (url.pathname) {
      case '/api/costs':
        return {
          status: 200,
          body: {
            estimated: true, budgetUsd: 50, monthCostUsd: 1.23, lastMonthCostUsd: 0.98,
            tokensMonth: 12345, cacheReadPct: 42, dailyCost: [0.1, 0.2, 0.05, 0.3],
            tokenSplit: [
              { label: 'input', pct: 60, color: '#b5613b' },
              { label: 'output', pct: 40, color: '#7a8b6f' },
            ],
            byUsage: [{ name: 'turns', note: 'sonnet', tokens: 9000, cost: 1.0, share: 80 }],
          },
        };
      case '/api/status':
        return {
          status: 200,
          body: {
            turnsToday: 7, avgLatency: '1.2s',
            services: [{ name: 'Anthropic', group: 'model', status: 'operational', latency: '210ms', uptime: '100%', detail: 'ok' }],
            edges: [{ name: 'WhatsApp', status: 'operational', detail: 'socket open' }],
          },
        };
      case '/api/logs':
        return { status: 200, body: { turns: [], enriched: false } };
      case '/api/db':
        return { status: 200, body: { tables: [{ table: 'pending_actions', label: 'Pending actions', icon: 'pause' }] } };
      default:
        return { status: 200, body: { table: 'pending_actions', label: 'Pending actions', icon: 'pause', columns: [], rows: [] } };
    }
  },
};

await mkdir(OUT, { recursive: true });

const server = createBackofficeServer({
  token: TOKEN,
  distDir: resolve(ROOT, 'backoffice/dist'),
  // Production values, src/backoffice/cli.ts.
  rateLimiter: makeRateLimiter({ maxFailures: 8, lockoutMs: 15 * 60_000, windowMs: 15 * 60_000 }),
  logger: (m) => console.log('[server]', m),
  api,
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

let failures = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
};

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  // 1 — unauthenticated visit
  await page.goto(base, { waitUntil: 'networkidle' });
  check('unauthenticated visit renders the sign-in form', await page.isVisible('#bo-token'));
  check('does not render raw JSON', !(await page.textContent('body')).includes('"error"'));
  await page.screenshot({ path: `${OUT}/1-unauthenticated.png`, fullPage: true });

  // 2 — wrong token stays on the form
  await page.fill('#bo-token', 'not-the-token');
  await page.click('button[type=submit]');
  await page.waitForSelector('[role=alert]');
  check('a wrong token stays on the form', await page.isVisible('#bo-token'));
  await page.screenshot({ path: `${OUT}/2-wrong-token.png`, fullPage: true });

  // 3 — the right token gets in
  await page.fill('#bo-token', TOKEN);
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 10_000 }).catch(() => {});
  check('the right token loads the console', await page.isVisible('.shell'));
  check('the token never reaches the address bar', !page.url().includes(TOKEN));
  const session = (await page.context().cookies()).find((c) => c.name === 'bo_session');
  check('the session cookie is httpOnly', Boolean(session?.httpOnly));
  await page.screenshot({ path: `${OUT}/3-signed-in.png`, fullPage: true });

  // 4 — the session survives a reload
  await page.reload({ waitUntil: 'networkidle' });
  check('a reload stays signed in', await page.isVisible('.shell'));

  // 5 — sign out returns to the form, and stays out across a reload
  await page.click('button.signout');
  await page.waitForSelector('#bo-token');
  check('sign out returns to the form', await page.isVisible('#bo-token'));
  await page.reload({ waitUntil: 'networkidle' });
  check('sign out survives a reload', await page.isVisible('#bo-token'));

  // 6 — the post-rotation case: the browser holds a cookie for a token that is
  // no longer the configured one. Three reloads is ~24 rejected-cookie requests
  // against a budget of 8; the form must appear every time and no request may
  // come back 429.
  const throttled = [];
  await page.context().addCookies([
    { name: 'bo_session', value: 'a-token-that-was-rotated-away', domain: '127.0.0.1', path: '/' },
  ]);
  page.on('response', (r) => {
    if (r.status() === 429) throttled.push(r.url());
  });
  for (let i = 0; i < 3; i++) await page.reload({ waitUntil: 'networkidle' });
  check('a stale cookie lands on the sign-in form', await page.isVisible('#bo-token'));
  check('a stale cookie never trips the throttle', throttled.length === 0);
  await page.screenshot({ path: `${OUT}/4-stale-cookie.png`, fullPage: true });

  // ...and the operator can still get in from that state.
  await page.fill('#bo-token', TOKEN);
  await page.click('button[type=submit]');
  await page.waitForSelector('.shell', { timeout: 10_000 }).catch(() => {});
  check('signing in recovers from a stale cookie', await page.isVisible('.shell'));
} finally {
  await browser.close();
  server.close();
}

console.log(failures === 0 ? `\nALL CHECKS PASSED — screenshots in ${OUT}` : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
