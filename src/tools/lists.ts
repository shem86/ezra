// Shared-list tools (T27). All autonomous: reversible household-internal DB
// rows — no cost, no third party (decision 10's classification axes).
// Result content carries the ids follow-up calls need: the model never
// trusts the transcript for exact state, it re-reads through get_list.

import { z } from 'zod';
import { defineTool } from './define-tool.js';
import type { HouseholdToolDeps } from './deps.js';
import { addListItem, getOpenItems, markItemDone } from '../memory/store.js';

const addListItemSchema = z.object({
  list: z.string().min(1).describe('List name, e.g. "groceries" or "todos"'),
  item: z.string().min(1),
  addedBy: z.string().min(1).describe('Household member who asked, from the message attribution'),
});

export const addListItemTool = defineTool<HouseholdToolDeps, typeof addListItemSchema>({
  name: 'add_list_item',
  description: 'Add an item to a shared household list.',
  schema: addListItemSchema,
  riskTier: 'autonomous',
  execute: async (args, _deps, ctx) => {
    const row = await addListItem(ctx.db, args);
    return `added "${args.item}" to ${args.list} (id ${row.id})`;
  },
});

const getListSchema = z.object({
  list: z.string().min(1),
});

export const getListTool = defineTool<HouseholdToolDeps, typeof getListSchema>({
  name: 'get_list',
  description: 'Read the open (not done) items on a shared household list.',
  schema: getListSchema,
  riskTier: 'autonomous',
  execute: async (args, _deps, ctx) => {
    const items = await getOpenItems(ctx.db, args.list);
    if (items.length === 0) {
      return `list ${args.list} is empty`;
    }
    const lines = items.map((item) => `- ${item.item} (id ${item.id}, added by ${item.addedBy})`);
    return `open items on ${args.list}:\n${lines.join('\n')}`;
  },
});

const markItemDoneSchema = z.object({
  // uuid-validated so a model mistake becomes an invalid-args tool_result,
  // not a Postgres cast error aborting the turn.
  id: z.uuid().describe('Item id from get_list or add_list_item'),
});

export const markItemDoneTool = defineTool<HouseholdToolDeps, typeof markItemDoneSchema>({
  name: 'mark_item_done',
  description: 'Mark a list item as done (checked off).',
  schema: markItemDoneSchema,
  riskTier: 'autonomous',
  execute: async (args, _deps, ctx) => {
    const row = await markItemDone(ctx.db, args.id);
    if (row === null) {
      return `no list item with id ${args.id} — not found`;
    }
    return `marked "${row.item}" done on ${row.list}`;
  },
});
