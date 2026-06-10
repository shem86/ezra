import { describe, expect, it } from 'vitest';
import { groupIntoBatches, type DebounceableItem } from '../../src/orchestration/debounce.ts';

function human(seq: number, senderId: string): DebounceableItem {
  return { seq, kind: 'human', senderId };
}

function proactive(seq: number): DebounceableItem {
  return { seq, kind: 'proactive', senderId: 'system' };
}

describe('groupIntoBatches (T21 consumer-side debounce)', () => {
  it('groups consecutive bubbles from the same sender into one batch', () => {
    const items = [human(1, 'wife'), human(2, 'wife'), human(3, 'wife')];

    expect(groupIntoBatches(items)).toEqual([items]);
  });

  it('splits the batch when the sender changes', () => {
    const items = [human(1, 'wife'), human(2, 'wife'), human(3, 'shem'), human(4, 'wife')];

    expect(groupIntoBatches(items)).toEqual([
      [human(1, 'wife'), human(2, 'wife')],
      [human(3, 'shem')],
      [human(4, 'wife')],
    ]);
  });

  it('keeps a proactive item as its own batch, splitting a sender run', () => {
    const items = [human(1, 'wife'), proactive(2), human(3, 'wife')];

    expect(groupIntoBatches(items)).toEqual([[human(1, 'wife')], [proactive(2)], [human(3, 'wife')]]);
  });

  it('emits batches in seq order even when the input arrives unordered', () => {
    const items = [human(3, 'wife'), human(1, 'wife'), proactive(2)];

    expect(groupIntoBatches(items)).toEqual([[human(1, 'wife')], [proactive(2)], [human(3, 'wife')]]);
  });

  it('returns no batches for an empty inbox', () => {
    expect(groupIntoBatches([])).toEqual([]);
  });
});
