import { describe, expect, it } from 'vitest';
import { dominantLanguage, replyLanguageFor } from '../../src/agent/language.js';
import type { TurnMessage } from '../../src/agent/context.js';

describe('dominantLanguage', () => {
  it('reads a single-script message', () => {
    expect(dominantLanguage('List all of the facts you have saved')).toBe('en');
    expect(dominantLanguage('מה הסיסמה של הוויפי?')).toBe('he');
  });

  it('a code-switched message goes to the majority script', () => {
    expect(dominantLanguage('תוסיף oat milk לרשימה של הקניות')).toBe('he');
    expect(dominantLanguage('add חלב to the shopping list please')).toBe('en');
  });

  it('no letters, or an even split, has no language', () => {
    expect(dominantLanguage('👍 1234')).toBeNull();
    expect(dominantLanguage('ok או')).toBeNull();
  });
});

describe('replyLanguageFor', () => {
  it('follows the LATEST member message, not the run before it (prod 2026-10-29)', () => {
    const msgs: TurnMessage[] = [
      { role: 'user', senderId: 'husband@wa', content: 'עכשיו אתה חכם יותר, מרגיש את זה?' },
      { role: 'assistant', content: 'ההרגשה שלי לא משנה כאן', toolCalls: [] },
      { role: 'user', senderId: 'husband@wa', content: 'List all of the facts you have saved' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'tu_1', name: 'list_facts', args: {} }] },
      { role: 'tool', toolUseId: 'tu_1', content: 'plant-care: להשקות רק כשהאדמה יבשה' },
    ];
    expect(replyLanguageFor(msgs)).toBe('en');
  });

  it('skips system senders — an hitl update or summary is not the member speaking', () => {
    const msgs: TurnMessage[] = [
      { role: 'user', senderId: 'wife@wa', content: 'כן, תקבע' },
      { role: 'user', senderId: 'system:hitl', content: '[action update] create_event approved and executed' },
    ];
    expect(replyLanguageFor(msgs)).toBe('he');
  });

  it('no member message, or one without letters, gives no language', () => {
    expect(replyLanguageFor([])).toBeNull();
    expect(replyLanguageFor([{ role: 'user', senderId: 'wife@wa', content: '👍' }])).toBeNull();
  });
});
