import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignIn } from './sign-in';
import { ApiError } from '../api/client';

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

  it('shows a notice explaining why the operator landed here', () => {
    render(<SignIn onSignedIn={vi.fn()} signIn={vi.fn()} notice="Too many failed attempts" />);
    expect(screen.getByRole('status')).toHaveTextContent('Too many failed attempts');
  });

  it('shows no notice for an ordinary expired session', () => {
    render(<SignIn onSignedIn={vi.fn()} signIn={vi.fn()} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
