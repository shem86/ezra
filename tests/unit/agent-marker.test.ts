import { describe, expect, it } from 'vitest';
import { AGENT_MARKER, markAgentText } from '../../src/transport/agent-marker.ts';

describe('markAgentText', () => {
  it('prepends the agent marker to plain text', () => {
    expect(markAgentText('trash night at 7')).toBe(`${AGENT_MARKER}trash night at 7`);
  });

  it('is idempotent — already-marked text is returned unchanged', () => {
    const once = markAgentText('reminder');
    expect(markAgentText(once)).toBe(once);
  });

  it('is deterministic — safe inside the durable send step', () => {
    expect(markAgentText('הזכרה')).toBe(markAgentText('הזכרה'));
  });

  it('preserves Hebrew/code-switched bodies after the marker', () => {
    expect(markAgentText('תזכורת: trash at 7')).toBe(`${AGENT_MARKER}תזכורת: trash at 7`);
  });
});
