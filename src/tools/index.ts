// Registry assembly (T27): the one place the v1 tool surface is enumerated.
// The composing caller projects it twice — toToolSet for the model side,
// makeRunTool for the workflow side.

import { makeToolRegistry, type ToolRegistry } from './registry.js';
import type { HouseholdToolDeps } from './deps.js';
import { addListItemTool, getListTool, markItemDoneTool } from './lists.js';
import { getFactTool, setFactTool } from './facts.js';
import { cancelReminderTool, createReminderTool, listRemindersTool } from './reminders.js';
import { recallHistoryTool } from './recall.js';
import {
  createCalendarEventTool,
  listCalendarEventsTool,
  type CalendarToolDeps,
} from './calendar.js';

export function makeHouseholdToolRegistry(): ToolRegistry<HouseholdToolDeps> {
  return makeToolRegistry<HouseholdToolDeps>([
    addListItemTool,
    getListTool,
    markItemDoneTool,
    setFactTool,
    getFactTool,
    createReminderTool,
    listRemindersTool,
    cancelReminderTool,
    recallHistoryTool,
  ]);
}

/**
 * The full v1 surface (T40): household tools + calendar. Household
 * definitions are typed over the narrower deps and stay assignable here
 * (parameter contravariance) — they simply ignore the calendar client.
 * Kept separate from makeHouseholdToolRegistry so DB-only compositions
 * (and the T38 eval registry) don't have to conjure a CalendarClient.
 */
export function makeV1ToolRegistry(): ToolRegistry<CalendarToolDeps> {
  return makeToolRegistry<CalendarToolDeps>([
    ...makeHouseholdToolRegistry().values(),
    createCalendarEventTool,
    listCalendarEventsTool,
  ]);
}
