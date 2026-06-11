// Embedder seam (T28): the semantic store's only nondeterministic dependency.
// Deps-injected so integration tests run a deterministic fake (never real
// model calls in CI) and so the provider can be swapped by re-embedding —
// cents at household scale. The real client is a plain fetch against Voyage's
// one REST endpoint: a ~30-line contract was judged cheaper than a dependency
// review (docs/adr-0002-voyage-embeddings.md has the criteria and cost math).

import { z } from 'zod';

/** Must match migrations/0004 vector(1024) — drift fails loudly at insert. */
export const EMBEDDING_DIMENSION = 1024;

export interface Embedder {
  readonly dimension: number;
  /** Asymmetric retrieval: stored content embeds as "document"… */
  embedDocuments(texts: readonly string[]): Promise<number[][]>;
  /** …and recall-tool queries embed as "query" (Voyage input_type). */
  embedQuery(text: string): Promise<number[]>;
}

export interface EmbeddingUsage {
  readonly totalTokens: number;
}

export interface VoyageEmbedderOptions {
  /** From Config (src/ops/config.ts) — never read env here. */
  readonly apiKey: string;
  /** Injectable for unit tests; defaults to global fetch. */
  readonly fetchFn?: typeof fetch;
  /** Observability tap; must not throw (a throw fails and retries the step). */
  readonly onUsage?: (usage: EmbeddingUsage) => void;
}

const voyageModel = 'voyage-4-lite';
const voyageUrl = 'https://api.voyageai.com/v1/embeddings';
const requestTimeoutMs = 30_000;

const voyageResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number(),
    }),
  ),
  usage: z.object({ total_tokens: z.number() }).optional(),
});

export function makeVoyageEmbedder(options: VoyageEmbedderOptions): Embedder {
  const fetchFn = options.fetchFn ?? fetch;

  async function embed(
    texts: readonly string[],
    inputType: 'document' | 'query',
  ): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetchFn(voyageUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: voyageModel,
        input: texts,
        input_type: inputType,
        output_dimension: EMBEDDING_DIMENSION,
      }),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    if (!response.ok) {
      // Body text aids diagnosis; status alone distinguishes retryable (5xx,
      // handled by step retry) from key/quota problems that need a human.
      const body = await response.text().catch(() => '');
      throw new Error(`voyage embeddings: HTTP ${response.status} — ${body.slice(0, 200)}`);
    }

    const parsed = voyageResponseSchema.parse(await response.json());
    if (parsed.usage !== undefined) {
      options.onUsage?.({ totalTokens: parsed.usage.total_tokens });
    }

    const vectors = [...parsed.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== texts.length) {
      throw new Error(
        `voyage embeddings: ${texts.length} inputs but ${vectors.length} embeddings returned`,
      );
    }
    for (const vector of vectors) {
      if (vector.length !== EMBEDDING_DIMENSION) {
        throw new Error(
          `voyage embeddings: expected dimension ${EMBEDDING_DIMENSION}, got ${vector.length}`,
        );
      }
    }
    return vectors;
  }

  return {
    dimension: EMBEDDING_DIMENSION,
    embedDocuments: (texts) => embed(texts, 'document'),
    embedQuery: async (text) => {
      const [vector] = await embed([text], 'query');
      return vector!;
    },
  };
}
