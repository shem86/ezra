// Fabricated, non-PII fixtures for the read-only console — the single source
// shared by `mock-shots.mjs` (README screenshots, intercepts fetch in-browser)
// and `mock-api.mjs` (a real HTTP server, so a human can click the console in
// their own browser with no prod host and no household data).
//
// Everything here is fictional (Amir/Noa, generic facts) and mirrors the shapes
// the screens' unit tests use. The cost story ($9.17 MTD, 78% cache reads)
// matches the README's tokenomics claim on purpose.
//
// Timestamps are ABSOLUTE, not relative to now: screenshots have to be
// byte-stable across runs or every `mock-shots` regenerates a diff.

export const costs = {
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

export const status = {
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

// A household's traffic, not a burst: turns spread over ~36 hours with a quiet
// night in the middle, so the volume and latency charts show the shape they
// exist to show. Deterministic — a fixed-seed LCG, never Math.random.
function makeTurns() {
  let seed = 20260714;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = (xs) => xs[Math.floor(rnd() * xs.length)];

  const TOOLS = ['list.add', 'list.get', 'reminder.add', 'reminder.cancel', 'fact.set', 'recall.search', 'calendar.create'];
  const END = Date.parse('2026-07-14T21:00:00.000Z');
  const turns = [];
  let backMin = 0;

  for (let i = 0; i < 46; i++) {
    // Walk backwards in uneven gaps, with a long overnight hole after the 18th
    // turn — a flat hourly rate is the one thing real traffic never looks like.
    backMin += i === 18 ? 7 * 60 : 8 + Math.floor(rnd() * 55);
    const ts = new Date(END - backMin * 60_000);
    const roll = rnd();
    const level = roll > 0.94 ? 'error' : roll > 0.84 ? 'warn' : 'info';
    const tool = level === 'error' ? null : pick(TOOLS);
    const st = level === 'error' ? 'error' : level === 'warn' ? 'recovered' : 'committed';
    // Latency is lognormal-ish: a tight body around ~1.2s with a real tail, so
    // p95 sits somewhere worth marking instead of on top of the median.
    const ms = level === 'error' ? 300 + Math.floor(rnd() * 200) : Math.round(620 + rnd() * rnd() * 5200);
    const tokens = level === 'error' ? null : 4200 + Math.floor(rnd() * 9000);
    const cache = tokens === null ? null : 71 + Math.floor(rnd() * 19);
    turns.push({
      id: `turn-${(0x7f2a + i).toString(16)}`,
      ts: ts.toISOString(),
      level,
      st,
      ms,
      tool,
      tier: tool === 'calendar.create' ? 'confirm-before' : tool === null ? null : 'autonomous',
      tokens,
      cache,
      cost: tokens === null ? null : Number(((tokens / 1e6) * 1.6).toFixed(4)),
    });
  }
  // Newest first, matching the real endpoint's ordering.
  return turns.sort((a, b) => b.ts.localeCompare(a.ts));
}

export const logs = { enriched: true, turns: makeTurns() };

export const catalogue = {
  tables: [
    { table: 'lists', label: 'lists', icon: 'cart' },
    { table: 'reminders', label: 'reminders', icon: 'bell' },
    { table: 'facts', label: 'facts', icon: 'book' },
    { table: 'pending_actions', label: 'pending_actions', icon: 'pause' },
    { table: 'sent_log', label: 'sent_log', icon: 'send' },
  ],
};

export const tables = {
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

/**
 * Resolve an /api pathname to a fixture body, or null for 404.
 * Shared so the screenshot interceptor and the HTTP server can never drift.
 */
export function resolveFixture(pathname) {
  if (pathname === '/api/costs') return costs;
  if (pathname === '/api/status') return status;
  if (pathname === '/api/logs') return logs;
  if (pathname === '/api/db') return catalogue;
  const m = pathname.match(/^\/api\/db\/([^/]+)$/);
  if (m) return tables[decodeURIComponent(m[1])] ?? tables.lists;
  return null;
}
