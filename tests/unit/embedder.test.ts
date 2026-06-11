// Voyage client contract (T28): request shape and response handling against
// a stubbed fetch — the real wire is exercised once, manually, by
// spikes/voyage-embed.ts (never real model calls in CI).

import { describe, expect, it } from 'vitest';
import { EMBEDDING_DIMENSION, makeVoyageEmbedder } from '../../src/memory/embedder.js';

function okResponse(vectors: number[][], totalTokens = 7): Response {
  return new Response(
    JSON.stringify({
      data: vectors.map((embedding, index) => ({ embedding, index })),
      usage: { total_tokens: totalTokens },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function fullVec(lead: number): number[] {
  const v = new Array<number>(EMBEDDING_DIMENSION).fill(0);
  v[0] = lead;
  return v;
}

describe('makeVoyageEmbedder', () => {
  it('sends the pinned model, explicit dimension, and document input_type', async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const embedder = makeVoyageEmbedder({
      apiKey: 'vk-test',
      fetchFn: async (url, init) => {
        captured = { url: String(url), init: init! };
        return okResponse([fullVec(1), fullVec(2)]);
      },
    });

    await embedder.embedDocuments(['שיחה על הצהרון', 'plumber on Tuesday']);

    expect(captured?.url).toBe('https://api.voyageai.com/v1/embeddings');
    const body = JSON.parse(captured?.init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('voyage-4-lite');
    expect(body.input_type).toBe('document');
    expect(body.output_dimension).toBe(EMBEDDING_DIMENSION);
    expect(body.input).toEqual(['שיחה על הצהרון', 'plumber on Tuesday']);
    expect((captured?.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer vk-test',
    );
  });

  it('embeds queries with input_type query and unwraps the single vector', async () => {
    let inputType: unknown;
    const embedder = makeVoyageEmbedder({
      apiKey: 'vk-test',
      fetchFn: async (_url, init) => {
        inputType = (JSON.parse(init?.body as string) as Record<string, unknown>).input_type;
        return okResponse([fullVec(3)]);
      },
    });

    const vector = await embedder.embedQuery('מה סיכמנו');

    expect(inputType).toBe('query');
    expect(vector).toHaveLength(EMBEDDING_DIMENSION);
    expect(vector[0]).toBe(3);
  });

  it('restores response order by index (the API contract orders by index, not position)', async () => {
    const embedder = makeVoyageEmbedder({
      apiKey: 'vk-test',
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            data: [
              { embedding: fullVec(2), index: 1 },
              { embedding: fullVec(1), index: 0 },
            ],
          }),
          { status: 200 },
        ),
    });

    const vectors = await embedder.embedDocuments(['a', 'b']);

    expect(vectors[0]?.[0]).toBe(1);
    expect(vectors[1]?.[0]).toBe(2);
  });

  it('skips the network entirely for an empty batch', async () => {
    const embedder = makeVoyageEmbedder({
      apiKey: 'vk-test',
      fetchFn: async () => {
        throw new Error('must not be called');
      },
    });

    expect(await embedder.embedDocuments([])).toEqual([]);
  });

  it('throws with status and body excerpt on a non-OK response', async () => {
    const embedder = makeVoyageEmbedder({
      apiKey: 'vk-bad',
      fetchFn: async () => new Response('{"detail":"invalid api key"}', { status: 401 }),
    });

    await expect(embedder.embedQuery('x')).rejects.toThrowError(/401.*invalid api key/);
  });

  it('rejects a dimension drift instead of letting the insert fail downstream', async () => {
    const embedder = makeVoyageEmbedder({
      apiKey: 'vk-test',
      fetchFn: async () => okResponse([[1, 2, 3]]),
    });

    await expect(embedder.embedQuery('x')).rejects.toThrowError(/dimension/);
  });

  it('reports token usage through the tap', async () => {
    const seen: number[] = [];
    const embedder = makeVoyageEmbedder({
      apiKey: 'vk-test',
      fetchFn: async () => okResponse([fullVec(1)], 42),
      onUsage: (usage) => seen.push(usage.totalTokens),
    });

    await embedder.embedQuery('x');

    expect(seen).toEqual([42]);
  });
});
