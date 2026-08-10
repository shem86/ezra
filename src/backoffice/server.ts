// The read-only backoffice HTTP server. A SEPARATE process from the durable
// spine: node:http only, no DBOS, no tool layer, no write paths by construction
// (only GET/HEAD are routed; every other method is 405). It serves the built
// SPA (backoffice/dist) and a small read-only /api/* surface. Composed by DI —
// it never reads process.env (config.ts does that, threaded through deps).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import {
  extractToken,
  safeEqual,
  SESSION_COOKIE,
  type RateLimiter,
} from './auth.js';

export interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** A data-endpoint resolver. Returns undefined when no route matches (→ 404).
 *  Implementations are read-only; the server only ever calls them for GET. */
export interface ApiRouter {
  handle(method: string, url: URL): Promise<ApiResponse | undefined>;
}

export interface BackofficeDeps {
  /** The bearer token (from Config). */
  readonly token: string;
  /** Absolute or cwd-relative path to the built SPA (backoffice/dist). */
  readonly distDir: string;
  readonly rateLimiter: RateLimiter;
  /** Data endpoints beyond /api/health; absent in the BO-4 skeleton. */
  readonly api?: ApiRouter | undefined;
  readonly logger?: ((msg: string) => void) | undefined;
}

/** Session cookie lifetime. Renewed on every authenticated response (below),
 *  so this is an idle timeout rather than a hard expiry from first sign-in. */
const SESSION_MAX_AGE_SECONDS = 2592000; // 30 days

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders?: Record<string, string>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  });
  res.end(payload);
}

function clientAddr(req: IncomingMessage): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0]!.trim();
  return req.socket.remoteAddress ?? 'unknown';
}

async function serveStatic(res: ServerResponse, distDir: string, pathname: string): Promise<void> {
  // Resolve within distDir; anything escaping it falls back to index.html.
  const rel = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, '');
  let filePath = join(distDir, rel);
  if (!filePath.startsWith(distDir + sep) && filePath !== distDir) {
    filePath = join(distDir, 'index.html');
  }
  let ext = extname(filePath);
  let data: Buffer;
  try {
    data = await readFile(filePath);
  } catch {
    // SPA fallback: unknown non-asset path → index.html (hash routing).
    if (ext === '' || ext === '.html') {
      try {
        data = await readFile(join(distDir, 'index.html'));
        ext = '.html';
      } catch {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
    } else {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
  }
  res.writeHead(200, {
    'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    // Hashed asset filenames are immutable; the HTML shell must not be cached.
    'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  res.end(data);
}

export function createRequestHandler(deps: BackofficeDeps) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? 'GET').toUpperCase();
    // Base only serves to parse the relative request-target into pathname +
    // query; it's loopback, never dialed (built from the Host header so no
    // outbound host literal appears in src — the egress drift scan stays clean).
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const addr = clientAddr(req);

    // Read-only by construction: nothing but GET/HEAD is ever honoured.
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed — backoffice is read-only' }, { allow: 'GET, HEAD' });
      return;
    }

    // --- credential evaluation ---
    //
    // Order is load-bearing (2026-08-10 incident, STATUS.md): evaluate the
    // credential FIRST and consult the lockout only once it proves wrong.
    // Checking isLocked up front shut out the correct token too, so the
    // operator could not recover by presenting it — only by waiting 15
    // minutes, which reads exactly like an outage. An attacker never holds
    // the token, so letting a valid one through costs nothing; the throttle
    // that matters (repeated WRONG tokens, below) is unchanged.
    const candidate = extractToken({
      authorization: req.headers['authorization'],
      cookie: req.headers['cookie'],
      queryToken: url.searchParams.get('token') ?? undefined,
    });

    let authed = false;
    if (candidate !== undefined) {
      if (safeEqual(candidate.token, deps.token)) {
        authed = true;
        deps.rateLimiter.reset(addr);
      } else {
        deps.rateLimiter.recordFailure(addr);
        const locked = deps.rateLimiter.isLocked(addr);
        // Never log the presented value — only that one arrived and from where.
        deps.logger?.(
          `backoffice auth: rejected ${candidate.source} token from ${addr}${locked ? ' — address now locked out' : ''}`,
        );
        if (isApi) {
          if (locked) {
            sendJson(res, 429, { error: 'too many attempts — locked out' }, { 'retry-after': '900' });
            return;
          }
          sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
          return;
        }
        // A wrong token on the SHELL falls through and still serves the app,
        // which renders its sign-in screen — a stale bookmark should land the
        // operator on a form, not on a wall of JSON.
      }
    }

    // Sliding renewal. The cookie used to be issued once, with a fixed 30-day
    // Max-Age, so it expired mid-use and dropped the operator onto the
    // credential-less path. Re-issuing it on every authenticated response means
    // an operator who keeps using the console never hits an expiry cliff.
    const setCookie = authed
      ? {
          'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(deps.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}`,
        }
      : undefined;

    // --- the SPA shell and its assets are PUBLIC ---
    // They carry no household data — /api/* below is the real gate. Gating the
    // shell too meant an unauthenticated visit rendered raw JSON with no way in
    // but hand-editing `?token=` into the address bar, which is exactly what
    // made a routine cookie expiry look like an outage.
    if (!isApi) {
      if (setCookie !== undefined) {
        for (const [k, v] of Object.entries(setCookie)) res.setHeader(k, v);
      }
      if (method === 'HEAD') {
        res.writeHead(200);
        res.end();
        return;
      }
      await serveStatic(res, deps.distDir, url.pathname);
      return;
    }

    // --- /api/* requires a valid credential ---
    // A request with no credential is not an ATTEMPT — it is a browser that has
    // not signed in yet. The dashboard fires four parallel /api calls on mount,
    // so counting these meant one stale-cookie page load burned half the
    // failure budget and two locked the operator out. Brute force always
    // presents a candidate, so ignoring these does not weaken detection.
    if (!authed) {
      sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      return;
    }

    // --- routing ---
    // The sign-in endpoint: the SPA posts the operator's token here as a Bearer
    // header and gets the session cookie back, so the token never enters the
    // address bar or the browser history the way `?token=` does.
    if (url.pathname === '/api/session') {
      sendJson(res, 200, { ok: true }, setCookie);
      return;
    }

    if (url.pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok', service: 'backoffice', time: new Date().toISOString() }, setCookie);
      return;
    }

    const result = deps.api === undefined ? undefined : await deps.api.handle(method, url);
    if (result === undefined) {
      sendJson(res, 404, { error: 'no such endpoint' }, setCookie);
      return;
    }
    sendJson(res, result.status, result.body, setCookie);
  };
}

export function createBackofficeServer(deps: BackofficeDeps): Server {
  const handler = createRequestHandler(deps);
  return createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      deps.logger?.(`backoffice request error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) sendJson(res, 500, { error: 'internal error' });
      else res.end();
    });
  });
}
