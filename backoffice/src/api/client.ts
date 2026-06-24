// Typed read-only API client. Same-origin fetch with `credentials: 'include'`
// so the httpOnly bo_session cookie rides along. GET-only — the console never
// mutates. A 401 surfaces as ApiError so the UI can prompt for the token.

import type { Catalogue, CostsResponse, TableListing } from './types';

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { accept: 'application/json' },
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) {
    throw new ApiError(res.status, res.status === 401 ? 'unauthorized' : `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export interface ApiClient {
  catalogue(signal?: AbortSignal): Promise<Catalogue>;
  table(table: string, limit?: number, signal?: AbortSignal): Promise<TableListing>;
  costs(signal?: AbortSignal): Promise<CostsResponse>;
}

export const api: ApiClient = {
  catalogue: (signal) => getJson<Catalogue>('/api/db', signal),
  table: (table, limit, signal) =>
    getJson<TableListing>(`/api/db/${encodeURIComponent(table)}${limit ? `?limit=${limit}` : ''}`, signal),
  costs: (signal) => getJson<CostsResponse>('/api/costs', signal),
};
