// T35: a bound quoted reply is interpreted deterministically — no model in
// this path. Anything not clearly yes/no is 'unclear' and degrades to a
// normal turn with the action untouched (never silently auto-deny; T36's
// classifier is the conversational fallback).
import { describe, expect, it } from 'vitest';
import { interpretApprovalReply } from '../../src/hitl/approval-binding.ts';

describe('interpretApprovalReply (T35)', () => {
  it.each(['yes', 'Yes', 'y', 'ok', 'OK', 'okay', 'sure', 'approve', 'approved', 'confirm', 'do it', 'go ahead', 'yes please', '👍'])(
    'approves English %j',
    (text) => {
      expect(interpretApprovalReply(text)).toBe('approve');
    },
  );

  it.each(['כן', 'אישור', 'מאשר', 'מאשרת', 'בסדר', 'אוקיי', 'סבבה', 'קדימה'])(
    'approves Hebrew %j',
    (text) => {
      expect(interpretApprovalReply(text)).toBe('approve');
    },
  );

  it.each(['no', 'No', 'n', 'nope', 'deny', 'denied', 'decline', 'cancel', "don't", 'stop', '👎'])(
    'denies English %j',
    (text) => {
      expect(interpretApprovalReply(text)).toBe('deny');
    },
  );

  it.each(['לא', 'בטל', 'תבטל', 'עזוב', 'לא תודה'])('denies Hebrew %j', (text) => {
    expect(interpretApprovalReply(text)).toBe('deny');
  });

  it('tolerates surrounding whitespace and punctuation', () => {
    expect(interpretApprovalReply('  yes!  ')).toBe('approve');
    expect(interpretApprovalReply('כן!!')).toBe('approve');
    expect(interpretApprovalReply('no.')).toBe('deny');
  });

  it.each([
    'make it 4pm', // refinement — T36 territory, must not flip anything
    'maybe',
    'what is this?',
    'yes but only if the morning is free', // hedged ⇒ not a clean approval
    'תעשה את זה בארבע',
    '',
    '   ',
  ])('anything else is unclear: %j', (text) => {
    expect(interpretApprovalReply(text)).toBe('unclear');
  });
});
