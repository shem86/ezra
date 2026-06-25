// ui-debug — headless screenshot + inspection sweep of the read-only console,
// for agents (and humans) debugging the UI without computer-use or clicking.
//
// The SPA is hash-routed (#dashboard/#database/#logs/#costs/#status), so every
// page is just a distinct URL — no navigation clicks needed. For each route we
// load the page, screenshot it full-height, and capture the things that make
// this *debugging* rather than pixels: console errors/warnings, uncaught page
// errors, failed requests, and HTTP>=400 responses (the /api calls the screens
// depend on). Results land as PNGs + a report.json the agent reads back.
//
// Drives the *installed* Chrome (channel:'chrome') so there's no bundled-browser
// download — that's why the Dockerfile sets PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD.
//
// Auth: if BACKOFFICE_TOKEN is set it rides as `Authorization: Bearer …` on
// every request (never in the URL, so it can't leak into logs or trip the
// query-token rate-limiter). Same-origin cookie auth would work too, but the
// header keeps the token out of the address bar.
//
// Env:
//   BACKOFFICE_URL    target origin           (default http://localhost:8787)
//   BACKOFFICE_TOKEN  bearer token            (optional; omit for the 401/error pass)
//   UI_DEBUG_OUT      output dir              (default backoffice/artifacts/ui)
//   UI_DEBUG_ROUTES   comma list of routes    (default all five)
//   UI_DEBUG_VIEWPORT WxH                      (default 1440x960)
//   UI_DEBUG_SOFT     "1" → always exit 0      (default: exit 1 when issues found)

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const BASE = (process.env.BACKOFFICE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
const TOKEN = process.env.BACKOFFICE_TOKEN ?? '';
const OUT = resolve(process.env.UI_DEBUG_OUT ?? resolve(HERE, '..', 'artifacts', 'ui'));
const ROUTES = (process.env.UI_DEBUG_ROUTES ?? 'dashboard,database,logs,costs,status')
  .split(',')
  .map((r) => r.trim())
  .filter(Boolean);
const [VW, VH] = (process.env.UI_DEBUG_VIEWPORT ?? '1440x960').split('x').map((n) => parseInt(n, 10) || 0);

/** Per-route collected diagnostics. */
function freshFindings() {
  return { consoleErrors: [], consoleWarnings: [], pageErrors: [], failedRequests: [], httpErrors: [] };
}

async function main() {
  await mkdir(OUT, { recursive: true });

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (err) {
    console.error(`ui-debug: could not launch Chrome (channel:'chrome'). Is Google Chrome installed?\n  ${err?.message ?? err}`);
    process.exit(2);
  }

  const context = await browser.newContext({
    viewport: { width: VW || 1440, height: VH || 960 },
    deviceScaleFactor: 2, // crisp text in the PNGs
  });

  // Attach the bearer ONLY to same-origin requests. extraHTTPHeaders would leak
  // it onto cross-origin fetches (e.g. Google Fonts), tripping a CORS preflight
  // that fails — false-positive console errors and a stuck networkidle. The real
  // app never sends auth off-origin, so scope it to BASE to stay faithful.
  if (TOKEN) {
    await context.route('**/*', async (route) => {
      const req = route.request();
      if (req.url().startsWith(BASE)) {
        await route.continue({ headers: { ...req.headers(), authorization: `Bearer ${TOKEN}` } });
      } else {
        await route.continue();
      }
    });
  }

  const report = { base: BASE, authed: Boolean(TOKEN), startedAt: new Date().toISOString(), routes: {} };

  for (const route of ROUTES) {
    const page = await context.newPage();
    const f = freshFindings();

    page.on('console', (msg) => {
      const type = msg.type();
      if (type === 'error') f.consoleErrors.push(msg.text());
      else if (type === 'warning') f.consoleWarnings.push(msg.text());
    });
    page.on('pageerror', (err) => f.pageErrors.push(err.message));
    page.on('requestfailed', (req) => {
      const failure = req.failure();
      f.failedRequests.push(`${req.method()} ${req.url()} — ${failure ? failure.errorText : 'failed'}`);
    });
    page.on('response', (res) => {
      if (res.status() >= 400) f.httpErrors.push(`${res.status()} ${res.request().method()} ${res.url()}`);
    });

    const url = `${BASE}/#${route}`;
    let loadError = null;
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
    } catch (err) {
      loadError = err?.message ?? String(err);
    }
    // Let the one-shot useAsync fetches settle + the screens render their data.
    await page.waitForTimeout(900);

    // Surface the app's own visible error branch (e.g. the "Unauthorized" card).
    const unauthorized = await page
      .getByText(/Unauthorized/i)
      .first()
      .isVisible()
      .catch(() => false);

    const shot = resolve(OUT, `${route}.png`);
    await page.screenshot({ path: shot, fullPage: true }).catch((e) => {
      f.pageErrors.push(`screenshot failed: ${e?.message ?? e}`);
    });

    report.routes[route] = {
      url,
      screenshot: shot,
      ...(loadError ? { loadError } : {}),
      unauthorized,
      ...f,
    };
    await page.close();
  }

  await browser.close();

  const reportPath = resolve(OUT, 'report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  // Console summary — the part the agent reads at a glance.
  let issues = 0;
  console.log(`\nui-debug · ${BASE} · auth=${report.authed ? 'bearer' : 'none'}`);
  console.log('─'.repeat(60));
  for (const route of ROUTES) {
    const r = report.routes[route];
    const counts = [
      r.pageErrors.length && `${r.pageErrors.length} pageError`,
      r.consoleErrors.length && `${r.consoleErrors.length} consoleError`,
      r.httpErrors.length && `${r.httpErrors.length} http≥400`,
      r.failedRequests.length && `${r.failedRequests.length} reqFailed`,
      r.consoleWarnings.length && `${r.consoleWarnings.length} warn`,
      r.unauthorized && 'UNAUTHORIZED',
      r.loadError && 'LOAD-ERROR',
    ].filter(Boolean);
    issues += r.pageErrors.length + r.consoleErrors.length + r.httpErrors.length + r.failedRequests.length;
    const flag = counts.length ? '⚠ ' : '✓ ';
    console.log(`${flag}${route.padEnd(10)} ${counts.length ? counts.join(', ') : 'clean'}`);
    for (const e of r.pageErrors) console.log(`     pageError: ${e}`);
    for (const e of r.consoleErrors) console.log(`     console:   ${e}`);
    for (const e of r.httpErrors) console.log(`     http:      ${e}`);
  }
  console.log('─'.repeat(60));
  console.log(`screenshots + report.json → ${OUT}`);

  if (issues > 0 && process.env.UI_DEBUG_SOFT !== '1') process.exit(1);
}

main().catch((err) => {
  console.error(`ui-debug: fatal — ${err?.stack ?? err}`);
  process.exit(2);
});
