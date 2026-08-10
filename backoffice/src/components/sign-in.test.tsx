import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignIn } from './sign-in';
import { ApiError, UNAUTHORIZED_EVENT } from '../api/client';
import { App } from '../app';

afterEach(cleanup);

describe('SignIn', () => {
  it('submits the typed token and reports success', async () => {
    const signIn = vi.fn(async () => {});
    const onSignedIn = vi.fn();
    render(<SignIn onSignedIn={onSignedIn} signIn={signIn} />);

    fireEvent.change(screen.getByLabelText(/console token/i), { target: { value: '  secret-token  ' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalledOnce());
    // Trimmed before sending — a token pasted with stray whitespace still works.
    expect(signIn).toHaveBeenCalledWith('secret-token');
  });

  it('shows the failure on the form instead of signing out', async () => {
    const signIn = vi.fn(async () => {
      throw new ApiError(401, 'that token was not accepted');
    });
    const onSignedIn = vi.fn();
    render(<SignIn onSignedIn={onSignedIn} signIn={signIn} />);

    fireEvent.change(screen.getByLabelText(/console token/i), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('that token was not accepted');
    expect(onSignedIn).not.toHaveBeenCalled();
  });

  it('will not submit an empty token', () => {
    render(<SignIn onSignedIn={vi.fn()} signIn={vi.fn()} />);
    expect(screen.getByRole('button', { name: /sign in/i })).toBeDisabled();
  });

  it('masks the token as it is typed', () => {
    render(<SignIn onSignedIn={vi.fn()} signIn={vi.fn()} />);
    expect(screen.getByLabelText(/console token/i)).toHaveAttribute('type', 'password');
  });
});

describe('App session handling', () => {
  it('swaps in the sign-in screen when any call reports 401', async () => {
    render(<App />);
    expect(screen.getByText('Ezra')).toBeInTheDocument();

    // What the api client raises on a 401 from any screen.
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));

    expect(await screen.findByLabelText(/console token/i)).toBeInTheDocument();
    // The console chrome is gone — nothing renders behind the form.
    expect(screen.queryByText(/WhatsApp household assistant/)).not.toBeInTheDocument();
  });
});
