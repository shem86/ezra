// [tool] log line: what the model called and how it came back, so a turn can
// be reconstructed from `docker logs` without a DB read. Captured log sink.

import { describe, expect, it } from 'vitest';
import { withToolCallLog } from '../../src/ops/tool-log.js';
import type { ToolCall, ToolResult } from '../../src/agent/context.js';
import type { Queryable } from '../../src/memory/store.js';

const db = {} as Queryable;
const call: ToolCall = { id: 'tu_1', name: 'get_fact', args: { key: 'all facts' } };

function captured(): { lines: string[]; log: (line: string) => void } {
  const lines: string[] = [];
  return { lines, log: (line) => lines.push(line) };
}

describe('withToolCallLog', () => {
  it('logs chat, tool, args and the first line of the result, and passes the result through', async () => {
    const { lines, log } = captured();
    const result: ToolResult = {
      toolUseId: 'tu_1',
      content: 'no fact stored under all facts; closest matches:\nwifi: «untrusted…',
      parked: false,
    };

    const out = await withToolCallLog(async () => result, log)(db, call, 'conv-1');

    expect(out).toBe(result);
    expect(lines).toEqual([
      '[tool] chat=conv-1 get_fact args={"key":"all facts"} → ok: no fact stored under all facts; closest matches:',
    ]);
  });

  it('marks a parked call', async () => {
    const { lines, log } = captured();

    await withToolCallLog(
      async () => ({ toolUseId: 'tu_1', content: 'pending approval', parked: true }),
      log,
    )(db, call, 'conv-1');

    expect(lines[0]).toContain('→ parked: pending approval');
  });

  it('truncates long args and results', async () => {
    const { lines, log } = captured();
    const long: ToolCall = { ...call, args: { key: 'k'.repeat(500) } };

    await withToolCallLog(
      async () => ({ toolUseId: 'tu_1', content: 'r'.repeat(500), parked: false }),
      log,
    )(db, long, 'conv-1');

    expect(lines[0]!.length).toBeLessThan(400);
    expect(lines[0]).toContain('…');
  });

  it('logs a throw and rethrows it unchanged', async () => {
    const { lines, log } = captured();
    const boom = new Error('db down');

    await expect(
      withToolCallLog(async () => {
        throw boom;
      }, log)(db, call, 'conv-1'),
    ).rejects.toBe(boom);
    expect(lines[0]).toContain('→ error: Error: db down');
  });
});
