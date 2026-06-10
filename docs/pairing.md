# WhatsApp pairing (T11)

The transport links to WhatsApp as a **Linked Device** on the builder's
personal number (decision recorded 2026-06-09; a dedicated number may replace
it later). Pairing is the only manual step; everything after survives process
restarts.

## Pair

```
pnpm pair
```

1. A QR appears in the terminal.
2. On the phone that owns the number: **WhatsApp → Settings → Linked Devices →
   Link a Device**, scan the QR.
3. WhatsApp forces a restart right after pairing (close code 515) — the
   adapter reconnects automatically; wait for `state: open` and
   `✅ Connected`.

Session state lands in `WA_SESSION_DIR` (default `.wa-session/`).

## Verify reconnect-without-re-pair (acceptance check)

Run `pnpm pair` again. It must reach `✅ Connected` **without showing a QR**.
That proves the persisted session survives a process restart.

## Session-state rules (architecture decisions 1 & 8 — not optional)

The session dir holds pairing credentials **plus Signal ratchet keys**: a live
"message anyone as you" credential, more sensitive than any API key.

- It is gitignored; never commit it, never copy it into chats/issues/traces.
- **Never include it in backups, and never restore it from one.** The ratchet
  only moves forward; restoring a stale snapshot desyncs encryption and looks
  exactly like the anomalous-client behavior that triggers bans.
- Recovery from loss, corruption, or a 401 logged-out close is always a fresh
  pairing: `pnpm pair --reset` (wipes the dir, then shows a new QR).
- On the prod host (T16) the dir is the writable volume exception on a
  read-only rootfs, mode 0700.

## Troubleshooting

| Symptom | Meaning | Action |
|---|---|---|
| `state: logged-out` | WhatsApp revoked the pairing (401) | `pnpm pair --reset` |
| "session … is corrupt" on startup | torn `creds.json` (crash mid-write) | `pnpm pair --reset` |
| QR appears on a re-run | session dir missing/cleared | re-pair; check `WA_SESSION_DIR` |
| repeated reconnect cycling | WhatsApp Web instability (408 storms) | adapter backs off ~12 attempts; if it gives up, check phone connectivity, then rerun |

## Notes for later milestones

- The bot runs on the builder's own number, so the bot's sends arrive back as
  `fromMe` events — indistinguishable by flag from the builder's typed
  messages. The adapter suppresses echoes by tracking the ids it sent
  (`RecentIds`); T20's ingest must keep relying on that, not on `fromMe`.
- T13 adds the standalone runner (manual test send with human-like jitter,
  forced reconnect command); T12 hangs health/alerting off
  `onStateChange`.
