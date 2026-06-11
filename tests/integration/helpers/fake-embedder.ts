// Deterministic embedder for integration tests (never real model calls in
// CI): fixtures map exact strings to hand-crafted vectors so cosine ordering
// is chosen by the test, while the pgvector SQL stays real.

import { EMBEDDING_DIMENSION, type Embedder } from '../../../src/memory/embedder.ts';

/** A full-dimension vector from a few leading components (rest zero). */
export function vec(...lead: number[]): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  lead.forEach((x, i) => {
    v[i] = x;
  });
  return v;
}

/**
 * Content-derived deterministic vector for tests that can't enumerate
 * fixtures up front (e.g. compaction summaries): identical text ⇒ identical
 * vector, across processes and replays.
 */
export function hashEmbed(text: string): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  for (let i = 0; i < text.length; i++) {
    v[(i * 31 + text.charCodeAt(i)) % EMBEDDING_DIMENSION] += 1;
  }
  return v;
}

export function makeFakeEmbedder(fixtures: ReadonlyMap<string, number[]>): Embedder {
  const lookup = (text: string): number[] => {
    const v = fixtures.get(text);
    if (v === undefined) {
      throw new Error(`fake embedder: no fixture for "${text}"`);
    }
    return v;
  };
  return {
    dimension: EMBEDDING_DIMENSION,
    embedDocuments: async (texts) => texts.map(lookup),
    embedQuery: async (text) => lookup(text),
  };
}
