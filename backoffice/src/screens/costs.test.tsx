import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CostsScreen } from './costs';
import type { ApiClient } from '../api/client';
import type { CostsResponse } from '../api/types';

afterEach(cleanup);

const costs: CostsResponse = {
  estimated: true,
  budgetUsd: 50,
  monthCostUsd: 9.17,
  lastMonthCostUsd: 8.94,
  tokensMonth: 6_100_000,
  cacheReadPct: 78,
  dailyCost: Array.from({ length: 30 }, (_, i) => (i % 3) * 0.1),
  tokenSplit: [
    { label: 'Cache read', pct: 0.78, color: 'var(--ok)' },
    { label: 'Fresh input', pct: 0.14, color: 'var(--accent)' },
    { label: 'Cache write', pct: 0.05, color: 'var(--amber)' },
    { label: 'Output', pct: 0.03, color: 'var(--muted-2)' },
  ],
  byUsage: [
    { name: 'Cache read', note: '$0.30 / 1M', tokens: 4_000_000, cost: 1.2, share: 0.4 },
    { name: 'Fresh input', note: '$3.00 / 1M', tokens: 700_000, cost: 2.1, share: 0.6 },
  ],
};

const stubClient = (partial: Partial<ApiClient>): ApiClient => ({
  catalogue: async () => ({ tables: [] }),
  table: async () => ({ table: '', label: '', icon: '', columns: [], rows: [] }),
  costs: async () => costs,
  logs: async () => ({ turns: [], enriched: false }),
  status: async () => ({ services: [], edges: [], turnsToday: 0, avgLatency: "—" }),
  ...partial,
});

describe('CostsScreen (live)', () => {
  it('renders estimated MTD spend, cache-read %, and per-usage-type rows', async () => {
    render(<CostsScreen client={stubClient({})} />);
    expect(await screen.findByText('$9.17')).toBeInTheDocument();
    expect(screen.getByText('input from prompt cache')).toBeInTheDocument();
    expect(screen.getByText('Estimated cost by usage type')).toBeInTheDocument();
    expect(screen.getByText('under budget')).toBeInTheDocument();
    // honest labelling that spend is an estimate (the inline <strong>)
    expect(screen.getByText('estimated')).toBeInTheDocument();
  });

  it('flags over-budget', async () => {
    render(<CostsScreen client={stubClient({ costs: async () => ({ ...costs, monthCostUsd: 75 }) })} />);
    expect(await screen.findByText('over budget')).toBeInTheDocument();
  });
});
