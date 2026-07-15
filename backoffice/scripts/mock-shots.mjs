// mock-shots — render the read-only console against fabricated, non-PII data
// and screenshot all five screens for the README showcase. Unlike ui-debug
// (which hits a live backend), this intercepts every /api/* request in the
// browser and fulfils it with the fixtures below, so it needs only the vite
// dev server (pnpm --dir backoffice dev) and the bundled Playwright chromium —
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

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BACKOFFICE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
const OUT = resolve(process.env.MOCK_SHOTS_OUT ?? resolve(HERE, '..', '..', 'docs', 'assets', 'backoffice'));

const costs = {
  estimated: true,
  budgetUsd: 30,
  monthCostUsd: 9.17,
  lastMonthCostUsd: 8.94,
  tokensMonth: 6_100_000,
  cacheReadPct: 78,
  dailyCost: [0.22, 0.31, 0.28, 0.19, 0.41, 0.33, 0.25, 0.3, 0.27, 0.38, 0.29, 0.24, 0.35, 0.31, 0.26, 0.4, 0.28, 0.22, 0.33, 0.3, 0.27, 0.36, 0.29, 0.25, 0.34, 0.31, 0.28, 0.39, 0.3, 0.26],
  tokenSplit: [
    { label: 'Cache read', pct: 0.78, color: 'var(--ok)' },
    { label: 'Fresh input', pct: 0.14, color: 'var(--accent)' },
    { label: 'Cache write', pct: 0.05, color: 'var(--amber)' },
    { label: 'Output', pct: 0.03, color: 'var(--muted-2)' },
  ],
  byUsage: [
    { name: 'Cache read', note: '$0.30 / 1M', tokens: 4_758_000, cost: 1.43, share: 0.78 },
    { name: 'Fresh input', note: '$3.00 / 1M', tokens: 854_000, cost: 2.56, share: 0.14 },
    { name: 'Cache write', note: '$3.75 / 1M', tokens: 305_000, cost: 1.14, share: 0.05 },
    { name: 'Output', note: '$15.00 / 1M', tokens: 183_000, cost: 2.75, share: 0.03 },
  ],
};

const status = {
  services: [
    { name: 'Postgres + pgvector', group: 'Core', status: 'operational', latency: '6ms', uptime: '99.98%', detail: 'journal + state + memory' },
    { name: 'DBOS runtime', group: 'Core', status: 'operational', latency: '—', uptime: '99.98%', detail: 'no stranded workflows' },
    { name: 'WhatsApp (Baileys)', group: 'Transport', status: 'operational', latency: '210ms', uptime: '99.9%', detail: 'socket connected' },
    { name: 'Claude (AI SDK)', group: 'Model', status: 'operational', latency: '1.2s', uptime: '100%', detail: 'sonnet-class turns' },
    { name: 'Voyage embeddings', group: 'Model', status: 'operational', latency: '340ms', uptime: '100%', detail: 'voyage-4-lite' },
    { name: 'Google Calendar', group: 'Integrations', status: 'operational', latency: '480ms', uptime: '99.7%', detail: 'service-account' },
    { name: 'Langfuse tracing', group: 'Observability', status: 'operational', latency: '90ms', uptime: '100%', detail: 'spans flushing' },
  ],
  edges: [
    { name: 'Ingestion', status: 'ok', detail: 'durable enqueue before ack' },
    { name: 'Recovery', status: 'ok', detail: 'encrypted PITR to S3, verified restore' },
    { name: 'Liveness', status: 'ok', detail: 'dead-man ping < 5m' },
    { name: 'Egress allowlist', status: 'ok', detail: 'nftables ↔ code, drift-tested' },
  ],
  turnsToday: 38,
  avgLatency: '1.3s',
};

