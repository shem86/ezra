// T32: the scripted-day fixture must cover the whole v1 tool surface (the M4
// gate criterion "every tool exercised through pnpm dev stub conversations")
// and stay code-switched (CLAUDE.md: fixtures must cover Hebrew/English).

import { describe, expect, it } from 'vitest';
import { scriptedDay } from '../../src/dev/scripted-day.js';
import { makeHouseholdToolRegistry } from '../../src/tools/index.js';

describe('scriptedDay fixture', () => {
  it('declares coverage for every tool in the household registry', () => {
    const registryNames = [...makeHouseholdToolRegistry().keys()].sort();
    const covered = [...new Set(scriptedDay.flatMap((c) => c.covers))].sort();
    expect(covered).toEqual(registryNames);
  });

  it('is code-switched: contains both Hebrew and English user text', () => {
    const allText = scriptedDay.flatMap((c) => c.messages.map((m) => m.text)).join(' ');
    expect(allText).toMatch(/[֐-׿]/); // Hebrew block
    expect(allText).toMatch(/[a-zA-Z]/);
  });

  it('attributes messages to both household members', () => {
    const senders = new Set(scriptedDay.flatMap((c) => c.messages.map((m) => m.senderId)));
    expect(senders.size).toBeGreaterThanOrEqual(2);
  });

  it('conversation keys are unique (each runs as its own conversation)', () => {
    const keys = scriptedDay.map((c) => c.conversationKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
