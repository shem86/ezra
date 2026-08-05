// The WhatsApp Web client version, and the policy around keeping it alive.
//
// Two versions are easy to conflate and only one of them is ours to choose:
// the Baileys *npm package* (pinned in package.json, ours forever) and the
// WhatsApp Web *protocol version* announced during the handshake, which
// WhatsApp enforces server-side and retires on its own schedule. This module
// owns the second one.
//
// ADR-0006 (2026-07-28 outage). Baileys resolves that protocol version from a
// JSON file in its GitHub repo at connect time. That host was never on the
// egress allowlist, so once the host firewall stopped failing open the probe
// timed out — and `fetchLatestBaileysVersion()` RESOLVES with an error field
// rather than throwing, so the failure was invisible and the version silently
// froze at the bundled fallback. Four months later WhatsApp started answering
// it with 405 and the socket went deaf for 5.7 days.
//
// The policy that replaces it: the pin is authoritative and lives in git
// (deterministic, reviewable, what we run every ordinary day), upstream is
// consulted out of band to report staleness, and a *rejection* — the only
// unambiguous signal that the pin is dead — falls forward automatically so a
// deprecation self-heals instead of waiting for a human to be at a keyboard.
//
// Deliberately free of any baileys import (same rationale as protocol.ts): it
// stays unit-testable without loading the socket stack. The concrete probe is
// injected — see fetchUpstreamWaVersion in baileys.ts.

export type WaVersion = readonly [number, number, number];

const VERSION_RE = /^\d+\.\d+\.\d+$/;

/** `"2.3000.1043857760"` → `[2, 3000, 1043857760]`; null when malformed. */
export function parseWaVersion(raw: string): WaVersion | null {
  if (!VERSION_RE.test(raw.trim())) return null;
  const parts = raw
    .trim()
    .split('.')
    .map((p) => Number.parseInt(p, 10));
  if (parts.length !== 3 || parts.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  return [parts[0]!, parts[1]!, parts[2]!];
}

export function formatWaVersion(version: WaVersion): string {
  return version.join('.');
}

export function sameWaVersion(a: WaVersion, b: WaVersion): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** The shape `fetchLatestBaileysVersion()` resolves with. */
export interface BaileysVersionProbeResult {
  version?: unknown;
  isLatest?: boolean;
  error?: unknown;
}

function asWaVersion(value: unknown): WaVersion | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  if (!value.every((n) => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0)) return null;
  return [value[0] as number, value[1] as number, value[2] as number];
}

/**
 * Turn a Baileys probe result into a version, or null if the probe did not
 * genuinely reach upstream.
 *
 * The `error`/`isLatest` checks are the whole point: on failure the probe
 * hands back the *bundled fallback* with `isLatest: false`, which is
 * indistinguishable from a real answer unless those fields are read. Treating
 * a failed probe as an answer is what froze the version in the first place.
 */
export function interpretProbeResult(result: BaileysVersionProbeResult): WaVersion | null {
  if (result.error !== undefined && result.error !== null) return null;
  if (result.isLatest !== true) return null;
  return asWaVersion(result.version);
}

/** What the version source has to say; the composing caller decides where it goes. */
export type WaVersionEvent =
  /** Upstream could not be reached — never silent, this is the original bug. */
  | { kind: 'probe-failed' }
  /** Pin matches upstream; nothing to do. */
  | { kind: 'current'; version: WaVersion }
  /** Upstream has moved on. Advisory: the pin is NOT swapped. */
  | { kind: 'stale'; pinned: WaVersion; upstream: WaVersion }
  /** A rejection forced a fall-forward; the pin in git needs updating. */
  | { kind: 'adopted'; from: WaVersion; to: WaVersion }
  /** Rejected, but upstream offers nothing newer — a human has to look. */
  | { kind: 'no-upgrade'; version: WaVersion };

export interface WaVersionSourceDeps {
  /** The reviewed pin from config — what we run unless forced off it. */
  pinned: WaVersion;
  /** Resolves the current upstream version, or null if unreachable/unusable. */
  fetchUpstream: () => Promise<WaVersion | null>;
  onEvent?: (event: WaVersionEvent) => void;
}

export interface WaVersionSource {
  /** The version the next socket should announce. */
  current(): WaVersion;
  /** Out-of-band staleness check. Reports; never swaps. */
  checkUpstream(): Promise<void>;
  /**
   * WhatsApp rejected `current()`. Adopt upstream if it differs.
   * Returns true when a genuinely different version was adopted — the caller
   * uses that to decide between reconnecting now and serving out its backoff.
   */
  fallForward(): Promise<boolean>;
}

export function createWaVersionSource(deps: WaVersionSourceDeps): WaVersionSource {
  let active: WaVersion = deps.pinned;

  // Observability must never take the transport down with it (mirrors the
  // adapter's own report()).
  function emit(event: WaVersionEvent): void {
    try {
      deps.onEvent?.(event);
    } catch {
      // A broken observer is not a transport failure.
    }
  }

  async function probe(): Promise<WaVersion | null> {
    try {
      return await deps.fetchUpstream();
    } catch {
      return null;
    }
  }

  return {
    current: () => active,

    async checkUpstream(): Promise<void> {
      const upstream = await probe();
      if (!upstream) {
        emit({ kind: 'probe-failed' });
        return;
      }
      if (sameWaVersion(upstream, active)) {
        emit({ kind: 'current', version: active });
        return;
      }
      emit({ kind: 'stale', pinned: active, upstream });
    },

    async fallForward(): Promise<boolean> {
      const upstream = await probe();
      if (!upstream) {
        emit({ kind: 'probe-failed' });
        return false;
      }
      // Compared against the ACTIVE version, not the original pin: after one
      // fall-forward the pin is no longer what WhatsApp just rejected.
      if (sameWaVersion(upstream, active)) {
        emit({ kind: 'no-upgrade', version: active });
        return false;
      }
      const from = active;
      active = upstream;
      emit({ kind: 'adopted', from, to: upstream });
      return true;
    },
  };
}
