// T38: the eval composition — dev/main.ts's wiring with the eval registry
// (household surface + propose_event) and a scenario driver instead of the
// scripted day. REAL Sonnet turns, REAL Haiku classification, real Postgres,
// stub transport. Costs money — on-demand only, never CI (testing.md).
//
// Module-level state is banned in src/ but this is eval scaffolding (same
// exemption as test fixtures); composition still happens inside the factory
// so importing this file (e.g. `vitest list`) does nothing and needs no env.

import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { createAnthropic } from '@ai-sdk/anthropic';
import { Client } from 'pg';
import { loadConfig } from '../../src/ops/config.ts';
import { registerTransactionalStep } from '../../src/orchestration/steps.ts';
import { makeHandleTurnWorkflow, type TurnResult } from '../../src/agent/handle-turn.ts';
import { makeCallModel } from '../../src/agent/call-model.ts';
import { stableSystemPrompt, type PendingActionDigestEntry } from '../../src/agent/prompts.ts';
import { makeClassifyRelatedness } from '../../src/agent/relatedness.ts';
import {
  parseTurnMessages,
  toolCallSchema,
  type ToolCall,
  type TurnMessage,
} from '../../src/agent/context.ts';
import { makePark } from '../../src/hitl/park.ts';
import { toDigestEntries } from '../../src/hitl/digest.ts';
import { sendApprovalPrompts } from '../../src/hitl/approval-prompt.ts';
import {
  makeResolveApprovalReply,
  makeResolveClassifiedDecision,
} from '../../src/hitl/resolve-approval.ts';
import { makeRefineAction } from '../../src/hitl/refine-action.ts';
import { runMigrations } from '../../src/memory/migrate.ts';
import {
  getPendingActionsForConversation,
  loadContext,
  saveContext,
  type PendingActionStatus,
} from '../../src/memory/store.ts';
import { makeVoyageEmbedder } from '../../src/memory/embedder.ts';
import { makeRunTool, toToolSet } from '../../src/tools/registry.ts';
import { createStubTransport } from '../../src/transport/stub.ts';
import { makeFakeCalendar, type FakeCalendar } from './fake-calendar.ts';
import { makeEvalToolRegistry } from './propose-event.ts';
import type { EvalScenario, EvalScenarioMessage } from '../fixtures/decision9.ts';

/** A pending_actions row as the assertions consume it — any status. */
export interface EvalActionRow {
  readonly actionId: string;
  readonly status: PendingActionStatus;
  readonly toolCall: ToolCall;
  readonly promptMessageId: string | null;
}

export interface EvalHarness {
  readonly calendar: FakeCalendar;
  readonly db: Client;
  conversationIdFor(scenario: EvalScenario): string;
  /**
   * Drive one scripted message as one turn. quotesPrompt messages are sent
   * as quoted replies to the conversation's latest stamped approval prompt
   * (what a phone user would quote). A parked turn sends its approval
   * prompt(s) through the stamping path before returning, like pnpm dev.
   */
  runTurn(conversationId: string, message: EvalScenarioMessage): Promise<TurnResult>;
  /** All pending_actions rows for the conversation, oldest first, any status. */
  actionsFor(conversationId: string): Promise<EvalActionRow[]>;
  transcript(conversationId: string): Promise<TurnMessage[]>;
  shutdown(): Promise<void>;
}

