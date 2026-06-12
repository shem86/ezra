// Fixture for the T34 kill-mid-park recovery drill: the REAL production
// park (makePark) behind the REAL makeRunTool, driven by handleTurn against
// a fake confirm-before tool (the real one is T40). The only test-ism is the
// slowPark wrapper: a sleep BEFORE delegating gives the parent a kill window
// inside the transaction, exactly the slow_add trick from the T22 drill.
import './pin-appversion-park.ts'; // must precede the SDK import
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
import { defineTool } from '../../../src/tools/define-tool.ts';
import { makeRunTool, makeToolRegistry, type RunToolDeps } from '../../../src/tools/registry.ts';
import { makePark } from '../../../src/hitl/park.ts';
import { makeResolveApprovalReply } from '../../../src/hitl/resolve-approval.ts';
import { addListItem, loadContext, saveContext } from '../../../src/memory/store.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the park recovery fixture');
}
export const parkConnectionString: string = connectionString;

export const dataSource = new NodePostgresDataSource('park-recovery-db', { connectionString });

/** Tool writes land in the per-conversation list `park-<conversationId>`. */
export function parkToolListFor(conversationId: string): string {
  return `park-${conversationId}`;
}

type NoDeps = Record<string, never>;

const addItem = defineTool<NoDeps, z.ZodType<{ item: string }>>({
  name: 'add_item',
  description: 'autonomous write — the observable pre-kill effect',
  schema: z.object({ item: z.string() }),
  riskTier: 'autonomous',
  execute: async (args, _deps, ctx) => {
    await addListItem(ctx.db, {
      list: parkToolListFor(ctx.conversationId),
      item: args.item,
      addedBy: ctx.conversationId,
    });
    return `added ${args.item}`;
  },
});

const proposeEvent = defineTool<NoDeps, z.ZodType<{ title: string }>>({
  name: 'propose_event',
  description: 'fake confirm-before tool (the real one is T40)',
  schema: z.object({ title: z.string() }),
  riskTier: 'confirm-before',
  revalidate: async () => true,
  // Reached only through T35 approval — makeRunTool never executes a
  // confirm-before tool at propose time. The sleep BEFORE the write is the
  // T35 drill's kill window, inside the resolver transaction: a SIGKILL
  // mid-sleep rolls back the approve flip, the claim, and this write as one.
  execute: async (_args, _deps, ctx) => {
    await new Promise((r) => setTimeout(r, 3000));
    await addListItem(ctx.db, {
      list: parkToolListFor(ctx.conversationId),
      item: 'event-created',
      addedBy: ctx.actionId,
    });
    return 'event created';
  },
});

const realPark = makePark({ ttlHours: 12 });
// Kill window: sleep BEFORE the row write, inside the transaction — a
// SIGKILL mid-sleep commits nothing, and recovery re-runs the whole step.
const slowPark: RunToolDeps<NoDeps>['park'] = async (db, request) => {
  await new Promise((r) => setTimeout(r, 3000));
  return realPark(db, request);
};

const parkRegistry = makeToolRegistry<NoDeps>([addItem, proposeEvent]);

const runTool = makeRunTool(parkRegistry, {
  toolDeps: {},
  park: slowPark,
});

const loadContextStep = registerTransactionalStep(
  dataSource,
  'loadParkTurnContext',
  async (db, conversationId: string): Promise<TurnMessage[]> =>
    parseTurnMessages(await loadContext(db, conversationId)),
);

const persistContextStep = registerTransactionalStep(
  dataSource,
  'persistParkTurnContext',
  async (db, conversationId: string, messages: TurnMessage[]): Promise<void> =>
    saveContext(db, conversationId, messages),
);

const runToolStep = registerTransactionalStep(
  dataSource,
  'runParkTool',
  async (db, call: ToolCall, conversationId: string): Promise<ToolResult> =>
    runTool(db, call, conversationId),
);

const resolveApprovalStep = registerTransactionalStep(
  dataSource,
  'resolveParkApproval',
  makeResolveApprovalReply(parkRegistry, { toolDeps: {} }),
);

/**
 * Scripted model, pure function of the transcript (replay-deterministic):
 * round 0 writes the observable pre-kill item, round 1 calls the
 * confirm-before tool whose park the parent kills mid-flight.
 */
async function scriptedCallModel(
  msgs: readonly TurnMessage[],
  options: ModelCallOptions,
): Promise<AssistantMessage> {
  if (options.forceFinal) {
    return { role: 'assistant', content: 'forced final', toolCalls: [] };
  }
  const round = msgs.filter((m) => m.role === 'assistant').length;
  if (round === 0) {
    return {
      role: 'assistant',
      content: 'writing the pre-kill marker',
      toolCalls: [{ id: 'tu-prekill-1', name: 'add_item', args: { item: 'before-kill' } }],
    };
  }
  if (round === 1) {
    return {
      role: 'assistant',
      content: 'proposing the event',
      toolCalls: [{ id: 'tu-park-1', name: 'propose_event', args: { title: 'dentist Tuesday' } }],
    };
  }
  // The T35 approval turn re-enters with the parking turn's transcript
  // (2 rounds + the closing prompt): plain final, no more tools.
  return { role: 'assistant', content: 'noted.', toolCalls: [] };
}

export const parkTurnWorkflow = DBOS.registerWorkflow(
  makeHandleTurnWorkflow({
    loadContext: loadContextStep,
    persistContext: persistContextStep,
    runTool: runToolStep,
    resolveApproval: resolveApprovalStep,
    callModel: scriptedCallModel,
  }),
  { name: 'handleTurnParkRecovery' },
);

export async function launchParkRuntime(): Promise<void> {
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  DBOS.setConfig({ name: 'hh-park-test', systemDatabaseUrl: connectionString });
  await DBOS.launch();
}
