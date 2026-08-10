import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, signIn, signOut, UNAUTHORIZED_EVENT } from './client';

/** Collect UNAUTHORIZED_EVENT statuses raised while `run` executes. */
async function raisedBy(run: () => Promise<unknown>): Promise<number[]> {
  const seen: number[] = [];
  const listener = (e: Event): void => {
    seen.push((e as CustomEvent<{ status: number }>).detail?.status ?? -1);
  };
  window.addEventListener(UNAUTHORIZED_EVENT, listener);
  try {
    await run().catch(() => undefined);
  } finally {
    window.removeEventListener(UNAUTHORIZED_EVENT, listener);
  }
  return seen;
}

const respond = (status: number): void => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ error: 'x' }), { status })),
  );
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api client auth signalling', () => {
  it('raises UNAUTHORIZED_EVENT on 401', async () => {
    respond(401);
    expect(await raisedBy(() => api.costs())).toEqual([401]);
  });

  // 429 used to be silent, which left a throttled browser with no route to the
  // sign-in form — the second shape of the 2026-08-10 lockout.
  it('raises UNAUTHORIZED_EVENT on 429 too', async () => {
    respond(429);
    expect(await raisedBy(() => api.status())).toEqual([429]);
  });

  it('stays silent for statuses the form cannot fix', async () => {
    respond(500);
    expect(await raisedBy(() => api.logs())).toEqual([]);
  });

  it('reports a throttle in words the operator can act on', async () => {
    respond(429);
    await expect(api.costs()).rejects.toThrow(/too many attempts/);
  });
});

describe('signIn', () => {
  it('sends the token as a Bearer header, never in the URL', async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await signIn('the-token');

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/session');
    expect(String(url)).not.toContain('the-token');
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer the-token');
  });

  // A wrong token belongs on the form. Raising the event here would swap the
  // form out from under the operator mid-typo.
  it('does not raise UNAUTHORIZED_EVENT when the token is refused', async () => {
    respond(401);
    expect(await raisedBy(() => signIn('wrong'))).toEqual([]);
  });

  it('surfaces a refused token as an ApiError the form can show', async () => {
    respond(401);
    await expect(signIn('wrong')).rejects.toThrow(ApiError);
    await expect(signIn('wrong')).rejects.toThrow(/not accepted/);
  });
});

describe('signOut', () => {
  it('swallows a network failure — the shell returns to the form regardless', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    await expect(signOut()).resolves.toBeUndefined();
  });
});
