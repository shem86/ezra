import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseScreen, sortRows } from './database';
import type { ApiClient } from '../api/client';
import type { TableListing } from '../api/types';

afterEach(cleanup);

const listing: TableListing = {
  table: 'lists',
  label: 'lists',
  icon: 'cart',
  columns: ['id', 'item', 'added_by', 'done'],
  rows: [
    { id: 'lst_1', item: 'Oat milk', added_by: 'Amir', done: false },
    { id: 'lst_2', item: 'שמן זית', added_by: 'Noa', done: true },
  ],
};

const unused = async (): Promise<never> => {
  throw new Error('not used');
};

const fakeClient: ApiClient = {
  catalogue: async () => ({
    tables: [
      { table: 'lists', label: 'lists', icon: 'cart' },
      { table: 'reminders', label: 'reminders', icon: 'bell' },
    ],
  }),
  table: async () => listing,
  costs: unused,
  logs: unused,
  status: unused,
};

describe('DatabaseScreen (live data)', () => {
  it('renders rows from the api client and opens the row drawer', async () => {
    render(<DatabaseScreen client={fakeClient} />);
    expect(await screen.findByText('Oat milk')).toBeInTheDocument();
    expect(screen.getByText('read-only')).toBeInTheDocument();
    // Hebrew row renders
    expect(screen.getByText('שמן זית')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Oat milk'));
    // drawer shows the disabled edit affordance
    expect(screen.getByRole('button', { name: 'Edit row' })).toBeDisabled();
  });

  it('shows an auth prompt on 401', async () => {
    const failing: ApiClient = {
      catalogue: async () => {
        throw Object.assign(new Error('unauthorized'), { name: 'ApiError' });
      },
      table: async () => listing,
      costs: unused,
      logs: unused,
      status: unused,
    };
    render(<DatabaseScreen client={failing} />);
    await waitFor(() => expect(screen.getByText(/Session expired/)).toBeInTheDocument());
  });

  it('sorts by a clicked column: asc, then desc, then back to the server order', async () => {
    render(<DatabaseScreen client={fakeClient} />);
    await screen.findByText('Oat milk');
    const items = (): string[] =>
      screen.getAllByRole('row').slice(1).map((r) => r.querySelectorAll('td')[1]!.textContent ?? '');
    const header = screen.getByRole('columnheader', { name: /added_by/ });

    fireEvent.click(screen.getByRole('button', { name: /added_by/ }));
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    expect(items()).toEqual(['Oat milk', 'שמן זית']);

    fireEvent.click(screen.getByRole('button', { name: /added_by/ }));
    expect(header).toHaveAttribute('aria-sort', 'descending');
    expect(items()).toEqual(['שמן זית', 'Oat milk']);

    fireEvent.click(screen.getByRole('button', { name: /added_by/ }));
    expect(header).not.toHaveAttribute('aria-sort');
    expect(items()).toEqual(['Oat milk', 'שמן זית']);
  });
});

describe('sortRows', () => {
  const rows = [
    { seq: '10', at: '2026-11-01 09:00:00+00', done: true, n: null },
    { seq: '9', at: '2026-11-02 08:00:00.5+00', done: false, n: 3 },
    { seq: '100', at: null, done: false, n: 1 },
  ];
  it('compares numeric strings numerically and timestamps chronologically', () => {
    expect(sortRows(rows, { col: 'seq', dir: 'asc' }).map((r) => r.seq)).toEqual(['9', '10', '100']);
    expect(sortRows(rows, { col: 'at', dir: 'desc' }).map((r) => r.seq)).toEqual(['9', '10', '100']);
  });
  it('keeps empty values last in both directions', () => {
    expect(sortRows(rows, { col: 'n', dir: 'asc' }).map((r) => r.n)).toEqual([1, 3, null]);
    expect(sortRows(rows, { col: 'n', dir: 'desc' }).map((r) => r.n)).toEqual([3, 1, null]);
  });
  it('orders booleans false before true, and is stable for ties', () => {
    expect(sortRows(rows, { col: 'done', dir: 'asc' }).map((r) => r.seq)).toEqual(['9', '100', '10']);
  });
});
