import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OverviewScreen } from './overview';
import type { ApiClient } from '../api/client';
import type { CostsResponse, LogsResponse, StatusResponse, TableListing } from '../api/types';

afterEach(cleanup);

const costs: CostsResponse = {
  estimated: true,
  budgetUsd: 50,
  monthCostUsd: 3.94,
  lastMonthCostUsd: 1,
  tokensMonth: 1_680_000,
  cacheReadPct: 31,
  dailyCost: Array.from({ length: 30 }, () => 0.1),
  tokenSplit: [],
  byUsage: [],
};
const status: StatusResponse = {
  services: [
    { name: 'Postgres', group: 'Core', status: 'operational', latency: '6ms', uptime: '', detail: '' },
    { name: 'WhatsApp (Baileys)', group: 'Transport', status: 'down', latency: '—', uptime: '', detail: '' },
  ],
  edges: [],
  turnsToday: 96,
  avgLatency: '793ms',
};
const logs: LogsResponse = {
  enriched: true,
  turns: [
    { id: 'turn-ok', ts: '2026-06-24T12:00:00Z', level: 'info', st: 'committed', ms: 800, tool: 'reminder.add', tier: 'autonomous', tokens: 8000, cache: 80, cost: 0.01 },
    { id: 'turn-bad', ts: '2026-06-24T11:00:00Z', level: 'error', st: 'error', ms: 200, tool: null, tier: null, tokens: null, cache: null, cost: null },
  ],
};
const pending: TableListing = {
  table: 'pending_actions',
  label: 'pending_actions',
  icon: 'pause',
  columns: ['action_id', 'tool', 'status', 'expires_at'],
  rows: [
    { action_id: 'pnd_1', tool: 'calendar.create', status: 'pending', expires_at: 'in 3h' },
    { action_id: 'pnd_2', tool: 'calendar.update', status: 'approved', expires_at: '—' },
  ],
};

const client: ApiClient = {
  catalogue: async () => ({ tables: [] }),
  table: async () => pending,
  costs: async () => costs,
  logs: async () => logs,
  status: async () => status,
};

describe('OverviewScreen (composed live)', () => {
  it('composes spend, approvals, turns, errors, and health', async () => {
    const onOpen = vi.fn();
    render(<OverviewScreen onOpen={onOpen} client={client} />);

    // MTD spend shows in both the SpendCard and the KPI tile
    expect(await screen.findByText('Spend this month (est.)')).toBeInTheDocument();
    expect(screen.getAllByText('$3.94').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('96')).toBeInTheDocument(); // turns today
    // one parked (status==='pending') approval, not the approved one
    expect(screen.getByText('1 pending')).toBeInTheDocument();
    expect(screen.getByText('calendar.create')).toBeInTheDocument();
    // health rollup shows the down service
    expect(screen.getByText('1 down')).toBeInTheDocument();
    // recent turns feed shows turn ids
    expect(screen.getByText('turn-ok')).toBeInTheDocument();
    // Approve disabled (read-only)
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
  });
});
