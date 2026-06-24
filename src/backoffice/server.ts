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
    const url = new URL(req.url ?? '/', 'http://localhost');
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/');
    const addr = clientAddr(req);

    // Read-only by construction: nothing but GET/HEAD is ever honoured.
    if (method !== 'GET' && method !== 'HEAD') {
      sendJson(res, 405, { error: 'method not allowed — backoffice is read-only' }, { allow: 'GET, HEAD' });
      return;
    }

    if (deps.rateLimiter.isLocked(addr)) {
      sendJson(res, 429, { error: 'too many attempts — locked out' }, { 'retry-after': '900' });
      return;
    }

    // --- auth gate ---
    const candidate = extractToken({
      authorization: req.headers['authorization'],
      cookie: req.headers['cookie'],
      queryToken: url.searchParams.get('token') ?? undefined,
    });
    const ok = candidate !== undefined && safeEqual(candidate.token, deps.token);
    if (!ok) {
      deps.rateLimiter.recordFailure(addr);
      sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      return;
    }
    deps.rateLimiter.reset(addr);

    // Promote a one-time ?token= load into an httpOnly session cookie so the
    // browser carries it on subsequent same-origin /api calls.
    const setCookie =
      candidate.source === 'query'
        ? { 'set-cookie': `${SESSION_COOKIE}=${encodeURIComponent(deps.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000` }
        : undefined;

    // --- routing ---
    if (url.pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok', service: 'backoffice', time: new Date().toISOString() }, setCookie);
      return;
    }

    if (isApi) {
      const result = deps.api === undefined ? undefined : await deps.api.handle(method, url);
      if (result === undefined) {
        sendJson(res, 404, { error: 'no such endpoint' }, setCookie);
        return;
      }
      sendJson(res, result.status, result.body, setCookie);
      return;
    }

    // static SPA
    if (setCookie !== undefined) {
      for (const [k, v] of Object.entries(setCookie)) res.setHeader(k, v);
    }
    if (method === 'HEAD') {
      res.writeHead(200);
      res.end();
      return;
    }
    await serveStatic(res, deps.distDir, url.pathname);
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
