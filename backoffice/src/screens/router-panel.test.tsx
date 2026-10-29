import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { RouterPanel } from './router-panel';
import type { RouterResponse } from '../api/types';

afterEach(cleanup);

const data: RouterResponse = {
  mode: 'shadow',
  rows: [
    { name: 'Last routed turn', value: '2026-10-29T11:58:00.000Z', status: 'ok', detail: '9 routed of 9 turn(s) in 24h' },
    { name: 'Fallback rate', value: '25% of last 4 · 3 in a row', status: 'amber', detail: 'latest: fallback-error:timeout' },
  ],
  recent: [
    {
      workflowId: 'wf-1',
      conversationId: 'conv',
      createdAt: '2026-10-29T11:58:00.000Z',
      mode: 'shadow',
      tier: 'standard',
      proposed: 'deep',
      source: 'jev',
      latencyMs: 142,
      answers: { intent: 'planning_or_advice', weighsOptions: 0.93 },
      latestText: 'נלך לסבתא בשישי או בשבת?',
    },
  ],
};

describe('RouterPanel', () => {
  it('shows the mode, every health row, and flags amber ones', () => {
    render(<RouterPanel data={data} />);
    expect(screen.getByText(/Turn router/)).toBeInTheDocument();
    expect(screen.getByText('shadow')).toBeInTheDocument();
    expect(screen.getByText('Fallback rate')).toBeInTheDocument();
    expect(screen.getByText('25% of last 4 · 3 in a row')).toBeInTheDocument();
    expect(screen.getByText('needs a look')).toBeInTheDocument();
  });

  it('lists recent routed turns and expands one into its answers (the turn view)', () => {
    render(<RouterPanel data={data} />);
    const turn = screen.getByText('נלך לסבתא בשישי או בשבת?');
    expect(screen.queryByText(/weighsOptions/)).not.toBeInTheDocument();
    fireEvent.click(turn);
    expect(screen.getByText(/weighsOptions/)).toBeInTheDocument();
    expect(screen.getByText(/wf-1/)).toBeInTheDocument();
  });

  it('says so plainly when the router has never logged a turn', () => {
    render(<RouterPanel data={{ mode: null, rows: [], recent: [] }} />);
    expect(screen.getByText(/no routed turns yet/i)).toBeInTheDocument();
  });
});
