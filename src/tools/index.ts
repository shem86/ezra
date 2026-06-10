// Registry assembly (T27): the one place the v1 tool surface is enumerated.
// The composing caller projects it twice — toToolSet for the model side,
// makeRunTool for the workflow side.

import { makeToolRegistry, type ToolRegistry } from './registry.js';
import type { HouseholdToolDeps } from './deps.js';
import { addListItemTool, getListTool, markItemDoneTool } from './lists.js';
import { getFactTool, setFactTool } from './facts.js';

export function makeHouseholdToolRegistry(): ToolRegistry<HouseholdToolDeps> {
  return makeToolRegistry<HouseholdToolDeps>([
    addListItemTool,
    getListTool,
    markItemDoneTool,
    setFactTool,
    getFactTool,
  ]);
}
