import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  egressAllowlist,
  egressCategories,
  isHostAllowed,
  type EgressCategory,
} from '../../src/ops/egress-allowlist.ts';

// T16: the allowlist is the single source of truth for "what hosts may Ezra
// dial." The nftables/proxy artifact in infra/ is generated FROM it, so these
// tests are what keep the host-firewall rules honest. Two complementary
// guarantees: (1) the matcher behaves at the dot boundary, and (2) the list
// covers every external host the code can actually reach — found by scanning
// src for literals AND by asserting each external-service category is present
// (the package-internal hosts — Anthropic SDK, Baileys, config-driven URLs —
// never appear as src literals, so the scan alone would miss them).

describe('isHostAllowed (T16 egress matcher)', () => {
  it('allows an exact host on the list', () => {
    expect(isHostAllowed('api.anthropic.com')).toBe(true);
  });

  it('allows a subdomain of a wildcard (subdomains) entry', () => {
    expect(isHostAllowed('mmg.whatsapp.net')).toBe(true);
  });

  it('allows the apex of a subdomains entry', () => {
    expect(isHostAllowed('whatsapp.net')).toBe(true);
  });

  it('rejects a host not on the list', () => {
    expect(isHostAllowed('evil.example.com')).toBe(false);
  });

  it('rejects a lookalike that only suffix-collides without a dot boundary', () => {
    // 'notwhatsapp.net' must NOT match a 'whatsapp.net' subdomains entry.
    expect(isHostAllowed('notwhatsapp.net')).toBe(false);
  });

  it('is case-insensitive on the host', () => {
    expect(isHostAllowed('API.Anthropic.COM')).toBe(true);
  });
});

describe('egress allowlist contents (T16)', () => {
  const required: EgressCategory[] = [
    'model',
    'embeddings',
    'calendar',
    'tracing',
    'alerts',
    'deadman',
    'whatsapp',
    'backup',
  ];

  it('declares every required external-service category', () => {
    for (const category of required) {
      expect(
        egressAllowlist.some((d) => d.category === category),
        `missing egress category: ${category}`,
      ).toBe(true);
    }
  });

  it('exposes the category union it actually uses', () => {
    for (const d of egressAllowlist) {
      expect(egressCategories).toContain(d.category);
    }
  });

  it('gives every destination a non-empty reason (rules are self-documenting)', () => {
    for (const d of egressAllowlist) {
      expect(d.reason.trim().length, `empty reason for ${d.host}`).toBeGreaterThan(0);
    }
  });

  it('routes backups to S3 (provider decided at T17)', () => {
    // The backup slot was reserved generically at T16; T17 locked it to AWS S3
    // (same account/region as the EC2 host). A bucket virtual-host URL resolves.
    expect(isHostAllowed('hh-assistant-backups-001467466089.s3.us-east-1.amazonaws.com')).toBe(
      true,
    );
    expect(egressAllowlist.some((d) => d.category === 'backup' && d.host.includes('s3'))).toBe(
      true,
    );
  });

  it('covers the known external hosts the v1 surface dials', () => {
    // Spot-check the load-bearing ones by name so a careless edit can't drop a
    // whole service and still pass the category check with a placeholder.
    for (const host of [
      'api.anthropic.com',
      'api.voyageai.com',
      'oauth2.googleapis.com',
      'www.googleapis.com',
      'api.telegram.org',
      'cloud.langfuse.com',
    ]) {
      expect(isHostAllowed(host), `not allowed: ${host}`).toBe(true);
    }
  });

  it('allows the WhatsApp media CDN under *.fbcdn.net (2026-06-17 incident)', () => {
    // WhatsApp serves media from Meta's fbcdn.net CDN, NOT whatsapp.net. The
    // 17:42 EDT "service down" alert traced to the host firewall dropping
    // Baileys' connection to whatsapp-cdn-shv-01-iad3.fbcdn.net (31.13.66.56)
    // because fbcdn.net was absent here — a runtime-resolved host the src
    // literal scan below can never see, so this name-check is the only guard.
    expect(isHostAllowed('whatsapp-cdn-shv-01-iad3.fbcdn.net')).toBe(true);
  });
});

describe('allowlist covers every outbound host literal in src (anti-drift)', () => {
  // A new dependency that dials a fresh host shows up here as a red test until
  // the host is justified in the allowlist — the whole point of T16.
  const here = dirname(fileURLToPath(import.meta.url));
  const srcDir = join(here, '..', '..', 'src');

  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walk(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('every https host literal under src/ is allowed', () => {
    const hostRe = /https?:\/\/([a-z0-9.-]+)/gi;
    const offenders: string[] = [];
    for (const file of walk(srcDir)) {
      // The allowlist module itself necessarily names hosts; skip it.
      if (file.endsWith('egress-allowlist.ts')) continue;
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(hostRe)) {
        const host = match[1]!.toLowerCase();
        if (!isHostAllowed(host)) offenders.push(`${host} (${file})`);
      }
    }
    expect(offenders, `unlisted outbound hosts:\n${offenders.join('\n')}`).toEqual([]);
  });
});
