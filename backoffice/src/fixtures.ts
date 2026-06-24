// Typed fixtures mirroring the prototype's data.js shapes. Used for visual
// parity until the real read-only API lands (BO-7+). When a screen is wired to
// live data it stops importing from here. No mock data ships in production:
// the served bundle reads /api/* (see backoffice/src/api).

export type CellValue = string | number | boolean;
export type Row = Record<string, CellValue>;

export interface TableFixture {
  label: string;
  icon: string;
  note?: string;
  columns: string[];
  rows: Row[];
}

export interface ModelCost {
  name: string;
  role: string;
  calls: number;
  tokens: string;
  cost: number;
  share: number;
}

export interface TokenSplitSlice {
  label: string;
  pct: number;
  color: string;
}

export interface LogRow {
  id: string;
  ts: string;
  level: 'info' | 'warn' | 'error';
  trigger: string;
  summary: string;
  tool: string;
  tier: string;
  tokens: number;
  cache: number;
  cost: number;
  ms: number;
  st: string;
}

export interface ServiceRow {
  name: string;
  group: string;
  status: 'operational' | 'degraded' | 'down';
  latency: string;
  uptime: string;
  detail: string;
}

export interface EdgeRow {
  name: string;
  status: string;
  detail: string;
}

export interface Kpis {
  monthCost: number;
  lastMonthCost: number;
  budget: number;
  cacheReadPct: number;
  turnsToday: number;
  turnsYesterday: number;
  pendingApprovals: number;
  openReminders: number;
  errors24h: number;
  avgLatency: string;
  tokensMonth: string;
  recovered7d: number;
}

export interface Household {
  group: string;
  jid: string;
  members: number;
  locale: string;
}

const now = new Date('2026-06-23T14:32:00');
const ago = (mins: number): Date => new Date(now.getTime() - mins * 60000);
const fmtTime = (d: Date): string =>
  d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export const household: Household = { group: 'Mercer Family', jid: '972•••@g.us', members: 2, locale: 'he / en' };

export const tables: Record<string, TableFixture> = {
  reminders: {
    label: 'reminders',
    icon: 'bell',
    columns: ['id', 'text', 'owner', 'due', 'status', 'via'],
    rows: [
      { id: 'rmd_204', text: 'Pay water bill', owner: 'Noa', due: 'Jun 25, 09:00', status: 'pending', via: 'message' },
      { id: 'rmd_203', text: 'להתקשר למוסך', owner: 'Amir', due: 'Jun 24, 17:30', status: 'pending', via: 'message' },
      { id: 'rmd_202', text: 'Iris — math tutor', owner: 'Noa', due: 'Jun 24, 16:00', status: 'pending', via: 'schedule' },
      { id: 'rmd_201', text: 'Call plumber re: leak', owner: 'Noa', due: 'Jun 23, 11:00', status: 'done', via: 'message' },
      { id: 'rmd_200', text: 'חידוש ביטוח רכב', owner: 'Amir', due: 'Jun 22, 10:00', status: 'overdue', via: 'message' },
    ],
  },
  list_items: {
    label: 'list_items',
    icon: 'cart',
    columns: ['id', 'list', 'item', 'qty', 'added_by', 'done'],
    rows: [
      { id: 'lst_88', list: 'groceries', item: 'Oat milk', qty: '2', added_by: 'Amir', done: false },
      { id: 'lst_87', list: 'groceries', item: 'Sourdough', qty: '1', added_by: 'Noa', done: false },
      { id: 'lst_86', list: 'groceries', item: 'שמן זית', qty: '1', added_by: 'Amir', done: true },
    ],
  },
};

export const models: ModelCost[] = [
  { name: 'claude-sonnet-4', role: 'turn reasoning', calls: 1240, tokens: '3.42M', cost: 6.71, share: 0.73 },
  { name: 'claude-haiku', role: 'relatedness classifier', calls: 2980, tokens: '1.18M', cost: 1.06, share: 0.12 },
  { name: 'voyage-4-lite', role: 'semantic memory embeddings', calls: 884, tokens: '0.91M', cost: 0.74, share: 0.08 },
  { name: 'claude-sonnet-4', role: 'compaction summaries', calls: 96, tokens: '0.62M', cost: 0.66, share: 0.07 },
];

export const tokenSplit: TokenSplitSlice[] = [
  { label: 'Cache read', pct: 0.78, color: 'var(--ok)' },
  { label: 'Fresh input', pct: 0.14, color: 'var(--accent)' },
  { label: 'Cache write', pct: 0.05, color: 'var(--amber)' },
  { label: 'Output', pct: 0.03, color: 'var(--muted-2)' },
];

