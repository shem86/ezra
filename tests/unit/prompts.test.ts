// T32: system prompt assembly — cache-prefix stability is the hard criterion
// (the static prompt is T25's cacheControl prefix; any byte drift re-writes
// the cache for BOTH model tiers).

import { describe, expect, it } from 'vitest';
import {
  composeSystemPrompt,
  makeProductionSystemPrompt,
  renderApprovalOutcome,
  renderApprovalPrompt,
  renderExpiryNotice,
  renderPendingActionsDigest,
  stableSystemPrompt,
  type PendingActionDigestEntry,
} from '../../src/agent/prompts.js';

const entry = (overrides: Partial<PendingActionDigestEntry> = {}): PendingActionDigestEntry => ({
  actionId: 'act-conv-1-tu_9',
  toolName: 'create_event',
  summary: 'dentist Tuesday 15:00',
  ...overrides,
});

describe('stableSystemPrompt', () => {
  it('states the load-bearing conventions: sender prefix, language matching, Eastern time, tools-as-truth', () => {
    expect(stableSystemPrompt).toMatch(/sender/i);
    expect(stableSystemPrompt).toMatch(/Hebrew/);
    expect(stableSystemPrompt).toMatch(/Eastern/);
    expect(stableSystemPrompt).toMatch(/recall_history/);
    expect(stableSystemPrompt).toMatch(/system:compaction/);
  });

  it('is a constant — byte-identical across reads (the cache prefix)', () => {
    expect(stableSystemPrompt).toBe(stableSystemPrompt);
    expect(stableSystemPrompt.length).toBeGreaterThan(200);
  });
});

describe('composeSystemPrompt', () => {
  it('with no digest, the composed prompt IS the stable prefix — no trailing slot residue', () => {
    expect(composeSystemPrompt(null)).toBe(stableSystemPrompt);
  });

  it('the stable prefix bytes are identical across digest variations', () => {
    const withNone = composeSystemPrompt(null);
    const withOne = composeSystemPrompt(renderPendingActionsDigest([entry()]));
    const withTwo = composeSystemPrompt(
      renderPendingActionsDigest([entry(), entry({ actionId: 'act-conv-1-tu_10', summary: 'תור לרופא' })]),
    );

    for (const composed of [withOne, withTwo]) {
      expect(composed.startsWith(withNone)).toBe(true);
    }
    expect(withOne).not.toBe(withNone);
  });

  it('the digest lands strictly after the prefix', () => {
    const digest = renderPendingActionsDigest([entry()]);
    const composed = composeSystemPrompt(digest);
    expect(composed.indexOf('act-conv-1-tu_9')).toBeGreaterThan(stableSystemPrompt.length - 1);
  });
});

describe('renderApprovalPrompt', () => {
  it('identifies the action and tells the user to quote-reply', () => {
    const prompt = renderApprovalPrompt({
      actionId: 'act-conv-1-tu_9',
      toolName: 'create_event',
      summary: '{"title":"dentist"}',
    });

    expect(prompt).toContain('act-conv-1-tu_9');
    expect(prompt).toContain('create_event');
    expect(prompt).toContain('dentist');
    expect(prompt).toMatch(/reply to this message/i);
  });

  it('is deterministic — same inputs, same bytes (workflow replay renders it)', () => {
    const entry = { actionId: 'act-1', toolName: 'create_event', summary: '{}' };
    expect(renderApprovalPrompt(entry)).toBe(renderApprovalPrompt(entry));
  });
});

describe('renderPendingActionsDigest', () => {
  it('returns null for no pending actions (slot omitted entirely)', () => {
    expect(renderPendingActionsDigest([])).toBeNull();
  });

  it('renders one line per action with actionId, tool name, and summary', () => {
    const digest = renderPendingActionsDigest([
      entry(),
      entry({ actionId: 'act-conv-1-tu_10', toolName: 'create_event', summary: 'תור לרופא שיניים' }),
    ]);

    expect(digest).toContain('act-conv-1-tu_9');
    expect(digest).toContain('create_event');
    expect(digest).toContain('dentist Tuesday 15:00');
    expect(digest).toContain('תור לרופא שיניים');
  });

  it('renders expiry as Eastern wall time, never server time', () => {
    // 2026-06-15T16:00:00Z is 12:00 EDT.
    const digest = renderPendingActionsDigest([
      entry({ expiresAt: new Date('2026-06-15T16:00:00.000Z') }),
    ]);
    expect(digest).toContain('12:00');
  });
});

