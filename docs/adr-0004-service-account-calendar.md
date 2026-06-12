# ADR-0004: calendar auth via service account, per-requester personal calendars

**Date:** 2026-06-12 · **Status:** Accepted · **Scope:** T39–T41 (M5.5), the
`deps.calendar` client, egress allowlist entry for Google

## Context

The architecture and PLAN name "OAuth consent + scopes, refresh-token storage
as secret-class" for the calendar integration, but never confronted what
Google's OAuth rules mean for an **unattended server agent** on personal
(non-Workspace) Google accounts. Checked against current Google docs at T39
entry:

- An external OAuth app in **"Testing" publishing status issues refresh
  tokens that expire every 7 days**. An unattended agent would need a human
  re-consent weekly — disqualifying on its own.
- The only escape is publishing the consent screen "In production"
  **unverified**: Google documents this as "strongly discouraged", shows an
  "unverified app" warning at consent, and calendar scopes are *sensitive*,
  so the verification question never fully goes away. It works, but it is
  the fragile corner of the platform, and a revoked refresh token silently
  kills the calendar tools until someone re-runs a consent flow.
- A **service account** has none of these failure modes: a robot identity
  inside the GCP project (NOT a Google account — no inbox, no password,
  nothing to sign into), authenticated by signing a JWT with its key
  (`node:crypto` RS256 — still zero-dep, the ADR-0002 fetch-client pattern),
  no consent screen, no refresh token, no expiry rules, no publishing
  status. Calendar access is granted by **sharing a calendar with the
  service account's email** — the same one-click sharing used for a person.

Separately, the household decided the agent writes to **each spouse's
existing personal calendar, routed by requester** — not a new shared
calendar. This fits the service-account model directly: each spouse shares
their own calendar once; nothing new is created.

## Decision

**Authenticate the calendar client with a service account; integrate both
spouses' existing personal calendars, target chosen per request.**

- One GCP project (no billing — the Calendar API is free at this scale),
  Calendar API enabled, one service account, ONE key. The key is
  secret-class: it lives in `.env` via `src/ops/config.ts` like every other
  operational credential, is never committed, and never enters prompts,
  traces, or the semantic store (tools receive an authenticated client via
  `deps`, never the key — SPEC "Truth vs continuity").
- Each spouse shares their personal calendar with the service-account email,
  permission **"Make changes to events"**. No new Google account, no new
  calendar, no consent screen, no OAuth client.
- The calendar tool takes an `owner` argument the model fills from sender
  attribution (the T27 contract already proven for `addedBy`/`createdBy` by
  the T38 eval); config carries the sender→calendarId map (dev member ids
  now, real JIDs at T42 — same mapping moment as ledger #12). Explicit
  override ("put it on my wife's calendar") is just the model passing the
  other owner. `isFree` revalidation runs against the calendar being
  written.
- Token flow: sign `{iss: <sa-email>, scope: calendar scope, aud: token
  endpoint, iat, exp}` with the key (RS256) → POST
  `oauth2.googleapis.com/token` → access token (~1h), cached and refreshed
  on demand inside the client. Egress: `oauth2.googleapis.com` +
  `www.googleapis.com` (already inside the allowlist's "Google" entry).

## Consequences

- Events show the service account as organizer — cosmetic; both spouses
  already see the calendars natively.
- The service account **cannot invite attendees** (that needs Workspace
  domain-wide delegation). Acceptable: household events don't send invites;
  the calendars are mutually visible already.
- Sharing "Make changes to events" means a compromised box can read/write
  both personal calendars. Consistent with the existing threat model (the
  box already holds a live message-anyone-as-you WhatsApp session); it is
  exactly what the egress allowlist and secret-class handling exist to
  contain.
- Key rotation is manual (create new key, swap `.env`, delete old) — note
  for the ops runbook (T44).
- Everywhere architecture/SPEC say "calendar OAuth refresh tokens"
  (secret-class storage, egress rationale, backup encryption), read "the
  service-account key" — same class, same handling.
- **Named fallback:** if Google ever restricts service-account keys for
  personal projects, the original OAuth path (desktop client + loopback
  consent CLI + unverified-production publish) is the contingency; the
  `deps.calendar` seam doesn't change shape either way.
