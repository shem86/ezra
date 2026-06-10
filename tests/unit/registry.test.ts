// T26: tool registry — ToolSet projection for the model side, runTool
// dispatcher for the workflow side. All pure logic with injected fakes.

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { defineTool, type ToolContext } from '../../src/tools/define-tool.js';
import {
  makeRunTool,
  makeToolRegistry,
  toToolSet,
  type ParkRequest,
} from '../../src/tools/registry.js';
import type { ToolCall, ToolResult } from '../../src/agent/context.js';
import type { Queryable } from '../../src/memory/store.js';

interface FakeDeps {
  readonly label: string;
}

const fakeDb: Queryable = {
  query: async () => ({ rows: [] }),
};

interface ExecuteCapture {
  args: unknown;
  deps: FakeDeps;
  ctx: ToolContext;
}

function makeFixtures() {
  const executed: ExecuteCapture[] = [];
  const listAdd = defineTool<FakeDeps, z.ZodObject<{ item: z.ZodString }>>({
    name: 'list_add',
    description: 'Add an item to a shared list',
    schema: z.object({ item: z.string().min(1) }),
    riskTier: 'autonomous',
    execute: async (args, deps, ctx) => {
      executed.push({ args, deps, ctx });
      return `added ${args.item}`;
    },
  });
  const setFact = defineTool<FakeDeps, z.ZodObject<{ fact: z.ZodString }>>({
    name: 'set_fact',
    description: 'Record a household fact',
    schema: z.object({ fact: z.string() }),
    riskTier: 'notify-after',
    execute: async (args, deps, ctx) => {
      executed.push({ args, deps, ctx });
      return 'recorded';
    },
  });
  const createEvent = defineTool<FakeDeps, z.ZodObject<{ title: z.ZodString }>>({
    name: 'create_event',
    description: 'Create a calendar event',
    schema: z.object({ title: z.string() }),
    riskTier: 'confirm-before',
    externalId: (ctx) => `hh-${ctx.actionId}`,
    revalidate: async () => true,
    execute: async (args, deps, ctx) => {
      executed.push({ args, deps, ctx });
      return 'created';
    },
  });
  return { executed, listAdd, setFact, createEvent };
}

const deps: FakeDeps = { label: 'fake' };

function call(name: string, args: unknown, id = 'tu_1'): ToolCall {
  return { id, name, args };
}

describe('makeToolRegistry', () => {
  it('indexes definitions by name', () => {
    const { listAdd, createEvent } = makeFixtures();
    const registry = makeToolRegistry([listAdd, createEvent]);

    expect(registry.get('list_add')).toBe(listAdd);
    expect(registry.get('create_event')).toBe(createEvent);
  });

  it('rejects duplicate tool names', () => {
    const { listAdd } = makeFixtures();
    expect(() => makeToolRegistry([listAdd, listAdd])).toThrow(/list_add/);
  });
});

describe('toToolSet', () => {
  it('projects definitions only — no execute, DBOS owns the loop', () => {
    const { listAdd, createEvent } = makeFixtures();
    const toolSet = toToolSet(makeToolRegistry([listAdd, createEvent]));

    expect(Object.keys(toolSet).sort()).toEqual(['create_event', 'list_add']);
    expect(toolSet['list_add']?.description).toBe('Add an item to a shared list');
    expect(toolSet['list_add']?.inputSchema).toBe(listAdd.schema);
    expect(toolSet['list_add']?.execute).toBeUndefined();
    expect(toolSet['create_event']?.execute).toBeUndefined();
  });
});

