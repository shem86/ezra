// Turn context (T22): the persisted model-message shapes and the
// batch-to-messages conversion. The transcript lives whole-document in
// conversation_context (jsonb); these schemas are the boundary between that
// jsonb and the typed loop — corruption fails loud here, not deep in a turn.
// Skeleton shapes: M4 swaps the content model for real AI SDK messages.

import { z } from 'zod';

export const toolCallSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
});

export const turnMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), senderId: z.string(), content: z.string() }),
  z.object({ role: z.literal('assistant'), content: z.string(), toolCalls: z.array(toolCallSchema) }),
  z.object({ role: z.literal('tool'), toolUseId: z.string().min(1), content: z.string() }),
]);

export type ToolCall = z.infer<typeof toolCallSchema>;
export type TurnMessage = z.infer<typeof turnMessageSchema>;
export type AssistantMessage = Extract<TurnMessage, { role: 'assistant' }>;

/** What a tool execution hands back to the loop. `parked` ends the turn (fire-and-fold). */
export interface ToolResult {
  readonly toolUseId: string;
  readonly content: string;
  readonly parked: boolean;
  /** Present iff parked: the pending_actions key the approval prompt names (T34). */
  readonly actionId?: string;
}

export function parseTurnMessages(raw: unknown): TurnMessage[] {
  return z.array(turnMessageSchema).parse(raw);
}

/** Inbox items as the loop sees them — structurally satisfied by `InboxItem`. */
export interface BatchItem {
  readonly senderId: string;
  readonly payload: unknown;
}

const humanPayloadSchema = z.looseObject({ text: z.string() });
const proactivePayloadSchema = z.looseObject({ reminder: z.string() });

/**
 * Convert a debounced inbox batch into user messages, in batch (seq) order.
 * Unrecognized payloads degrade to their JSON — a malformed producer must
 * surface in the conversation, never silently drop a message.
 */
export function toModelMessages(batch: readonly BatchItem[]): TurnMessage[] {
  return batch.map((item) => {
    const human = humanPayloadSchema.safeParse(item.payload);
    if (human.success) {
      return { role: 'user' as const, senderId: item.senderId, content: human.data.text };
    }
    const proactive = proactivePayloadSchema.safeParse(item.payload);
    if (proactive.success) {
      return {
        role: 'user' as const,
        senderId: item.senderId,
        content: `[reminder] ${proactive.data.reminder}`,
      };
    }
    return { role: 'user' as const, senderId: item.senderId, content: JSON.stringify(item.payload) };
  });
}
