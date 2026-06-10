// Reminder tools (T27). Autonomous: a reminder row is reversible right up
// until it fires (cancel_reminder exists), and the eventual SEND is the
// at-least-once concern of the sweep + send classes, not of these writes.
// Wall times mean the HOUSEHOLD timezone, never server time: conversion to
// the stored instant happens here, through T23's wallTimeToInstant.
// Recurrence is deliberately not exposed yet — the sweep doesn't reschedule
// recurring reminders (M6 decision), and a half-working arg is worse than
// none.

import { z } from 'zod';
import { defineTool } from './define-tool.js';
import type { HouseholdToolDeps } from './deps.js';
import { householdTimeZone, wallTimeToInstant } from '../orchestration/tz.js';
import { cancelReminder, createReminder, getScheduledReminders } from '../memory/store.js';

const pad = (n: number): string => String(n).padStart(2, '0');

function wallTimeLabel(wall: { year: number; month: number; day: number; hour: number; minute: number }): string {
  return `${wall.year}-${pad(wall.month)}-${pad(wall.day)} ${pad(wall.hour)}:${pad(wall.minute)}`;
}

/** Render a stored instant back as household wall time (step context — Intl is fine here). */
function instantLabel(instant: Date): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: householdTimeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  return formatter.format(instant).replace(',', '');
}

const createReminderSchema = z.object({
  body: z.string().min(1).describe('What to remind about, in the language it was asked in'),
  year: z.number().int().min(2020).max(2100),
  month: z.number().int().min(1).max(12),
  day: z.number().int().min(1).max(31),
  hour: z.number().int().min(0).max(23).describe('Household-local hour (Eastern), 0-23'),
  minute: z.number().int().min(0).max(59),
  createdBy: z.string().min(1).describe('Household member who asked, from the message attribution'),
});

export const createReminderTool = defineTool<HouseholdToolDeps, typeof createReminderSchema>({
  name: 'create_reminder',
  description: 'Schedule a one-time reminder at a household-local (Eastern) wall time.',
  schema: createReminderSchema,
  riskTier: 'autonomous',
  execute: async (args, _deps, ctx) => {
    const wall = { year: args.year, month: args.month, day: args.day, hour: args.hour, minute: args.minute };
    const row = await createReminder(ctx.db, {
      conversationId: ctx.conversationId,
      body: args.body,
      dueAt: wallTimeToInstant(wall),
      createdBy: args.createdBy,
    });
    return `reminder ${row.id} set for ${wallTimeLabel(wall)} (household time): ${args.body}`;
  },
});

const listRemindersSchema = z.object({});

export const listRemindersTool = defineTool<HouseholdToolDeps, typeof listRemindersSchema>({
  name: 'list_reminders',
  description: 'List the scheduled (not yet fired) reminders for this conversation.',
  schema: listRemindersSchema,
  riskTier: 'autonomous',
  execute: async (_args, _deps, ctx) => {
    const reminders = await getScheduledReminders(ctx.db, ctx.conversationId);
    if (reminders.length === 0) {
      return 'no scheduled reminders';
    }
    const lines = reminders.map(
      (r) => `- ${instantLabel(r.dueAt)} (household time): ${r.body} (id ${r.id})`,
    );
    return `scheduled reminders:\n${lines.join('\n')}`;
  },
});

const cancelReminderSchema = z.object({
  id: z.uuid().describe('Reminder id from create_reminder or list_reminders'),
});

export const cancelReminderTool = defineTool<HouseholdToolDeps, typeof cancelReminderSchema>({
  name: 'cancel_reminder',
  description: 'Cancel a scheduled reminder.',
  schema: cancelReminderSchema,
  riskTier: 'autonomous',
  execute: async (args, _deps, ctx) => {
    const row = await cancelReminder(ctx.db, args.id);
    if (row === null) {
      return `reminder ${args.id} was not cancelled — it does not exist, already fired, or was already cancelled`;
    }
    return `cancelled reminder ${row.id}: ${row.body}`;
  },
});
