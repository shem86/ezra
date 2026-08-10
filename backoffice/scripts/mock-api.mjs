// mock-api — serve the fixtures over real HTTP on :8787 so the console can be
// browsed in a normal browser with no prod host, no database, and no household
// data. Vite's dev server already proxies /api there (see vite.config.ts), so
// `pnpm dev:mock` is the whole local story: this server + vite, one command.
//
// Deliberately dependency-free (node:http) — this is a dev convenience in an
// isolated sub-package, not a reason to add a framework. Read-only, GET-only,
// bound to loopback: it mirrors the real console's posture rather than being
// laxer than the thing it stands in for.
//
// Usage:
//   node scripts/mock-api.mjs           # API only, on :8787
//   node scripts/mock-api.mjs --vite    # API + `vite`, shut down together
//
// Env: MOCK_API_PORT (default 8787)

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { resolveFixture } from './fixtures.mjs';

const PORT = parseInt(process.env.MOCK_API_PORT ?? '8787', 10);
const WITH_VITE = process.argv.includes('--vite');

const server = createServer((req, res) => {
  const { pathname } = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  if (req.method !== 'GET') {
    res.writeHead(405, { 'content-type': 'application/json' }).end('{"error":"read-only"}');
    return;
  }

  // Auth is server behaviour, not fixture data. There is no secret here to
  // protect — the payload is invented — so the session endpoints accept
  // anything, which keeps the sign-in shell exercisable locally instead of
  // dead-ending on a 404. Never let this file grow into a real auth path.
  if (pathname === '/api/session' || pathname === '/api/signout') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
    return;
  }

  const body = resolveFixture(pathname);
  if (body === null) {
    res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    return;
  }

  // no-store so a reload always re-fetches — otherwise editing a fixture and
  // refreshing shows the old numbers and looks like a bug in the screen.
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-api: fixtures on http://127.0.0.1:${PORT}/api/*  (costs, status, logs, db)`);
  if (!WITH_VITE) console.log('mock-api: start the UI with `pnpm dev` in another shell → http://localhost:5173');
});

server.on('error', (err) => {
  const hint = err.code === 'EADDRINUSE' ? ` — something already listens on :${PORT} (the real backoffice server?)` : '';
  console.error(`mock-api: ${err.message}${hint}`);
  process.exit(1);
});

if (WITH_VITE) {
  const vite = spawn('vite', [], { stdio: 'inherit', shell: true });
  // Both directions: closing vite (ctrl-C, crash) must not leave the API bound,
  // and killing this process must not orphan vite.
  vite.on('exit', (code) => {
    server.close();
    process.exit(code ?? 0);
  });
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      vite.kill(sig);
      server.close();
    });
  }
}
