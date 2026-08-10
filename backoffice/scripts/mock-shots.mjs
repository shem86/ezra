// mock-shots — render the read-only console against fabricated, non-PII data
// and screenshot all five screens for the README showcase. Unlike ui-debug
// (which hits a live backend), this intercepts every /api/* request in the
// browser and fulfils it with the shared fixtures (scripts/fixtures.mjs), so it
// needs only the vite dev server (pnpm --dir backoffice dev) and chromium —
// no prod host, no real household data.
//
// Data is deliberately fictional (Amir/Noa, generic facts) and mirrors the
// same shapes the screens' unit tests use. The cost story ($9.17 MTD, 78%
// cache reads) matches the README's tokenomics claim on purpose.
//
// Usage: node scripts/mock-shots.mjs   (with vite dev running on :5173)
//   BACKOFFICE_URL   target origin  (default http://localhost:5173)
//   MOCK_SHOTS_OUT   output dir     (default ../docs/assets/backoffice)

import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFixture } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BACKOFFICE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const OUT = resolve(process.env.MOCK_SHOTS_OUT ?? resolve(HERE, '..', '..', 'docs', 'assets', 'backoffice'));

const ROUTES = ['dashboard', 'database', 'logs', 'costs', 'status'];

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();

  // Scope to the real API surface only. A loose '**/api/**' glob also catches
  // the app's own vite-served modules (/src/api/client.ts), starving the SPA.
  await page.route(/\/api(\/|$)/, (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    if (!p.startsWith('/api/') && p !== '/api') return route.continue();
    const body = resolveFixture(p);
    if (body === null) return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  for (const r of ROUTES) {
    await page.goto(`${BASE}/#${r}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    const file = resolve(OUT, `${r}.png`);
    await page.screenshot({ path: file, fullPage: true });
    console.log(`shot ${r} → ${file}`);
  }

  await browser.close();
  console.log(`done → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
