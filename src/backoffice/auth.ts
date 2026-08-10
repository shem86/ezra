// Bearer-token auth for the read-only console. Defence-in-depth behind the
// tailnet (the network boundary is Tailscale; this is the app-level gate).
//
// The token arrives one of three ways: an `Authorization: Bearer <t>` header
// (used by curl / the api client), a `bo_session` cookie, or a one-time
// `?token=<t>` query on the SPA load (which the server then promotes to an
// httpOnly cookie so the browser carries it on subsequent same-origin calls).
// Comparison is constant-time. Repeated WRONG tokens from an address lock it
// out; a request carrying no credential is not an attempt and never counts.

import { createHash, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'bo_session';

/** Constant-time string compare — equal-length SHA-256 digests, never the raw
 *  strings (length itself would leak through timingSafeEqual's length check). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (header === undefined) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k.length > 0) out[k] = decodeURIComponent(v);
  }
  return out;
}

/** Pull a candidate token from header, cookie, or query (in that order). */
export function extractToken(input: {
  authorization?: string | undefined;
  cookie?: string | undefined;
  queryToken?: string | undefined;
}): { token: string; source: 'header' | 'cookie' | 'query' } | undefined {
  const auth = input.authorization;
  if (auth !== undefined && auth.startsWith('Bearer ')) {
    return { token: auth.slice('Bearer '.length).trim(), source: 'header' };
  }
  const cookieToken = parseCookies(input.cookie)[SESSION_COOKIE];
  if (cookieToken !== undefined && cookieToken.length > 0) {
    return { token: cookieToken, source: 'cookie' };
  }
  if (input.queryToken !== undefined && input.queryToken.length > 0) {
    return { token: input.queryToken, source: 'query' };
  }
  return undefined;
}

export interface RateLimitOptions {
  readonly maxFailures: number;
  readonly lockoutMs: number;
  /** Sliding window the failures must land INSIDE to trip a lockout.
   *  Defaults to lockoutMs. Without it failures sum for the process's whole
   *  lifetime, so unrelated rejects weeks apart add up to a lockout — that is
   *  what stranded the operator on 2026-08-10. */
  readonly windowMs?: number;
  /** Injectable clock for tests; defaults to Date.now. */
  readonly now?: () => number;
}

export interface RateLimiter {
  /** True when the address is currently locked out. */
  isLocked(addr: string): boolean;
  recordFailure(addr: string): void;
  reset(addr: string): void;
}

export function makeRateLimiter(options: RateLimitOptions): RateLimiter {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? options.lockoutMs;
  // Failure TIMESTAMPS, not a running count — the count is derived per call
  // from the ones still inside the window.
  const state = new Map<string, { failures: number[]; lockedUntil: number }>();
  return {
    isLocked(addr) {
      const s = state.get(addr);
      if (s === undefined) return false;
      if (s.lockedUntil > now()) return true;
      if (s.lockedUntil !== 0 && s.lockedUntil <= now()) state.delete(addr); // lock expired
      return false;
    },
    recordFailure(addr) {
      const t = now();
      const s = state.get(addr) ?? { failures: [], lockedUntil: 0 };
      // Drop failures that have aged out, then add this one.
      s.failures = s.failures.filter((ts) => ts > t - windowMs);
      s.failures.push(t);
      if (s.failures.length >= options.maxFailures) {
        s.lockedUntil = t + options.lockoutMs;
        s.failures = [];
      }
      state.set(addr, s);
      // Addresses that never lock would otherwise accumulate forever: an
      // unbounded Map keyed by a caller-influenced value. Drop spent entries.
      for (const [k, v] of state) {
        if (v.failures.length === 0 && v.lockedUntil <= t) state.delete(k);
      }
    },
    reset(addr) {
      state.delete(addr);
    },
  };
}