export async function composeEvalHarness(): Promise<EvalHarness> {
  const config = loadConfig();
  await runMigrations({ databaseUrl: config.databaseUrl });

  const calendar = makeFakeCalendar();
  const registry = makeEvalToolRegistry();
  const embedder = makeVoyageEmbedder({ apiKey: config.voyageApiKey });
  const toolDeps = { embedder, calendar };
  const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });
  const callModel = makeCallModel({
    systemPrompt: stableSystemPrompt,
    model: anthropic(config.reasoningModelId),
    tools: toToolSet(registry),
  });

  const dataSource = new NodePostgresDataSource('eval-db', {
    connectionString: config.databaseUrl,
  });
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
  const runToolStep = registerTransactionalStep(
    dataSource,
    'runTool',
    makeRunTool(registry, {
      toolDeps,
      park: makePark({ ttlHours: config.approvalTtlHours }),
    }),
  );
  const loadPendingDigestStep = registerTransactionalStep(
    dataSource,
    'loadPendingDigest',
    async (db, conversationId: string): Promise<PendingActionDigestEntry[]> =>
      toDigestEntries(await getPendingActionsForConversation(db, conversationId)),
  );
  const resolveApprovalStep = registerTransactionalStep(
    dataSource,
    'resolveApproval',
    makeResolveApprovalReply(registry, { toolDeps }),
  );
  const resolveClassifiedStep = registerTransactionalStep(
    dataSource,
    'resolveClassified',
    makeResolveClassifiedDecision(registry, { toolDeps }),
  );
  const refineActionStep = registerTransactionalStep(
    dataSource,
    'refineAction',
    makeRefineAction(registry),
  );

  const handleTurn = DBOS.registerWorkflow(
    makeHandleTurnWorkflow({
      loadContext: loadContextStep,
      persistContext: persistContextStep,
      runTool: runToolStep,
      loadPendingDigest: loadPendingDigestStep,
      resolveApproval: resolveApprovalStep,
      relatedness: {
        classify: makeClassifyRelatedness({ model: anthropic(config.cheapModelId) }),
        resolveDecision: resolveClassifiedStep,
        refine: refineActionStep,
      },
      callModel,
      // No compaction: scenarios are short and the eval measures decision-9
      // behavior, not summarization.
    }),
    { name: 'handleTurn' },
  );

  await NodePostgresDataSource.initializeDBOSSchema({
    connectionString: config.databaseUrl,
  });
  DBOS.setConfig({ name: 'hh-eval', systemDatabaseUrl: config.databaseUrl });
  await DBOS.launch();

  const transport = createStubTransport();
  await transport.connect();
  const db = new Client({ connectionString: config.databaseUrl });
  await db.connect();

  // Unique per run: reruns must not share conversation state (testing.md).
  const runId = Date.now().toString(36);
  let turnSeq = 0;

  async function latestPromptStamp(conversationId: string): Promise<string> {
    const res = await db.query(
      `SELECT prompt_message_id FROM pending_actions
       WHERE conversation_id = $1 AND prompt_message_id IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
      [conversationId],
    );
    const stamp = (res.rows[0] as { prompt_message_id: string } | undefined)?.prompt_message_id;
    if (stamp === undefined) {
      throw new Error(`no stamped approval prompt in ${conversationId} to quote`);
    }
    return stamp;
  }

  return {
    calendar,
    db,
    conversationIdFor(scenario) {
      return `eval-${scenario.conversationKey}-${runId}`;
    },
    async runTurn(conversationId, message) {
      const payload =
        message.quotesPrompt === true
          ? { text: message.text, quotedMessageId: await latestPromptStamp(conversationId) }
          : { text: message.text };
      turnSeq += 1;
      const handle = await DBOS.startWorkflow(handleTurn, {
        workflowID: `eval-turn-${runId}-${turnSeq}`,
      })(conversationId, [{ senderId: message.senderId, payload }]);
      const result = await handle.getResult();
      if (result.status === 'parked') {
        await sendApprovalPrompts(db, transport, conversationId);
      }
      return result;
    },
    async actionsFor(conversationId) {
      const res = await db.query(
        `SELECT action_id, status, tool_call, prompt_message_id FROM pending_actions
         WHERE conversation_id = $1 ORDER BY created_at, action_id`,
        [conversationId],
      );
      return res.rows.map((row: Record<string, unknown>) => ({
        actionId: row.action_id as string,
        status: row.status as PendingActionStatus,
        toolCall: toolCallSchema.parse(row.tool_call),
        promptMessageId: row.prompt_message_id as string | null,
      }));
    },
    async transcript(conversationId) {
      return parseTurnMessages(await loadContext(db, conversationId));
    },
    async shutdown() {
      await db.end();
      await transport.disconnect();
      // Grace period: 4.19.x queue/pool teardown race on shutdown (dbos.md).
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await DBOS.shutdown();
    },
  };
}
