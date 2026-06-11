// T29 unit gate: the split logic is where compaction can corrupt a
// transcript (orphaned tool_result ⇒ provider 400 on every later turn), so
// it gets exhaustive fixtures; threshold, assembly, and prompt content ride
// along. No DB, no model.

import { describe, expect, it } from 'vitest';
import {
  buildCompactedTranscript,
  compactionSenderId,
  defaultCompactionConfig,
  findCompactionCut,
  renderForSummary,
  shouldCompact,
  summarySystemPrompt,
} from '../../src/agent/compaction.js';
import type { TurnMessage } from '../../src/agent/context.js';

function user(content: string, senderId = 'wife'): TurnMessage {
  return { role: 'user', senderId, content };
}
function assistant(content: string, toolIds: string[] = []): TurnMessage {
  return {
    role: 'assistant',
    content,
    toolCalls: toolIds.map((id) => ({ id, name: 'add_item', args: {} })),
  };
}
function toolResult(toolUseId: string): TurnMessage {
  return { role: 'tool', toolUseId, content: `result for ${toolUseId}` };
}

/** A realistic turn: user, then rounds of assistant(tool_use)+results, then final. */
function turn(n: number, toolRounds: number): TurnMessage[] {
  const msgs: TurnMessage[] = [user(`message ${n}`)];
  for (let r = 0; r < toolRounds; r++) {
    const id = `tu-${n}-${r}`;
    msgs.push(assistant(`round ${r}`, [id]), toolResult(id));
  }
  msgs.push(assistant(`final ${n}`));
  return msgs;
}

function transcript(turns: number, toolRounds = 1): TurnMessage[] {
  return Array.from({ length: turns }, (_, i) => turn(i, toolRounds)).flat();
}

/** Every tool message in the slice has its originating tool_use in the slice. */
function assertNoOrphanedResults(slice: readonly TurnMessage[]): void {
  const useIds = new Set(
    slice.filter((m) => m.role === 'assistant').flatMap((m) => m.toolCalls.map((c) => c.id)),
  );
  for (const m of slice) {
    if (m.role === 'tool') expect(useIds.has(m.toolUseId)).toBe(true);
  }
}

describe('shouldCompact', () => {
  it('triggers strictly above the threshold, not at it', () => {
    const cfg = { thresholdMessages: 10, keepMessages: 4 };
    expect(shouldCompact(transcript(2, 1).slice(0, 10), cfg)).toBe(false);
    expect(shouldCompact(transcript(3, 1).slice(0, 11), cfg)).toBe(true);
  });

  it('defaults match the Open Q3 resolution', () => {
    expect(defaultCompactionConfig).toEqual({ thresholdMessages: 60, keepMessages: 20 });
  });
});

describe('findCompactionCut', () => {
  const cfg = { thresholdMessages: 10, keepMessages: 4 };

  it('returns the largest user index that keeps at least keepMessages live', () => {
    const msgs = transcript(5, 0); // turns of [user, assistant] — users at even indices
    const cut = findCompactionCut(msgs, cfg);

    expect(cut).toBe(6); // len 10, maxCut 6, msgs[6] is a user message
    expect(msgs[cut!]!.role).toBe('user');
    expect(msgs.length - cut!).toBeGreaterThanOrEqual(cfg.keepMessages);
  });

  it('walks back past assistant/tool messages when maxCut lands mid-turn', () => {
    const msgs = transcript(3, 2); // 6 messages per turn; users at 0, 6, 12
    const cut = findCompactionCut(msgs, { thresholdMessages: 10, keepMessages: 5 });

    // maxCut = 18 - 5 = 13 (an assistant message) — walks back to the user at 12.
    expect(cut).toBe(12);
  });

  it('never orphans a tool_result, across window shapes', () => {
    for (const toolRounds of [0, 1, 2, 3]) {
      for (const keepMessages of [2, 5, 8, 13]) {
        const msgs = transcript(6, toolRounds);
        const cut = findCompactionCut(msgs, { thresholdMessages: 1, keepMessages });
        if (cut === null) continue;
        expect(msgs[cut]!.role).toBe('user');
        assertNoOrphanedResults(msgs.slice(0, cut));
        assertNoOrphanedResults(msgs.slice(cut));
      }
    }
  });

  it('returns null when the only user boundary is index 0 (head would be empty)', () => {
    const msgs = turn(0, 3); // one giant turn
    expect(findCompactionCut(msgs, { thresholdMessages: 4, keepMessages: 2 })).toBe(null);
  });

  it('returns null on a degenerate transcript with no user messages', () => {
    const msgs: TurnMessage[] = [assistant('a'), assistant('b'), assistant('c')];
    expect(findCompactionCut(msgs, { thresholdMessages: 1, keepMessages: 1 })).toBe(null);
  });
});

describe('buildCompactedTranscript', () => {
  it('prepends the summary as a user message with the reserved sender', () => {
    const tail = [user('האם לקנות חלב? also eggs'), assistant('on it')];
    const result = buildCompactedTranscript('סיכום: דיברנו על הצהרון', tail);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ role: 'user', senderId: compactionSenderId });
    expect(result[0]!.content).toContain('סיכום: דיברנו על הצהרון');
    expect(result.slice(1)).toEqual(tail);
  });
});

describe('summary prompt and rendering', () => {
  it('demands verbatim open commitments, language preservation, and prior-summary folding', () => {
    expect(summarySystemPrompt).toMatch(/open commitment.*VERBATIM/is);
    expect(summarySystemPrompt).toMatch(/Hebrew stays Hebrew/);
    expect(summarySystemPrompt).toContain(compactionSenderId);
    expect(summarySystemPrompt).toMatch(/database owns/);
  });

  it('renders role-tagged lines with code-switched content intact', () => {
    const rendered = renderForSummary([
      user('תזכיר לי מחר re: the plumber', 'reut'),
      assistant('בסדר, מזכירה'),
      toolResult('tu-1'),
    ]);

    expect(rendered).toBe(
      'reut: תזכיר לי מחר re: the plumber\nassistant: בסדר, מזכירה\n[tool result] result for tu-1',
    );
  });
});
