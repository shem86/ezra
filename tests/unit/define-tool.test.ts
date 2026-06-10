// T26: defineTool — the typed tool-definition helper every tool goes through.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool } from '../../src/tools/define-tool.js';

interface FakeDeps {
  readonly noop: true;
}

const addItemSpec = {
  name: 'list_add',
  description: 'Add an item to a shared list',
  schema: z.object({ item: z.string().min(1) }),
  riskTier: 'autonomous' as const,
  execute: async () => 'added',
};

describe('defineTool', () => {
  it('returns the definition unchanged for a valid autonomous tool', () => {
    const def = defineTool<FakeDeps, typeof addItemSpec.schema>(addItemSpec);

    expect(def.name).toBe('list_add');
    expect(def.riskTier).toBe('autonomous');
    expect(def.schema).toBe(addItemSpec.schema);
    expect(def.execute).toBe(addItemSpec.execute);
  });

  it('enforces the SPEC boundary: confirm-before without revalidate throws', () => {
    expect(() =>
      defineTool<FakeDeps, typeof addItemSpec.schema>({
        ...addItemSpec,
        name: 'create_event',
        riskTier: 'confirm-before',
      }),
    ).toThrow(/create_event.*revalidat/i);
  });

  it('accepts confirm-before when a revalidation check is declared', () => {
    const def = defineTool<FakeDeps, typeof addItemSpec.schema>({
      ...addItemSpec,
      name: 'create_event',
      riskTier: 'confirm-before',
      revalidate: async () => true,
    });

    expect(def.riskTier).toBe('confirm-before');
    expect(def.revalidate).toBeDefined();
  });

  it('rejects an empty tool name', () => {
    expect(() => defineTool<FakeDeps, typeof addItemSpec.schema>({ ...addItemSpec, name: '' })).toThrow(
      /name/,
    );
  });
});