describe('renderApprovalOutcome (T35)', () => {
  it('executed: names the action, the tool, the approver, and the real result', () => {
    const text = renderApprovalOutcome(
      { kind: 'executed', actionId: 'act-1', toolName: 'create_event', result: 'event created' },
      'wife',
    );
    expect(text).toContain('act-1');
    expect(text).toContain('create_event');
    expect(text).toContain('approved by wife');
    expect(text).toContain('event created');
  });

  it('denied: says who declined and that nothing ran', () => {
    const text = renderApprovalOutcome(
      { kind: 'denied', actionId: 'act-1', toolName: 'create_event' },
      'wife',
    );
    expect(text).toContain('declined by wife');
    expect(text).toContain('act-1');
  });

  it('stale: reports the failed revalidation and that nothing executed', () => {
    const text = renderApprovalOutcome(
      { kind: 'stale', actionId: 'act-1', toolName: 'create_event' },
      'wife',
    );
    expect(text).toMatch(/no longer valid|revalidation/i);
    expect(text).toMatch(/not executed/i);
  });

  it('failed: reports the transient failure and that the action is still pending (T40)', () => {
    const text = renderApprovalOutcome(
      {
        kind: 'failed',
        actionId: 'act-1',
        toolName: 'create_calendar_event',
        message: 'calendar create: HTTP 503',
      },
      'wife',
    );
    expect(text).toContain('act-1');
    expect(text).toContain('503');
    expect(text).toMatch(/still pending/i);
    expect(text).toMatch(/approv/i); // tells the household a re-approval retries
  });

  it('already-resolved: reports the settled status without pretending anything changed', () => {
    const text = renderApprovalOutcome(
      { kind: 'already-resolved', actionId: 'act-1', status: 'executed' },
      'wife',
    );
    expect(text).toContain('act-1');
    expect(text).toContain('executed');
  });

  it('unbound and unclear produce no context message — the normal turn handles them', () => {
    expect(renderApprovalOutcome({ kind: 'unbound' }, 'wife')).toBeNull();
    expect(renderApprovalOutcome({ kind: 'unclear', actionId: 'act-1' }, 'wife')).toBeNull();
  });

  it('is deterministic — same outcome, same bytes (rendered during workflow replay)', () => {
    const outcome = {
      kind: 'executed',
      actionId: 'act-1',
      toolName: 'create_event',
      result: 'done',
    } as const;
    expect(renderApprovalOutcome(outcome, 'wife')).toBe(renderApprovalOutcome(outcome, 'wife'));
  });
});

describe('stableSystemPrompt approval guidance (T36)', () => {
  it('teaches the multi-pending rule: never pick an action yourself, ask for a quoted reply', () => {
    expect(stableSystemPrompt).toMatch(/more than one/i);
    expect(stableSystemPrompt).toMatch(/quot/i);
  });
});

describe('renderExpiryNotice (T37)', () => {
  it('names the action, says nothing was executed, and invites a re-ask — gently', () => {
    const text = renderExpiryNotice(entry({ actionId: 'act-9', toolName: 'propose_event' }));
    expect(text).toContain('[action update]');
    expect(text).toContain('act-9');
    expect(text).toContain('propose_event');
    expect(text).toContain('dentist Tuesday 15:00');
    expect(text).toMatch(/expired/);
    expect(text).toMatch(/nothing was executed/i);
    expect(text).toMatch(/ask/i);
  });

  it('is deterministic — the sweep enqueues it and replay must regenerate identical bytes', () => {
    expect(renderExpiryNotice(entry())).toBe(renderExpiryNotice(entry()));
  });
});

describe('makeProductionSystemPrompt (T42)', () => {
  const memberJids = {
    husband: ['15550001111@s.whatsapp.net', '111222333@lid'],
    wife: ['15550002222@s.whatsapp.net'],
  };
  const prompt = makeProductionSystemPrompt({ memberJids });

  it('names the persona, in both scripts (SPEC Q4: Golem)', () => {
    expect(prompt).toContain('Golem');
    expect(prompt).toContain('גולם');
  });

  it('maps every configured JID to its member', () => {
    expect(prompt).toContain('15550001111@s.whatsapp.net');
    expect(prompt).toContain('111222333@lid');
    expect(prompt).toContain('15550002222@s.whatsapp.net');
    expect(prompt).toMatch(/husband/);
    expect(prompt).toMatch(/wife/);
  });

  it('instructs attribution by member label, never the raw id (ledger #12)', () => {
    expect(prompt).toMatch(/addedBy\/createdBy/);
    expect(prompt).toMatch(/member label/i);
    expect(prompt).toMatch(/never the raw id/i);
  });

  it('is honest about one-time-only reminders (ledger #4 cut)', () => {
    expect(prompt).toMatch(/repeat/i);
    expect(prompt).toMatch(/one-time/i);
    expect(prompt).toMatch(/honest/i);
  });

  it('keeps the shared household invariants — language, Eastern time, tools-are-truth', () => {
    expect(prompt).toContain('Hebrew and English');
    expect(prompt).toContain('Eastern wall time');
    expect(prompt).toContain('never answer from memory');
    expect(prompt).toMatch(/more than one/i); // T36 multi-pending rule rides along
  });

  it('is deterministic — same config, same bytes (this is a cache prefix)', () => {
    expect(makeProductionSystemPrompt({ memberJids })).toBe(prompt);
  });

  it('leaves stableSystemPrompt as the dev prefix, byte-stable', () => {
    expect(stableSystemPrompt.startsWith('You are the household assistant')).toBe(true);
    expect(stableSystemPrompt).toContain('like "wife@wa: the message"');
  });
});
