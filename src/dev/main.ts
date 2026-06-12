// pnpm dev (T32): the composing caller — the ONE place Config, provider,
// registry, tracer, compaction, and the handleTurn workflow meet (the M4
// gate's runway). Runs the scripted day against the dev DB with the stub
// transport carrying replies. REAL model calls — costs money, never CI.
//
// DBOS ordering here is load-bearing (dbos.md): datasource + workflow
// registration BEFORE launch; initializeDBOSSchema before launch; replies
// read back through plain pg AFTER each turn completes.

import { DBOS } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { createAnthropic } from '@ai-sdk/anthropic';
import { Client } from 'pg';
import { loadConfig } from '../ops/config.js';
import { makeTracer } from '../ops/tracing.js';
import { makeLangfuseSink } from '../ops/langfuse-sink.js';
import { registerTransactionalStep } from '../orchestration/steps.js';
import { makeHandleTurnWorkflow } from '../agent/handle-turn.js';
import { makeCallModel } from '../agent/call-model.js';
import { stableSystemPrompt, type PendingActionDigestEntry } from '../agent/prompts.js';
import { makePark } from '../hitl/park.js';
import { toDigestEntries } from '../hitl/digest.js';
import { sendApprovalPrompts } from '../hitl/approval-prompt.js';
import { makeResolveApprovalReply } from '../hitl/resolve-approval.js';
import { defaultCompactionConfig, makeSummarize } from '../agent/compaction.js';
import { parseTurnMessages, type TurnMessage } from '../agent/context.js';
import { runMigrations } from '../memory/migrate.js';
import { getPendingActionsForConversation, loadContext, saveContext } from '../memory/store.js';
import { writeSemanticMemory, type SemanticMemoryInput } from '../memory/semantic.js';
import { makeVoyageEmbedder } from '../memory/embedder.js';
import { makeHouseholdToolRegistry } from '../tools/index.js';
import { makeRunTool, toToolSet } from '../tools/registry.js';
import { createStubTransport } from '../transport/stub.js';
import { scriptedDay } from './scripted-day.js';

async function main(): Promise<void> {
  const config = loadConfig();
  await runMigrations({ databaseUrl: config.databaseUrl });

  // --- Observability: Langfuse sink + tracer (T31) -------------------------
  const sink = makeLangfuseSink({
    publicKey: config.langfusePublicKey,
    secretKey: config.langfuseSecretKey,
    baseUrl: config.langfuseBaseUrl,
  });
  const tracer = makeTracer({ sink, getTraceId: () => DBOS.workflowID });

  // --- Model (T25; Sonnet-only per ADR-0003 — Haiku stays for summarize) ----
  const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });
  const registry = makeHouseholdToolRegistry();
  const embedder = makeVoyageEmbedder({ apiKey: config.voyageApiKey });
  const callModel = makeCallModel({
    // Stable prefix only — the pending-actions digest rides per call as the
    // post-prefix system block (T34).
    systemPrompt: stableSystemPrompt,
    model: anthropic(config.reasoningModelId),
    tools: toToolSet(registry),
    onUsage: tracer.onModelUsage,
  });

  // --- Transactional steps (T19 pattern) ------------------------------------
  const dataSource = new NodePostgresDataSource('app-db', {
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
    tracer.traceRunTool(
      makeRunTool(registry, {
        toolDeps: { embedder },
        // Production park (T34). All v1 tools are autonomous, so this fires
        // only when a confirm-before tool lands (T40) — but the wiring is live.
        park: makePark({ ttlHours: config.approvalTtlHours }),
      }),
      registry,
    ),
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
    // T35: quoted-reply approvals — guard flip, revalidation, and the tool
    // effect co-commit in this one transaction. Live wiring; nothing parks
    // until a confirm-before tool lands (T40), same as the park seam above.
    makeResolveApprovalReply(registry, { toolDeps: { embedder } }),
  );
  const writeMemoryStep = registerTransactionalStep(
    dataSource,
    'writeSemanticMemory',
    async (db, input: SemanticMemoryInput): Promise<boolean> => writeSemanticMemory(db, input),
  );

  // --- The turn workflow (T22 seam, registered before launch) ---------------
  const handleTurn = DBOS.registerWorkflow(
    makeHandleTurnWorkflow({
      loadContext: loadContextStep,
      persistContext: persistContextStep,
      runTool: runToolStep,
      loadPendingDigest: loadPendingDigestStep,
      resolveApproval: resolveApprovalStep,
      callModel,
      compaction: {
        ...defaultCompactionConfig,
        summarize: tracer.traceStep(
          'summarizeContext',
          makeSummarize({ model: anthropic(config.cheapModelId) }),
        ),
        embedSummary: tracer.traceStep('embedSummary', async (summary: string) => {
          const [vector] = await embedder.embedDocuments([summary]);
          return vector!;
        }),
        writeMemory: writeMemoryStep,
      },
    }),
    { name: 'handleTurn' },
  );

  await NodePostgresDataSource.initializeDBOSSchema({
    connectionString: config.databaseUrl,
  });
  DBOS.setConfig({ name: 'hh-assistant-dev', systemDatabaseUrl: config.databaseUrl });
  await DBOS.launch();

  // --- Drive the scripted day, replies out through the stub transport -------
  const transport = createStubTransport();
  await transport.connect();
  const db = new Client({ connectionString: config.databaseUrl });
  await db.connect();

  // Unique per run: reruns must not share conversation state (testing.md).
  const runId = Date.now().toString(36);
  let turnSeq = 0;

  try {
    for (const conversation of scriptedDay) {
      const conversationId = `dev-${conversation.conversationKey}-${runId}`;
      console.log(`\n=== ${conversation.name} → ${conversationId}`);

      for (const message of conversation.messages) {
        console.log(`  ${message.senderId}: ${message.text}`);
        turnSeq += 1;
        const handle = await DBOS.startWorkflow(handleTurn, {
          workflowID: `turn-${runId}-${turnSeq}`,
        })(conversationId, [{ senderId: message.senderId, payload: { text: message.text } }]);
        const result = await handle.getResult();

        if (result.status === 'parked') {
          // The closing transcript message IS the approval prompt; send it
          // through the stamping path so prompt_message_id is persisted
          // (the quoted-reply anchor), never as a plain reply.
          const prompted = await sendApprovalPrompts(db, transport, conversationId);
          console.log(
            `  assistant [parked, ${result.rounds} round(s)]: approval prompt(s) sent for ${prompted.join(', ')}`,
          );
        } else {
          const transcript = parseTurnMessages(await loadContext(db, conversationId));
          const reply = transcript.filter((m) => m.role === 'assistant').at(-1);
          const text = reply === undefined || reply.content === '' ? '(no text)' : reply.content;
          await transport.send({ conversationId, text });
          console.log(`  assistant [${result.status}, ${result.rounds} round(s)]: ${text}`);
        }
      }
    }
    console.log(`\ndone: ${transport.sent.length} replies sent through the stub transport`);
  } finally {
    await sink.flush().catch((err: unknown) => {
      console.warn(`langfuse flush failed: ${String(err)}`);
    });
    await db.end();
    await transport.disconnect();
    // Grace period: 4.19.x queue registration can race pool teardown on
    // shutdown (dbos.md).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await DBOS.shutdown();
  }
}

await main();
