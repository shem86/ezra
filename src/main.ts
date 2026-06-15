// Production composition (T42): the real spine in one process — Baileys
// transport → ingestion (allowlist, durable-enqueue) → conversation lane
// (debounce, concurrency-1) → handleTurn → reply out — plus the M2 ops
// pieces (health alerts, dead-man ping) and both scheduled sweeps. This is
// dev/main.ts's composition with the scripted day replaced by the real
// socket; the step/workflow wiring is deliberately identical so everything
// the integration suite proved carries over.
//
// DBOS ordering is load-bearing (dbos.md): datasource + workflow + scheduled
// registration BEFORE launch; queue registration AFTER launch.
// REAL WhatsApp traffic and REAL model calls — never CI, never tests.

import { DBOS, SchedulerMode } from '@dbos-inc/dbos-sdk';
import { NodePostgresDataSource } from '@dbos-inc/node-pg-datasource';
import { createAnthropic } from '@ai-sdk/anthropic';
import { Client } from 'pg';
import { loadProductionConfig } from './ops/config.js';
import { makeTracer } from './ops/tracing.js';
import { makeLangfuseSink } from './ops/langfuse-sink.js';
import { createTelegramAlertChannel } from './ops/alerts.js';
import { createHealthMonitor } from './ops/health.js';
import { createDeadmanPinger } from './ops/deadman.js';
import { registerTransactionalStep } from './orchestration/steps.js';
import { resumeStrandedWorkflows } from './orchestration/recovery.js';
import { createIngestion, ingestWorkflowId } from './orchestration/ingest.js';
import {
  makeConversationEnqueueWorkflow,
  makeDrainWorkflow,
  registerConversationQueue,
  type ConversationEnqueue,
} from './orchestration/queue.js';
import { makeReminderSweepWorkflow, type DueReminder } from './orchestration/scheduled.js';
import { makeExpirySweepWorkflow, toOverdueActions } from './hitl/expiry.js';
import { markExpired } from './hitl/pending-actions.js';
import { makeHandleTurnWorkflow } from './agent/handle-turn.js';
import { makeCallModel } from './agent/call-model.js';
import { makeProductionSystemPrompt, type PendingActionDigestEntry } from './agent/prompts.js';
import { makePark } from './hitl/park.js';
import { summarizeToolCall, toDigestEntries } from './hitl/digest.js';
import { sendApprovalPrompts } from './hitl/approval-prompt.js';
import {
  makeResolveApprovalReply,
  makeResolveClassifiedDecision,
} from './hitl/resolve-approval.js';
import { makeRefineAction } from './hitl/refine-action.js';
import { makeClassifyRelatedness } from './agent/relatedness.js';
import { defaultCompactionConfig, makeSummarize } from './agent/compaction.js';
import { parseTurnMessages, type TurnMessage } from './agent/context.js';
import { runMigrations } from './memory/migrate.js';
import {
  getDueReminders,
  getPendingInbox,
  getPendingActionsForConversation,
  getOverduePendingActions,
  getSentEntry,
  insertInboxItem,
  loadContext,
  markInboxProcessed,
  markReminderFired,
  recordSend,
  saveContext,
  type InboxItem,
} from './memory/store.js';
import { writeSemanticMemory, type SemanticMemoryInput } from './memory/semantic.js';
import { makeVoyageEmbedder } from './memory/embedder.js';
import { makeV1ToolRegistry } from './tools/index.js';
import { makeGoogleCalendarClient } from './tools/calendar-client.js';
import { makeRunTool, toToolSet } from './tools/registry.js';
import { createBaileysTransport } from './transport/baileys.js';
import { createSessionStore } from './transport/session-store.js';
import { computeHumanSendDelay } from './transport/protocol.js';
import {
  deliverReply,
  makeResilientSend,
  replySendId,
  selectSendClass,
} from './transport/send-class.js';