export const dailyCost: number[] = [
  0.24, 0.28, 0.22, 0.31, 0.36, 0.19, 0.18, 0.3, 0.34, 0.41, 0.27, 0.25, 0.33, 0.38, 0.42, 0.3,
  0.22, 0.2, 0.34, 0.39, 0.36, 0.32, 0.27, 0.24, 0.35, 0.4, 0.45, 0.37, 0.33, 0.29,
];

const logSeeds: Omit<LogRow, 'id' | 'ts'>[] = [
  { level: 'info', trigger: 'message · Noa', summary: 'Added reminder "Pay water bill"', tool: 'reminder.add', tier: 'autonomous', tokens: 8200, cache: 81, cost: 0.012, ms: 2310, st: 'committed' },
  { level: 'info', trigger: 'message · Amir', summary: 'Recalled dentist details from memory', tool: 'memory.search', tier: 'autonomous', tokens: 5400, cache: 86, cost: 0.007, ms: 1180, st: 'committed' },
  { level: 'warn', trigger: 'schedule · brief', summary: 'Calendar read slow (3.2s)', tool: 'calendar.list', tier: 'autonomous', tokens: 6100, cache: 88, cost: 0.009, ms: 4120, st: 'committed' },
  { level: 'info', trigger: 'message · Amir', summary: 'Parked calendar.create for approval', tool: 'calendar.create', tier: 'confirm-before', tokens: 11400, cache: 74, cost: 0.018, ms: 2540, st: 'parked' },
  { level: 'error', trigger: 'message · Noa', summary: 'Tool arg failed Zod validation — handled', tool: 'reminder.add', tier: 'autonomous', tokens: 1200, cache: 0, cost: 0.002, ms: 880, st: 'committed' },
  { level: 'info', trigger: 'approval · Noa', summary: 'Approval bound → calendar.create executed', tool: 'calendar.create', tier: 'confirm-before', tokens: 2400, cache: 79, cost: 0.004, ms: 1640, st: 'committed' },
];

export const logs: LogRow[] = Array.from({ length: 60 }, (_, i): LogRow => {
  const s = logSeeds[i % logSeeds.length]!;
  return { ...s, id: 'trn_' + (4920 - i), ts: fmtTime(ago(i * 17 + (i % 5) * 3)) };
});

export const services: ServiceRow[] = [
  { name: 'Agent core (handleTurn)', group: 'Core', status: 'operational', latency: '120ms', uptime: '99.98%', detail: 'Reasoning loop · bounded rounds' },
  { name: 'DBOS workflows', group: 'Core', status: 'operational', latency: '—', uptime: '100%', detail: 'concurrency-1 lane, per-conversation' },
  { name: 'Postgres', group: 'Core', status: 'operational', latency: '6ms', uptime: '100%', detail: 'journal + state, co-committed' },
  { name: 'pgvector memory', group: 'Core', status: 'operational', latency: '22ms', uptime: '99.9%', detail: '0.91M embeddings' },
  { name: 'Anthropic API', group: 'Models', status: 'operational', latency: '880ms', uptime: '99.7%', detail: 'claude-sonnet-4 / haiku' },
  { name: 'Voyage API', group: 'Models', status: 'operational', latency: '210ms', uptime: '99.5%', detail: 'voyage-4-lite' },
  { name: 'WhatsApp (Baileys)', group: 'Transport', status: 'operational', latency: '95ms', uptime: '99.6%', detail: 'socket up · group allowlisted' },
  { name: 'Google Calendar', group: 'Integrations', status: 'degraded', latency: '2.1s', uptime: '98.9%', detail: 'service account · elevated latency' },
  { name: 'Langfuse tracing', group: 'Observability', status: 'operational', latency: '40ms', uptime: '99.9%', detail: 'spans per durable step' },
];

export const edges: EdgeRow[] = [
  { name: 'Ingestion', status: 'ok', detail: 'Durably enqueued before ack · dedupe on replay' },
  { name: 'Durable execution', status: 'ok', detail: 'Exactly-once · co-committed checkpoints' },
  { name: 'External effects', status: 'ok', detail: 'Deterministic ids · 409 folds to success' },
  { name: 'Recovery', status: 'ok', detail: 'Encrypted PITR · mechanical reconciliation' },
  { name: 'Liveness', status: 'ok', detail: 'Independent alert channel' },
];

export const kpis: Kpis = {
  monthCost: 9.17,
  lastMonthCost: 8.94,
  budget: 30,
  cacheReadPct: 78,
  turnsToday: 64,
  turnsYesterday: 58,
  pendingApprovals: 2,
  openReminders: 4,
  errors24h: 2,
  avgLatency: '1.4s',
  tokensMonth: '6.1M',
  recovered7d: 1,
};

export const activity: LogRow[] = logs.slice(0, 9);
