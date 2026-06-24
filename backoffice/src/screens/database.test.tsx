import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseScreen } from './database';
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

const fakeClient: ApiClient = {
  catalogue: async () => ({
    tables: [
      { table: 'lists', label: 'lists', icon: 'cart' },
      { table: 'reminders', label: 'reminders', icon: 'bell' },
    ],
  }),
  table: async () => listing,
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
    };
    render(<DatabaseScreen client={failing} />);
    await waitFor(() => expect(screen.getByText(/Unauthorized/)).toBeInTheDocument());
  });
});
