// Consumer-side debounce grouping (T21, architecture decision 2): pure logic
// over inbox items that are ALREADY durable. The silence-window waiting lives
// in the drain workflow (queue.ts); this module only decides batch shape, so
// the grouping rules stay unit-testable without a database.

import type { InboxKind } from '../memory/store.js';

/** Structural subset of `InboxItem` the grouping rules need. */
export interface DebounceableItem {
  readonly seq: number;
  readonly kind: InboxKind;
  readonly senderId: string;
}

/**
 * Group pending inbox items into turn batches, preserving the seq total
 * order: consecutive human bubbles from the same sender merge into one batch
 * (the loop sees one thought, not five); any sender change splits; a
 * proactive item is always its own batch. Input is sorted by seq first, so
 * an unordered read cannot reorder turns.
 */
export function groupIntoBatches<T extends DebounceableItem>(items: readonly T[]): T[][] {
  const ordered = [...items].sort((a, b) => a.seq - b.seq);
  const batches: T[][] = [];
  let current: T[] = [];

  for (const item of ordered) {
    const previous = current[current.length - 1];
    const continuesRun =
      previous !== undefined &&
      previous.kind === 'human' &&
      item.kind === 'human' &&
      previous.senderId === item.senderId;

    if (continuesRun) {
      current.push(item);
    } else {
      if (current.length > 0) batches.push(current);
      current = [item];
    }
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
