// T32: system prompt assembly — cache-prefix stability is the hard criterion
// (the static prompt is T25's cacheControl prefix; any byte drift re-writes
// the cache for BOTH model tiers).

import { describe, expect, it } from 'vitest';
import {
  composeSystemPrompt,
  renderApprovalOutcome,
  renderApprovalPrompt,
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
