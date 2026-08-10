import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './app';
import { NAV } from './routes';
import { UNAUTHORIZED_EVENT, type UnauthorizedDetail } from './api/client';

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

// The shell owns the session: any auth-class response from any screen must land
// the operator on the sign-in form, which is the only screen that can fix it.
describe('App session handling', () => {
  const raise = (status: number): void => {
    window.dispatchEvent(new CustomEvent<UnauthorizedDetail>(UNAUTHORIZED_EVENT, { detail: { status } }));
  };

  it('swaps in the sign-in screen when any call reports 401', async () => {
    render(<App />);
    expect(screen.getByText('Ezra')).toBeInTheDocument();

    raise(401);

    expect(await screen.findByLabelText(/console token/i)).toBeInTheDocument();
    // The console chrome is gone — nothing renders behind the form.
    expect(screen.queryByText(/WhatsApp household assistant/)).not.toBeInTheDocument();
    // An expired session needs no explanation beyond the form itself.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  // A throttled browser used to sit on five identical error cards with no route
  // to the form, because only 401 raised the event (2026-08-10, second shape).
  it('swaps in the sign-in screen on 429 and says the console is healthy', async () => {
    render(<App />);

    raise(429);

    expect(await screen.findByLabelText(/console token/i)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/console is healthy/i);
  });

  it('returns to the form on sign out', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);

    fireEvent.click(screen.getByRole('button', { name: /sign out/i }));

    expect(await screen.findByLabelText(/console token/i)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([url]) => String(url) === '/api/signout')).toBe(true);
    vi.unstubAllGlobals();
  });
});