async function main(): Promise<void> {
  const config = loadProductionConfig();
  await runMigrations({ databaseUrl: config.databaseUrl });

  // --- Observability + independent alerting (T31, T12) ----------------------
  const sink = makeLangfuseSink({
    publicKey: config.langfusePublicKey,
    secretKey: config.langfuseSecretKey,
    baseUrl: config.langfuseBaseUrl,
  });
  const tracer = makeTracer({ sink, getTraceId: () => DBOS.workflowID });
  const alertChannel = createTelegramAlertChannel({
    botToken: config.alertChannelToken,
    chatId: config.alertChannelChatId,
  });
  const health = createHealthMonitor({ alertChannel });
  const deadman = createDeadmanPinger({ pingUrl: config.deadmanPingUrl });

  // --- Model + tools (identical wiring to dev/main; prompt is the T42 one) --
  const anthropic = createAnthropic({ apiKey: config.anthropicApiKey });
  const registry = makeV1ToolRegistry();
  const calendarClient = makeGoogleCalendarClient({
    clientEmail: config.googleServiceAccount.clientEmail,
    privateKey: config.googleServiceAccount.privateKey,
    calendarIds: config.calendarIds,
  });
  const embedder = makeVoyageEmbedder({ apiKey: config.voyageApiKey });
  const callModel = makeCallModel({
    // Built once from start-time config — byte-stable for the process, which
    // is what the prompt cache needs (prompts.ts header note).
    systemPrompt: makeProductionSystemPrompt({ memberJids: config.memberJids }),
    model: anthropic(config.reasoningModelId),
    tools: toToolSet(registry),
    onUsage: tracer.onModelUsage,
  });

  // --- Transactional steps (T19 pattern, mirrors dev/main) ------------------
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
        toolDeps: { embedder, calendarClient },
        park: makePark({ ttlHours: config.approvalTtlHours }),
      }),
      registry,
    ),
  );
  const loadPendingDigestStep = registerTransactionalStep(
    dataSource,
    'loadPendingDigest',
    async (db, conversationId: string): Promise<PendingActionDigestEntry[]> =>
      toDigestEntries(await getPendingActionsForConversation(db, conversationId), registry),
  );
  const resolveApprovalStep = registerTransactionalStep(
    dataSource,
    'resolveApproval',
    makeResolveApprovalReply(registry, { toolDeps: { embedder, calendarClient } }),
  );
  const resolveClassifiedStep = registerTransactionalStep(
    dataSource,
    'resolveClassified',
    makeResolveClassifiedDecision(registry, { toolDeps: { embedder, calendarClient } }),
  );
  const refineActionStep = registerTransactionalStep(
    dataSource,
    'refineAction',
    makeRefineAction(registry),
  );
  const writeMemoryStep = registerTransactionalStep(
    dataSource,
    'writeSemanticMemory',
    async (db, input: SemanticMemoryInput): Promise<boolean> => writeSemanticMemory(db, input),
  );

  // --- The turn workflow (T22 seam) ------------------------------------------
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
      summarizeProposal: (call) => summarizeToolCall(registry, call.name, call.args),
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

  // --- Transport (declared early: the reply step below closes over it) ------
  const transport = createBaileysTransport({
    sessionStore: createSessionStore({ dir: config.waSessionDir }),
  });
  transport.onStateChange((state) => health.onStateChange(state));
  // Plain client for reply-path reads and prompt stamping inside steps —
  // same pattern as dev/main's post-turn reads.
  const replyDb = new Client({ connectionString: config.databaseUrl });

  // PROX-SEND-001: a proactive at-least-once send can fire from the scheduled
  // sweep before Baileys reconnects on restart; without this the bare send
  // throws `transport not connected` and the turn workflow errors terminally,
  // dropping the reminder. The wrapper waits out a transient disconnect with
  // bounded backoff. Both the reply path (deliverReplyDeps.send) and the
  // approval-prompt path (sendApprovalPrompts) flow through jitteringSend, so
  // both inherit resilience.
  const resilientSend = makeResilientSend(
    (message) => transport.send(message),
    undefined,
    undefined,
    ({ attempt, delayMs, elapsedMs, error }) => {
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(
        `[send] transient failure (${reason}) on attempt ${attempt} (elapsed ${elapsedMs}ms); retrying in ${delayMs}ms`,
      );
    },
  );

  // Human send-jitter (T13/T43): no production message leaves at machine speed.
  // Only ever called from inside a send STEP (never a workflow body), so the
  // random delay + timer are journaled, not re-run on replay (dbos.md). Jitter
  // once, then the resilient send retries the raw send without re-jittering.
  const jitteringSend = async (message: {
    conversationId: string;
    text: string;
  }): Promise<{ messageId: string }> => {
    await new Promise((resolve) => setTimeout(resolve, computeHumanSendDelay()));
    return resilientSend(message);
  };

  // --- Conversation lane: inbox steps, turn batches, drain, enqueue (T21) ---
  const insertItemStep = registerTransactionalStep(dataSource, 'insertInboxItem', insertInboxItem);
  const readPendingStep = registerTransactionalStep(dataSource, 'getPendingInbox', getPendingInbox);
  const markProcessedStep = registerTransactionalStep(
    dataSource,
    'markInboxProcessed',
    markInboxProcessed,
  );

  // One batch → one turn → one reply. The turn id derives from the batch's
  // leading message id, so a drain replay lands on the SAME turn workflow
  // instead of running the model twice. The reply rides a step (T43): its send
  // class is chosen from the lead item — a reminder firing (sender 'system') is
  // at-least-once, a human reply is at-most-once — and `deliverReply` does the
  // sent_log log/send ordering, keyed on a deterministic send id so a step
  // replay lands on the same row instead of an undeduped second send.
  const deliverReplyDeps = {
    recordSend: (input: Parameters<typeof recordSend>[1]) => recordSend(replyDb, input),
    getSentEntry: (key: string) => getSentEntry(replyDb, key),
    send: jitteringSend,
  };
  const processTurnBatch = DBOS.registerWorkflow(
    async function processTurnBatch(batch: InboxItem[]): Promise<void> {
      const first = batch[0];
      if (first === undefined) return;
      const conversationId = first.conversationId;
      const handle = await DBOS.startWorkflow(handleTurn, {
        workflowID: `turn-${first.messageId}`,
      })(conversationId, batch);
      const result = await handle.getResult();

      if (result.status === 'parked') {
        // The closing transcript message IS the approval prompt; it must go
        // through the stamping path so prompt_message_id is persisted (the
        // quoted-reply anchor), never as a plain reply. At-least-once by
        // construction: the unstamped pending row is the durable to-send marker.
        await DBOS.runStep(
          async () => {
            // Same human jitter as the reply path — approval prompts are
            // conversational closing messages, not machine-speed pings.
            await sendApprovalPrompts(replyDb, { send: jitteringSend }, conversationId, registry);
          },
          { name: 'sendApprovalPrompts' },
        );
        return;
      }
      await DBOS.runStep(
        async () => {
          const transcript = parseTurnMessages(await loadContext(replyDb, conversationId));
          const reply = transcript.filter((m) => m.role === 'assistant').at(-1);
          if (reply === undefined || reply.content === '') return;
          await deliverReply(deliverReplyDeps, {
            sendClass: selectSendClass(first),
            idempotencyKey: replySendId(first),
            conversationId,
            text: reply.content,
          });
        },
        { name: 'sendReply' },
      );
    },
    { name: 'processTurnBatch' },
  );

  const drainWorkflow = DBOS.registerWorkflow(
    makeDrainWorkflow({
      readPending: readPendingStep,
      processBatch: processTurnBatch,
      markProcessed: markProcessedStep,
    }),
    { name: 'drainConversation' },
  );
  const enqueueWorkflow = DBOS.registerWorkflow(
    makeConversationEnqueueWorkflow({ insertItem: insertItemStep, drainWorkflow }),
    { name: 'enqueueConversationItem' },
  );

  // --- Scheduled sweeps (ledger #3: registered HERE, not just in fixtures) --
  // Both are state-scans with guarded flips, so a missed tick self-heals on
  // the next one (at-least-once by design — M6 entry note). WhenActive: no
  // make-up backfill storm after downtime; the scan covers the gap anyway.
  const getDueStep = registerTransactionalStep(
    dataSource,
    'getDueReminders',
    async (db, asOfMs: number): Promise<DueReminder[]> =>
      (await getDueReminders(db, new Date(asOfMs))).map((reminder) => ({
        id: reminder.id,
        conversationId: reminder.conversationId,
        body: reminder.body,
        dueAtIso: reminder.dueAt.toISOString(),
      })),
  );
  const markFiredStep = registerTransactionalStep(
    dataSource,
    'markReminderFired',
    markReminderFired,
  );
  const reminderSweep = DBOS.registerWorkflow(
    makeReminderSweepWorkflow({ getDue: getDueStep, markFired: markFiredStep, enqueueWorkflow }),
    { name: 'reminderSweep' },
  );
  DBOS.registerScheduled(reminderSweep, {
    crontab: '0 * * * * *', // every minute — reminders are minute-granular
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
    name: 'reminderSweep',
  });

  const getOverdueStep = registerTransactionalStep(
    dataSource,
    'getOverduePendingActions',
    async (db, asOfMs: number) => toOverdueActions(await getOverduePendingActions(db, asOfMs)),
  );
  const markExpiredStep = registerTransactionalStep(dataSource, 'markExpired', markExpired);
  const expirySweep = DBOS.registerWorkflow(
    makeExpirySweepWorkflow({
      getOverdue: getOverdueStep,
      markExpired: markExpiredStep,
      enqueueWorkflow,
    }),
    { name: 'expirySweep' },
  );
  DBOS.registerScheduled(expirySweep, {
    crontab: '0 */5 * * * *', // every 5 minutes — TTL is hours-scale (12h)
    mode: SchedulerMode.ExactlyOncePerIntervalWhenActive,
    name: 'expirySweep',
  });

  // --- Ingestion: validate → allowlist → echo-filter → durable enqueue → ack
  const householdConversations = new Set(config.householdConversations);
  const ingest = createIngestion({
    enqueueDurably: async (message) => {
      const item: ConversationEnqueue = {
        conversationId: message.conversationId,
        kind: 'human',
        senderId: message.senderId,
        messageId: message.id,
        payload: {
          text: message.text,
          ...(message.quotedMessageId === null
            ? {}
            : { quotedMessageId: message.quotedMessageId }),
        },
      };
      const handle = await DBOS.startWorkflow(enqueueWorkflow, {
        workflowID: ingestWorkflowId(message.id),
      })(item);
      await handle.getResult();
    },
    // Echoes are already suppressed at the adapter by sent-id tracking (T11);
    // the durable sent_log-backed check arrives with T43's send classes.
    wasSentByBot: () => false,
    isHouseholdConversation: (conversationId) => householdConversations.has(conversationId),
  });
  transport.onMessage((message, ack) => {
    // senderId shown raw on purpose: it is the exact value WA_JID_* in .env
    // must contain for member attribution (prompts.ts) — names hide it, and
    // the group can deliver a JID form (@lid vs @s.whatsapp.net) that differs
    // from what's configured. Mirrors the manual runner's [inbound] line.
    const sender =
      message.senderName === null
        ? message.senderId
        : `${message.senderId} (${message.senderName})`;
    const preview = message.text.length > 80 ? `${message.text.slice(0, 80)}…` : message.text;
    console.log(`[inbound] chat=${message.conversationId} sender=${sender}: ${preview}`);
    void ingest(message, ack).then((outcome) => {
      if (outcome.outcome === 'enqueue-failed') {
        console.error(`ingest enqueue failed for ${message.id}:`, outcome.error);
      }
    });
  });

  // --- Launch (order per dbos.md), then connect the outside world ------------
  await NodePostgresDataSource.initializeDBOSSchema({
    connectionString: config.databaseUrl,
  });
  DBOS.setConfig({ name: 'hh-assistant', systemDatabaseUrl: config.databaseUrl });
  await DBOS.launch();
  await registerConversationQueue();
  // Ledger #1: rescue work stranded by the previous generation's crash —
  // AFTER launch so every datasource is initialized (the race the
  // per-generation executor id in start.ts exists to dodge).
  const resumed = await resumeStrandedWorkflows();
  if (resumed.length > 0) {
    console.log(`launch-recovery: resumed ${resumed.length} stranded workflow(s)`);
  }

  await replyDb.connect();
  await transport.connect();
  deadman.start();
  console.log(
    `ezra up: serving ${config.householdConversations.length} conversation(s), sweeps scheduled, dead-man pinging`,
  );

  // --- Graceful shutdown ------------------------------------------------------
  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received — shutting down`);
    deadman.stop();
    health.stop();
    await transport.disconnect().catch(() => {});
    await replyDb.end().catch(() => {});
    await sink.flush().catch(() => {});
    // Grace period: 4.19.x queue registration can race pool teardown (dbos.md).
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await DBOS.shutdown();
    process.exit(0);
  }
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

await main();