const t = (id, over) => ({ id, ts: '2026-07-14T14:32:00.000Z', level: 'info', st: 'committed', ms: 1420, tool: 'reminder.add', tier: 'autonomous', tokens: 8100, cache: 82, cost: 0.011, ...over });
const logs = {
  enriched: true,
  turns: [
    t('turn-7f2a', { tool: 'list.add', ms: 980, tokens: 6400, cache: 84, cost: 0.008 }),
    t('turn-7f2b', { tool: 'reminder.add', ms: 1420, tokens: 8100, cache: 82, cost: 0.011 }),
    t('turn-7f2c', { tool: 'calendar.create', tier: 'confirm-before', st: 'parked', ms: 1650, tokens: 9200, cache: 79, cost: 0.014 }),
    t('turn-7f2d', { tool: 'recall.search', ms: 2100, tokens: 11800, cache: 76, cost: 0.019 }),
    t('turn-7f2e', { tool: null, tier: null, st: 'recovered', level: 'warn', ms: 300, tokens: null, cache: null, cost: null }),
    t('turn-7f2f', { tool: 'fact.set', ms: 760, tokens: 5200, cache: 86, cost: 0.006 }),
    t('turn-7f30', { tool: 'list.get', ms: 640, tokens: 4900, cache: 88, cost: 0.005 }),
    t('turn-7f31', { tool: 'reminder.cancel', ms: 890, tokens: 5800, cache: 85, cost: 0.007 }),
  ],
};

const catalogue = {
  tables: [
    { table: 'lists', label: 'lists', icon: 'cart' },
    { table: 'reminders', label: 'reminders', icon: 'bell' },
    { table: 'facts', label: 'facts', icon: 'book' },
    { table: 'pending_actions', label: 'pending_actions', icon: 'pause' },
    { table: 'sent_log', label: 'sent_log', icon: 'send' },
  ],
};

const tables = {
  lists: {
    table: 'lists', label: 'lists', icon: 'cart',
    columns: ['id', 'list', 'item', 'added_by', 'done'],
    rows: [
      { id: 'lst_1', list: 'groceries', item: 'Oat milk', added_by: 'Noa', done: false },
      { id: 'lst_2', list: 'groceries', item: 'שמן זית', added_by: 'Amir', done: true },
      { id: 'lst_3', list: 'groceries', item: 'Bread', added_by: 'Noa', done: false },
      { id: 'lst_4', list: 'todo', item: 'תאם מוסך', added_by: 'Amir', done: false },
    ],
  },
  reminders: {
    table: 'reminders', label: 'reminders', icon: 'bell',
    columns: ['id', 'text', 'fire_at', 'status'],
    rows: [
      { id: 'rem_1', text: 'take out the trash', fire_at: 'tomorrow 07:00 ET', status: 'scheduled' },
      { id: 'rem_2', text: 'call plumber', fire_at: 'today 18:00 ET', status: 'scheduled' },
      { id: 'rem_3', text: 'pay water bill', fire_at: 'Jul 20 09:00 ET', status: 'fired' },
    ],
  },
  facts: {
    table: 'facts', label: 'facts', icon: 'book',
    columns: ['id', 'key', 'value', 'set_by'],
    rows: [
      { id: 'fct_1', key: 'parking gate code', value: '••••', set_by: 'Noa' },
      { id: 'fct_2', key: 'wifi network', value: 'household-5g', set_by: 'Amir' },
      { id: 'fct_3', key: 'cleaner day', value: 'Thursdays', set_by: 'Noa' },
    ],
  },
  pending_actions: {
    table: 'pending_actions', label: 'pending_actions', icon: 'pause',
    columns: ['action_id', 'tool', 'status', 'expires_at'],
    rows: [
      { action_id: 'pnd_1', tool: 'calendar.create', status: 'pending', expires_at: 'in 2h 40m' },
      { action_id: 'pnd_2', tool: 'calendar.update', status: 'approved', expires_at: '—' },
    ],
  },
  sent_log: {
    table: 'sent_log', label: 'sent_log', icon: 'send',
    columns: ['id', 'class', 'status', 'at'],
    rows: [
      { id: 'snt_1', class: 'at-most-once', status: 'sent', at: '14:32:04' },
      { id: 'snt_2', class: 'at-least-once', status: 'sent', at: '14:31:58' },
    ],
  },
};

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
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (p === '/api/costs') return json(costs);
    if (p === '/api/status') return json(status);
    if (p === '/api/logs') return json(logs);
    if (p === '/api/db') return json(catalogue);
    const m = p.match(/^\/api\/db\/([^/]+)$/);
    if (m) return json(tables[decodeURIComponent(m[1])] ?? tables.lists);
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
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
