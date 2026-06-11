// Cross-tool dependencies beyond the transaction-scoped ctx.db. Widened per
// the original plan: T28 lands the embedder; M5.5's calendar client lands the
// same way instead of re-shaping the registry.

import type { Embedder } from '../memory/embedder.js';

export interface HouseholdToolDeps {
  /** Query-side embeddings for the pull-only recall tool (T28). */
  readonly embedder: Embedder;
}
