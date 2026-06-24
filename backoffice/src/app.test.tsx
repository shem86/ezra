import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { NAV } from './routes';

afterEach(cleanup);
beforeEach(() => {
  location.hash = '';
});

describe('App shell', () => {
  it('mounts with the Overview route by default', () => {
    render(<App />);
    expect(screen.getByText('Ezra')).toBeInTheDocument();
    // chrome is always present even before the live dashboard data resolves
    expect(screen.getByText(/WhatsApp household assistant/)).toBeInTheDocument();
    expect(location.hash).toBe('#dashboard');
  });

  it('navigates to every route without error', () => {
    render(<App />);
    for (const n of NAV) {
      fireEvent.click(screen.getByRole('button', { name: n.label }));
      expect(location.hash).toBe('#' + n.id);
    }
    // landed on Status last (topbar title is always present, even before/if
    // the live probe fetch resolves)
    expect(screen.getByText('System status')).toBeInTheDocument();
  });

  it('honours the initial location.hash', () => {
    location.hash = '#costs';
    render(<App />);
    // Costs fetches live; before data lands it shows the page chrome + loader.
    expect(screen.getByText('Costs & tokenomics')).toBeInTheDocument();
  });
});
