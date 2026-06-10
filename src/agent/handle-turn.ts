// handleTurn (T22): the SPEC loop shape, DBOS owning the loop. The skeleton
// runs against any callModel (M4 brings the real one via AI SDK Core); the
// invariants here are what keep replay correct:
//  - every branch input comes from a journaled step, so the variable
//    iteration count replays deterministically;
//  - every tool_use is answered with a tool_result — denials and parks
//    included — or the next model call errors;
//  - a park ends the turn immediately (decision 10 fire-and-fold: never
//    block the conversation slot on a human);
//  - cap-hit forces one final no-tools message instead of a silent stall;
//  - msgs stays workflow-local and is never journaled whole: steps record
//    per-round deltas, and the transcript reaches callModel by closure.

import { DBOS } from '@dbos-inc/dbos-sdk';
import {
  toModelMessages,
  type AssistantMessage,
  type BatchItem,
  type ToolCall,
  type ToolResult,
  type TurnMessage,
} from './context.js';

export interface ModelCallOptions {
  /** Cap-hit recovery: the model must answer with a user-facing message, no tools. */
  readonly forceFinal: boolean;
}

export interface HandleTurnDeps {
  /**
   * loadContext / persistContext / runTool must already be registered DBOS
   * steps or datasource transactions (see dbos.md) — the workflow body calls
   * them directly and relies on their journaling for replay determinism.
   */
  readonly loadContext: (conversationId: string) => Promise<TurnMessage[]>;
  readonly persistContext: (conversationId: string, messages: TurnMessage[]) => Promise<void>;
  readonly runTool: (call: ToolCall, conversationId: string) => Promise<ToolResult>;
  /**
   * Plain async function — the workflow wraps each call in DBOS.runStep, so
   * the journaled output is one assistant message (the per-round delta) and
   * the transcript passes by closure, never as a step input.
   */
  readonly callModel: (
    messages: readonly TurnMessage[],
    options: ModelCallOptions,
  ) => Promise<AssistantMessage>;
  /** Tool-round hard cap (SPEC open question 2 proposes 8). */
  readonly maxRounds?: number;
}

export type TurnStatus = 'completed' | 'parked' | 'cap-hit';

export interface TurnResult {
  readonly status: TurnStatus;
  /** Model rounds consumed, excluding the forced final on cap-hit. */
  readonly rounds: number;
}

export function makeHandleTurnWorkflow(
  deps: HandleTurnDeps,
): (conversationId: string, batch: BatchItem[]) => Promise<TurnResult> {
  const maxRounds = deps.maxRounds ?? 8;

  return async function handleTurn(
    conversationId: string,
    batch: BatchItem[],
  ): Promise<TurnResult> {
    const msgs = await deps.loadContext(conversationId);
    msgs.push(...toModelMessages(batch));

    let status: TurnStatus = 'cap-hit';
    let rounds = 0;
    for (let i = 0; i < maxRounds; i++) {
      const assistant = await DBOS.runStep(() => deps.callModel(msgs, { forceFinal: false }), {
        name: 'callModel',
      });
      rounds += 1;
      msgs.push(assistant);
      if (assistant.toolCalls.length === 0) {
        status = 'completed';
        break;
      }

      let parked = false;
      for (const call of assistant.toolCalls) {
        const result = await deps.runTool(call, conversationId);
        // ALWAYS answer — an unanswered tool_use errors the next model call.
        msgs.push({ role: 'tool', toolUseId: result.toolUseId, content: result.content });
        if (result.parked) parked = true;
      }
      if (parked) {
        // Fire-and-fold: end the turn and free the slot; the real outcome
        // re-enters a fresh turn as a new context message, never a second
        // tool_result for this tool_use.
        status = 'parked';
        break;
      }
    }

    if (status === 'cap-hit') {
      const finalMessage = await DBOS.runStep(
        () => deps.callModel(msgs, { forceFinal: true }),
        { name: 'callModelForcedFinal' },
      );
      if (finalMessage.toolCalls.length > 0) {
        // A tool call here would go unanswered forever — fail loud instead
        // of persisting a transcript that errors every later turn.
        throw new Error('handleTurn: forced-final model call returned tool calls');
      }
      msgs.push(finalMessage);
    }

    await deps.persistContext(conversationId, msgs);
    return { status, rounds };
  };
}