describe('makeRunTool', () => {
  function makeRunner() {
    const fixtures = makeFixtures();
    const parked: Array<{ db: Queryable; request: ParkRequest }> = [];
    const park = async (db: Queryable, request: ParkRequest): Promise<ToolResult> => {
      parked.push({ db, request });
      return {
        toolUseId: request.call.id,
        content: `pending approval, action_id=${request.actionId}`,
        parked: true,
      };
    };
    const registry = makeToolRegistry([fixtures.listAdd, fixtures.setFact, fixtures.createEvent]);
    return { ...fixtures, parked, runTool: makeRunTool(registry, { toolDeps: deps, park }) };
  }

  it('executes an autonomous tool with parsed args, deps, and full context', async () => {
    const { runTool, executed } = makeRunner();

    const result = await runTool(fakeDb, call('list_add', { item: 'milk' }), 'conv-1');

    expect(result).toEqual({ toolUseId: 'tu_1', content: 'added milk', parked: false });
    expect(executed).toHaveLength(1);
    expect(executed[0]?.args).toEqual({ item: 'milk' });
    expect(executed[0]?.deps).toBe(deps);
    expect(executed[0]?.ctx.db).toBe(fakeDb);
    expect(executed[0]?.ctx.conversationId).toBe('conv-1');
    expect(executed[0]?.ctx.toolUseId).toBe('tu_1');
    expect(executed[0]?.ctx.externalId).toBeUndefined();
  });

  it('executes a notify-after tool in-turn (tier is metadata for the send side)', async () => {
    const { runTool, executed } = makeRunner();

    const result = await runTool(fakeDb, call('set_fact', { fact: 'wifi is fios' }), 'conv-1');

    expect(result.parked).toBe(false);
    expect(result.content).toBe('recorded');
    expect(executed).toHaveLength(1);
  });

  it('derives the actionId deterministically from journaled values only', async () => {
    const first = makeRunner();
    const second = makeRunner();

    await first.runTool(fakeDb, call('list_add', { item: 'milk' }, 'tu_9'), 'conv-2');
    await second.runTool(fakeDb, call('list_add', { item: 'milk' }, 'tu_9'), 'conv-2');

    const a = first.executed[0]?.ctx.actionId;
    expect(a).toBeDefined();
    expect(second.executed[0]?.ctx.actionId).toBe(a);
  });

  it('parks a confirm-before tool without executing it', async () => {
    const { runTool, executed, parked } = makeRunner();

    const result = await runTool(fakeDb, call('create_event', { title: 'dentist' }), 'conv-1');

    expect(executed).toHaveLength(0); // NEVER auto-execute confirm-before (SPEC)
    expect(parked).toHaveLength(1);
    expect(parked[0]?.db).toBe(fakeDb);
    expect(parked[0]?.request.conversationId).toBe('conv-1');
    expect(parked[0]?.request.call).toEqual(call('create_event', { title: 'dentist' }));
    expect(parked[0]?.request.externalId).toBe(`hh-${parked[0]?.request.actionId}`);
    expect(result.parked).toBe(true);
    expect(result.toolUseId).toBe('tu_1');
    expect(result.content).toContain(parked[0]?.request.actionId);
  });

  it('forces parked=true even if a park implementation forgets it', async () => {
    const { listAdd, createEvent } = makeFixtures();
    const registry = makeToolRegistry([listAdd, createEvent]);
    const runTool = makeRunTool(registry, {
      toolDeps: deps,
      park: async (_db, request) => ({
        toolUseId: request.call.id,
        content: 'pending',
        parked: false,
      }),
    });

    const result = await runTool(fakeDb, call('create_event', { title: 'x' }), 'conv-1');

    expect(result.parked).toBe(true);
  });

  it('answers an unknown tool with an error result instead of throwing', async () => {
    const { runTool, parked } = makeRunner();

    const result = await runTool(fakeDb, call('no_such_tool', {}), 'conv-1');

    expect(result).toEqual({
      toolUseId: 'tu_1',
      content: expect.stringContaining('no_such_tool') as string,
      parked: false,
    });
    expect(parked).toHaveLength(0);
  });

  it('answers schema-invalid args with the validation issues, execute untouched', async () => {
    const { runTool, executed } = makeRunner();

    const result = await runTool(fakeDb, call('list_add', { item: '' }), 'conv-1');

    expect(executed).toHaveLength(0);
    expect(result.parked).toBe(false);
    expect(result.content).toContain('list_add');
    expect(result.content).toContain('item');
  });
});
