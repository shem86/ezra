// Fixture for the T29 compaction path: real DBOS + Postgres + pgvector,
// scripted model and summarizer, hash-based deterministic embeddings.
// Module-level singletons are fine in test fixtures (same exemption as
// spikes).
import './pin-appversion-compaction.ts'; // must precede the SDK import
import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { registerTransactionalStep } from '../../../src/orchestration/steps.ts';
import { makeHandleTurnWorkflow, type ModelCallOptions } from '../../../src/agent/handle-turn.ts';
import { compactionSenderId } from '../../../src/agent/compaction.ts';
import {
  parseTurnMessages,
  type AssistantMessage,
  type ToolCall,
  type ToolResult,
  type TurnMessage,
} from '../../../src/agent/context.ts';
import { loadContext, saveContext } from '../../../src/memory/store.ts';
import { writeSemanticMemory } from '../../../src/memory/semantic.ts';
import { writeCompactionLog, type CompactionLogInput } from '../../../src/memory/compaction-log.ts';
import { hashEmbed } from './fake-embedder.ts';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is required for the compaction integration fixture');
}
export const compactionConnectionString: string = connectionString;

export const dataSource = new NodePostgresDataSource('compaction-db', { connectionString });

/** Small windows so fixtures stay readable; the config is a dep, not a constant. */
export const fixtureCompactionConfig = { thresholdMessages: 12, keepMessages: 6 };

const loadContextStep = registerTransactionalStep(
  dataSource,
  'loadTurnContext',
  async (db, conversationId: string): Promise<TurnMessage[]> =>
    parseTurnMessages(await loadContext(db, conversationId)),
);

const persistContextStep = registerTransactionalStep(
  dataSource,
  'persistTurnContext',
  async (db, conversationId: string, messages: TurnMessage[]): Promise<void> => {
    // Kill window for the recovery drill: the COMPACTED persist (summary
    // first) sleeps pre-write, inside the transaction — a SIGKILL mid-sleep
    // leaves the semantic write committed but the truncation not, which is
    // exactly the gap the source_key idempotency must absorb on replay.
    if (conversationId.includes('compactkill') && messages[0]?.senderId === compactionSenderId) {
      await new Promise((r) => setTimeout(r, 3000));
    }
    await saveContext(db, conversationId, messages);
  },
);

const runToolStep = registerTransactionalStep(
  dataSource,
  'runTool',
  async (_db, call: ToolCall): Promise<ToolResult> => ({
    toolUseId: call.id,
    content: 'noop',
    parked: false,
  }),
);

const writeMemoryStep = registerTransactionalStep(
  dataSource,
  'writeCompactionMemory',
  async (
    db,
    input: { conversationId: string; content: string; embedding: number[]; sourceKey: string },
  ): Promise<boolean> => writeSemanticMemory(db, input),
);

const writeCompactionLogStep = registerTransactionalStep(
  dataSource,
  'writeCompactionLog',
  async (db, input: CompactionLogInput): Promise<boolean> => writeCompactionLog(db, input),
);

/** No tools needed: compaction triggers on transcript length, not content. */
async function scriptedCallModel(
  _msgs: readonly TurnMessage[],
  options: ModelCallOptions,
): Promise<AssistantMessage> {
  return {
    role: 'assistant',
    content: options.forceFinal ? 'forced final.' : 'ok.',
    toolCalls: [],
  };
}

/**
 * Deterministic summarizer: pure function of the head, so recovery replay
 * (journaled anyway) and test assertions agree. Echoes the head size, the
 * first user line, and a fixed code-switched "open commitment".
 */
export async function scriptedSummarize(head: readonly TurnMessage[]): Promise<string> {
  if (head.some((m) => m.role === 'user' && m.content.includes('script:fail-summary'))) {
    throw new Error('summarize exploded (scripted failure)');
  }
  const firstUser = head.find((m) => m.role === 'user');
  return `summary(${head.length}): ${firstUser?.content ?? ''} | OPEN: רעות תאשר עד חמישי re: plumber`;
}

const compactionDeps = {
  ...fixtureCompactionConfig,
  summarize: scriptedSummarize,
  embedSummary: async (summary: string) => hashEmbed(summary),
  writeMemory: writeMemoryStep,
  summarizerModelId: 'scripted-summarizer',
  writeCompactionLog: writeCompactionLogStep,
};

export const compactingTurnWorkflow = DBOS.registerWorkflow(
  makeHandleTurnWorkflow({
    loadContext: loadContextStep,
    persistContext: persistContextStep,
    runTool: runToolStep,
    callModel: scriptedCallModel,
    compaction: compactionDeps,
  }),
  { name: 'handleTurnCompacting' },
);

export async function launchCompactionRuntime(): Promise<void> {
  await NodePostgresDataSource.initializeDBOSSchema({ connectionString });
  DBOS.setConfig({ name: 'hh-compaction-test', systemDatabaseUrl: connectionString });
  await DBOS.launch();
}
