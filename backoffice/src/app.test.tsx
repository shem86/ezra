import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './app';
import { NAV } from './routes';

afterEach(cleanup);
beforeEach(() => {
  location.hash = '';
});

describe('App shell', () => {
  it('mounts with the Overview dashboard by default', () => {
    render(<App />);
    expect(screen.getByText('Ezra')).toBeInTheDocument();
    // focus dashboard markers
    expect(screen.getByText('Spend this month')).toBeInTheDocument();
    expect(screen.getByText('Awaiting approval')).toBeInTheDocument();
  });

  it('navigates to every route without error', () => {
    render(<App />);
    for (const n of NAV) {
      fireEvent.click(screen.getByRole('button', { name: n.label }));
      expect(location.hash).toBe('#' + n.id);
    }
    // landed on Status last
    expect(screen.getByText('Reliability edges')).toBeInTheDocument();
  });

  it('honours the initial location.hash', () => {
    location.hash = '#costs';
    render(<App />);
    expect(screen.getByText('Cost by model')).toBeInTheDocument();
  });
});
