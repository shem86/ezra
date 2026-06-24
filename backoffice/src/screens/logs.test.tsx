import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LogsScreen } from './logs';
import type { ApiClient } from '../api/client';
import type { LogsResponse, TurnRow } from '../api/types';

afterEach(cleanup);

const turn = (over: Partial<TurnRow>): TurnRow => ({
  id: 'turn-abc',
  ts: '2026-06-24T12:00:00.000Z',
  level: 'info',
  st: 'committed',
  ms: 1850,
  tool: 'reminder.add',
  tier: 'autonomous',
  tokens: 8200,
  cache: 81,
  cost: 0.012,
  ...over,
});

const client = (logs: LogsResponse): ApiClient => ({
  catalogue: async () => ({ tables: [] }),
  table: async () => ({ table: '', label: '', icon: '', columns: [], rows: [] }),
  costs: async () => {
    throw new Error('unused');
  },
  logs: async () => logs,
});

describe('LogsScreen (live)', () => {
  it('lists turns and expands a trace row on click', async () => {
    const enriched: LogsResponse = {
      enriched: true,
      turns: [turn({ id: 'turn-one' }), turn({ id: 'turn-two', st: 'recovered', level: 'warn', tokens: null, cache: null, cost: null, tool: null, tier: null })],
    };
    render(<LogsScreen client={client(enriched)} />);
    expect(await screen.findByText('turn-one')).toBeInTheDocument();
    expect(screen.getByText('recovered')).toBeInTheDocument();

    fireEvent.click(screen.getByText('turn-one'));
    expect(screen.getByText('Total tokens')).toBeInTheDocument(); // detail row opened
  });

  it('notes when Langfuse enrichment is unavailable', async () => {
    const degraded: LogsResponse = {
      enriched: false,
      turns: [turn({ tokens: null, cache: null, cost: null, tool: null, tier: null })],
    };
    render(<LogsScreen client={client(degraded)} />);
    expect(await screen.findByText(/enrichment is unavailable/i)).toBeInTheDocument();
  });
});
