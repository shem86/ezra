// Typed read-only API client. Same-origin fetch with `credentials: 'include'`
// so the httpOnly bo_session cookie rides along. GET-only — the console never
// mutates. A 401 surfaces as ApiError so the UI can prompt for the token.

import type { Catalogue, CostsResponse, LogsResponse, StatusResponse, TableListing } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** Fired when any API call comes back with an auth-class status. The app shell
 *  listens and swaps in the sign-in screen — a window event rather than an
 *  `onUnauthorized` callback threaded through every screen and card. `detail`
 *  carries the status so the form can explain a throttle differently from an
 *  expired session. */
export const UNAUTHORIZED_EVENT = 'bo:unauthorized';

export interface UnauthorizedDetail {
  readonly status: number;
}

/** 401 (not signed in) and 429 (throttled) both mean "no data until the
 *  credential situation is resolved", and the sign-in form is the only screen
 *  that can resolve either. 429 used to be excluded, which left a throttled
 *  browser showing five identical error cards with no route to the form. */
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 429;
}

function describe(status: number): string {
  if (status === 401) return 'unauthorized';
  if (status === 429) return 'too many attempts — wait a few minutes';
  return `HTTP ${status}`;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    if (isAuthStatus(res.status)) {
      window.dispatchEvent(
        new CustomEvent<UnauthorizedDetail>(UNAUTHORIZED_EVENT, { detail: { status: res.status } }),
      );
    }
    throw new ApiError(res.status, describe(res.status));
  }
  return (await res.json()) as T;
}

/** Exchange the operator's token for the httpOnly session cookie. Sent as a
 *  Bearer header, so the token never lands in the address bar or in browser
 *  history the way the older `?token=` URL did. Deliberately does NOT raise
 *  UNAUTHORIZED_EVENT — a wrong token here belongs on the form, not in a
 *  sign-out loop. */
export async function signIn(token: string): Promise<void> {
  const res = await fetch('/api/session', {
    credentials: 'include',
    headers: { accept: 'application/json', authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.status === 401 ? 'that token was not accepted' : describe(res.status));
  }
}

/** Drop the session cookie server-side. Best-effort: if the call fails the shell
 *  still returns to the form, and the cookie is refused (and then cleared) on
 *  the next request anyway. */
export async function signOut(): Promise<void> {
  try {
    await fetch('/api/signout', { credentials: 'include', headers: { accept: 'application/json' } });
  } catch {
    // Network failure on the way out is not worth surfacing.
  }
}

export interface ApiClient {
  catalogue(signal?: AbortSignal): Promise<Catalogue>;
  table(table: string, limit?: number, signal?: AbortSignal): Promise<TableListing>;
  costs(signal?: AbortSignal): Promise<CostsResponse>;
  logs(limit?: number, signal?: AbortSignal): Promise<LogsResponse>;
  status(signal?: AbortSignal): Promise<StatusResponse>;
}

export const api: ApiClient = {
  catalogue: (signal) => getJson<Catalogue>('/api/db', signal),
  table: (table, limit, signal) =>
    getJson<TableListing>(`/api/db/${encodeURIComponent(table)}${limit ? `?limit=${limit}` : ''}`, signal),
  costs: (signal) => getJson<CostsResponse>('/api/costs', signal),
  logs: (limit, signal) => getJson<LogsResponse>(`/api/logs${limit ? `?limit=${limit}` : ''}`, signal),
  status: (signal) => getJson<StatusResponse>('/api/status', signal),
};
