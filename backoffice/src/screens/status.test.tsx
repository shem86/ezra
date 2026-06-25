import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StatusScreen } from './status';
import type { ApiClient } from '../api/client';
import type { StatusResponse } from '../api/types';

afterEach(cleanup);

const client = (status: StatusResponse): ApiClient => ({
  catalogue: async () => ({ tables: [] }),
  table: async () => ({ table: '', label: '', icon: '', columns: [], rows: [] }),
  costs: async () => {
    throw new Error('unused');
  },
  logs: async () => ({ turns: [], enriched: false }),
  status: async () => status,
});

const data: StatusResponse = {
  services: [
    { name: 'Postgres', group: 'Core', status: 'operational', latency: '6ms', uptime: '', detail: 'journal + state' },
    { name: 'Google Calendar', group: 'Integrations', status: 'degraded', latency: '2.1s', uptime: '', detail: 'service-account read' },
  ],
  edges: [{ name: 'Recovery', status: 'ok', detail: 'Encrypted PITR' }],
  turnsToday: 42,
  avgLatency: '1.4s',
};

describe('StatusScreen (live)', () => {
  it('renders probe results and the degraded banner', async () => {
    render(<StatusScreen client={client(data)} />);
    expect(await screen.findByText('Postgres')).toBeInTheDocument();
    expect(screen.getByText('Reliability edges')).toBeInTheDocument();
    expect(screen.getByText(/Degraded/)).toBeInTheDocument();
    expect(screen.getByText(/42 turns today/)).toBeInTheDocument();
  });

  it('shows all-operational when nothing is degraded', async () => {
    const allOk: StatusResponse = {
      ...data,
      services: [{ name: 'Postgres', group: 'Core', status: 'operational', latency: '6ms', uptime: '', detail: 'ok' }],
    };
    render(<StatusScreen client={client(allOk)} />);
    expect(await screen.findByText('All systems operational')).toBeInTheDocument();
  });

  it('re-runs the probes when the refresh button is pressed', async () => {
    const status = vi.fn(async () => data);
    const c: ApiClient = { ...client(data), status };
    render(<StatusScreen client={c} />);
    await screen.findByText('Postgres');
    expect(status).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh probes' }));
    await waitFor(() => expect(status).toHaveBeenCalledTimes(2));
  });
});
