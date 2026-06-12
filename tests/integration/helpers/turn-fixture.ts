// Fixture for the T22 handleTurn skeleton: real DBOS + Postgres, scripted
// model, real transactional tool writes. Module-level singletons are banned
// in src/ but fine in test fixtures (same exemption as spikes).
import './pin-appversion-turn.ts'; // must precede the SDK import
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { z } from 'zod';
import { registerTransactionalStep } from '../../../src/orchestration/steps.ts';
import { makeHandleTurnWorkflow, type ModelCallOptions } from '../../../src/agent/handle-turn.ts';
import {
  parseTurnMessages,
  type AssistantMessage,
  type ToolCall,
  type ToolResult,
  type TurnMessage,
} from '../../../src/agent/context.ts';
import {
  addListItem,
  createPendingAction,
  getPendingActionsForConversation,
  loadContext,
  saveContext,
} from '../../../src/memory/store.ts';
import { toDigestEntries } from '../../../src/hitl/digest.ts';
import type { PendingActionDigestEntry } from '../../../src/agent/prompts.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the turn integration fixture');
}
export const turnConnectionString: string = connectionString;

export const dataSource = new NodePostgresDataSource('turn-db', { connectionString });

const loadContextStep = registerTransactionalStep(
  dataSource,
  'loadTurnContext',
  async (db, conversationId: string): Promise<TurnMessage[]> =>
    parseTurnMessages(await loadContext(db, conversationId)),
);

const persistContextStep = registerTransactionalStep(
  dataSource,
  'persistTurnContext',
  async (db, conversationId: string, messages: TurnMessage[]): Promise<void> =>
    saveContext(db, conversationId, messages),
);

const loadPendingDigestStep = registerTransactionalStep(
  dataSource,
  'loadPendingDigest',
  async (db, conversationId: string): Promise<PendingActionDigestEntry[]> =>
    toDigestEntries(await getPendingActionsForConversation(db, conversationId)),
);

const toolArgsSchema = z.looseObject({ item: z.string().optional() });

/** Tool writes land in the per-conversation list `turn-<conversationId>`. */
export function toolListFor(conversationId: string): string {
  return `turn-${conversationId}`;
}

const runToolStep = registerTransactionalStep(
  dataSource,
  'runTool',
  async (db, call: ToolCall, conversationId: string): Promise<ToolResult> => {
    const args = toolArgsSchema.parse(call.args ?? {});
    switch (call.name) {
      case 'add_item':
        await addListItem(db, {
          list: toolListFor(conversationId),
          item: args.item ?? 'unknown',
          addedBy: conversationId,
        });
        return { toolUseId: call.id, content: `added ${args.item}`, parked: false };
      case 'slow_add':
        // Kill window for the recovery drill: sleep BEFORE the write, inside
        // the transaction — a SIGKILL mid-sleep commits nothing, and recovery
        // re-runs the whole step harmlessly.
        await new Promise((r) => setTimeout(r, 3000));
        await addListItem(db, {
          list: toolListFor(conversationId),
          item: args.item ?? 'unknown',
          addedBy: conversationId,
        });
        return { toolUseId: call.id, content: `added ${args.item}`, parked: false };
      case 'deny_me':
        // Deny path: synthetic result, no state touched, the loop continues.
        return { toolUseId: call.id, content: 'user declined', parked: false };
      case 'park_me': {
        // Confirm-before park: record the pending action, answer the
        // tool_use synthetically, end the turn (decision 10 fire-and-fold).
        const actionId = `act-${call.id}-${conversationId}`;
        await createPendingAction(db, {
          actionId,
          conversationId,
          toolCall: call,
          expiresAt: new Date(Date.now() + 12 * 3_600_000),
        });
        return { toolUseId: call.id, content: `pending approval, action_id=${actionId}`, parked: true };
      }
      default:
        return { toolUseId: call.id, content: `unknown tool ${call.name}`, parked: false };
    }
  },
);

/**
 * Scripted model: a pure function of the transcript, so replay in any
 * process (including post-kill recovery) regenerates identical assistant
 * messages and tool_use ids. The script is named by the conversation's
 * FIRST user message; the round is the count of assistant messages so far.
 */
async function scriptedCallModel(
  msgs: readonly TurnMessage[],
  options: ModelCallOptions,
): Promise<AssistantMessage> {
  if (options.forceFinal) {
    return { role: 'assistant', content: 'forced final: I got stuck, want me to keep going?', toolCalls: [] };
  }
  const round = msgs.filter((m) => m.role === 'assistant').length;
  const script = msgs.find((m) => m.role === 'user')?.content ?? '';

  if (script.startsWith('script:add-then-done')) {
    if (round === 0) {
      return {
        role: 'assistant',
        content: 'adding milk',
        toolCalls: [{ id: 'tu-add-1', name: 'add_item', args: { item: 'milk' } }],
      };
    }
    return { role: 'assistant', content: 'added milk.', toolCalls: [] };
  }
  if (script.startsWith('script:kill-drill')) {
    if (round === 0) {
      return {
        role: 'assistant',
        content: 'writing first item',
        toolCalls: [{ id: 'tu-kd-1', name: 'add_item', args: { item: 'before-kill' } }],
      };
    }
    if (round === 1) {
      return {
        role: 'assistant',
        content: 'writing second item',
        toolCalls: [{ id: 'tu-kd-2', name: 'slow_add', args: { item: 'after-kill' } }],
      };
    }
    return { role: 'assistant', content: 'drill done.', toolCalls: [] };
  }
  if (script.startsWith('script:deny')) {
    if (round === 0) {
      return {
        role: 'assistant',
        content: 'trying a denied tool',
        toolCalls: [{ id: 'tu-deny-1', name: 'deny_me', args: {} }],
      };
    }
    return { role: 'assistant', content: 'understood, not doing that.', toolCalls: [] };
  }
  if (script.startsWith('script:digest-echo')) {
    // Echo the digest the workflow handed this call — proves the journaled
    // pending-actions read reaches the model.
    return { role: 'assistant', content: options.digest ?? '(no digest)', toolCalls: [] };
  }
  if (script.startsWith('script:park')) {
    return {
      role: 'assistant',
      content: 'this needs approval',
      toolCalls: [{ id: 'tu-park-1', name: 'park_me', args: {} }],
    };
  }
  if (script.startsWith('script:loop-forever')) {
    return {
      role: 'assistant',
      content: `still going (round ${round})`,
      toolCalls: [{ id: `tu-loop-${round}`, name: 'add_item', args: { item: `round-${round}` } }],
    };
  }
  return { role: 'assistant', content: 'ok.', toolCalls: [] };
}

const baseDeps = {
  loadContext: loadContextStep,
  persistContext: persistContextStep,
  runTool: runToolStep,
  callModel: scriptedCallModel,
  loadPendingDigest: loadPendingDigestStep,
};

export const handleTurnWorkflow = DBOS.registerWorkflow(makeHandleTurnWorkflow(baseDeps), {
  name: 'handleTurn',
});

export const cappedTurnWorkflow = DBOS.registerWorkflow(
  makeHandleTurnWorkflow({ ...baseDeps, maxRounds: 3 }),
  { name: 'handleTurnCapped' },
);

export async function launchTurnRuntime(): Promise<void> {
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  DBOS.setConfig({ name: 'hh-turn-test', systemDatabaseUrl: connectionString });
  await DBOS.launch();
}
