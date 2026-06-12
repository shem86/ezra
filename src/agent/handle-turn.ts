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
  extractMessageText,
  extractQuotedReply,
  toModelMessages,
  type AssistantMessage,
  type BatchItem,
  type ToolCall,
  type ToolResult,
  type TurnMessage,
} from './context.js';
import type {
  ApprovalOutcome,
  ApprovalReplyInput,
  ClassifiedDecisionInput,
} from '../hitl/resolve-approval.js';
import type { RefineActionInput, RefineOutcome } from '../hitl/refine-action.js';
import type { ClassifyInput, RelatednessVerdict } from './relatedness.js';
import {
  buildCompactedTranscript,
  findCompactionCut,
  renderForSummary,
  shouldCompact,
  type CompactionConfig,
} from './compaction.js';
import {
  renderApprovalOutcome,
  renderApprovalPrompt,
  renderPendingActionsDigest,
  type PendingActionDigestEntry,
} from './prompts.js';

export interface ModelCallOptions {
  /** Cap-hit recovery: the model must answer with a user-facing message, no tools. */
  readonly forceFinal: boolean;
  /**
   * Rendered pending-actions digest for this turn, or null/absent for none.
   * Travels as a post-prefix system block so the stable prompt's cache
   * breakpoint survives digest changes (T32 discipline, live since T34).
   */
  readonly digest?: string | null;
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
   * Journaled read of the conversation's still-pending confirm-before
   * actions (must be a registered step/transaction like loadContext —
   * workflow determinism). Absent ⇒ no digest, the pre-T34 behavior.
   */
  readonly loadPendingDigest?: (conversationId: string) => Promise<PendingActionDigestEntry[]>;
  /**
   * T35 approval resolution for quoted replies — must be a registered
   * datasource transaction (the guard flip, revalidation verdict, and tool
   * effect co-commit inside it). Absent ⇒ quoted replies are normal turns.
   */
  readonly resolveApproval?: (input: ApprovalReplyInput) => Promise<ApprovalOutcome>;
  /**
   * T36 relatedness routing for non-quoted messages (and quoted-but-unclear
   * replies) while actions pend. Absent ⇒ every such message is a normal
   * turn, the pre-T36 behavior.
   */
  readonly relatedness?: RelatednessDeps;
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
  /** Absent ⇒ no compaction (the T22 skeleton behavior, unchanged). */
  readonly compaction?: CompactionDeps;
}

export interface RelatednessDeps {
  /** Plain async (model I/O) — the workflow wraps each call in DBOS.runStep. */
  readonly classify: (input: ClassifyInput) => Promise<RelatednessVerdict>;
  /**
   * Registered datasource transactions like resolveApproval — the settle and
   * the refine each co-commit with their step checkpoint.
   */
  readonly resolveDecision: (input: ClassifiedDecisionInput) => Promise<ApprovalOutcome>;
  readonly refine: (input: RefineActionInput) => Promise<RefineOutcome>;
}

export interface CompactionDeps extends CompactionConfig {
  /** Plain async — the workflow wraps it in DBOS.runStep (summary journaled). */
  readonly summarize: (head: readonly TurnMessage[]) => Promise<string>;
  /** Plain async — wrapped in DBOS.runStep (external I/O, outside any transaction). */
  readonly embedSummary: (summary: string) => Promise<number[]>;
  /**
   * Must already be a registered datasource transaction (like persistContext)
   * and idempotent on sourceKey — recovery replay re-calls it.
   */
  readonly writeMemory: (input: {
    readonly conversationId: string;
    readonly content: string;
    readonly embedding: number[];
    readonly sourceKey: string;
  }) => Promise<boolean>;
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
    // Snapshot for the classifier prompt BEFORE the batch lands: the new
    // message rides separately, the tail is its conversational context.
    // Pure render over journaled input — replay-deterministic.
    const recentContext = renderForSummary(msgs.slice(-6));
    msgs.push(...toModelMessages(batch));

    // Quoted approval replies resolve BEFORE the digest read, so the digest
    // the model sees this turn already reflects what just settled. The real
    // outcome enters as a NEW context message — the parked tool_use was
    // answered once in the parking turn and stays answered (decision 10).
    // Outcomes are kept per item: explicit binding takes precedence over the
    // T36 classifier below, and an unclear-but-bound reply hands the
    // classifier its target.
    const quotedOutcomes = new Map<number, ApprovalOutcome>();
    if (deps.resolveApproval !== undefined) {
      for (const [i, item] of batch.entries()) {
        const quoted = extractQuotedReply(item);
        if (quoted === null) continue;
        const outcome = await deps.resolveApproval({
          conversationId,
          quotedMessageId: quoted.quotedMessageId,
          text: quoted.text,
        });
        quotedOutcomes.set(i, outcome);
        // Rendered from the journaled step output + workflow input only —
        // replay regenerates the identical message.
        const update = renderApprovalOutcome(outcome, item.senderId);
        if (update !== null) {
          msgs.push({ role: 'user', senderId: 'system:hitl', content: update });
        }
      }
    }

    let pendingEntries =
      deps.loadPendingDigest === undefined ? [] : await deps.loadPendingDigest(conversationId);

    // T36 relatedness routing. Target selection never guesses: a quoted but
    // unclear reply classifies against the action its quote bound (explicit
    // target, any pending count); a non-quoted or unbound message classifies
    // only when EXACTLY one action pends — with several, the message stays a
    // normal turn and the stable prompt has the model ask for a quoted reply.
    // No pending actions ⇒ no classifier call, no cost.
    const relatedness = deps.relatedness;
    let refinedReprompt: { actionId: string; toolName: string; summary: string } | null = null;
    if (relatedness !== undefined && pendingEntries.length > 0) {
      let pendingChanged = false;
      for (const [i, item] of batch.entries()) {
        const prior = quotedOutcomes.get(i);
        let target;
        if (prior !== undefined && prior.kind === 'unclear') {
          target = pendingEntries.find((e) => e.actionId === prior.actionId);
        } else if (prior === undefined || prior.kind === 'unbound') {
          target = pendingEntries.length === 1 ? pendingEntries[0] : undefined;
        }
        if (target === undefined) continue; // bound-and-settled, or ambiguous
        const text = extractMessageText(item);
        if (text === null) continue; // only a person's utterance classifies
        const action = { toolName: target.toolName, summary: target.summary };
        const verdict = await DBOS.runStep(
          () =>
            relatedness.classify({ senderId: item.senderId, message: text, action, recentContext }),
          { name: 'classifyRelatedness' },
        );

        if (verdict.kind === 'approve' || verdict.kind === 'deny') {
          const outcome = await relatedness.resolveDecision({
            conversationId,
            actionId: target.actionId,
            decision: verdict.kind,
          });
          const update = renderApprovalOutcome(outcome, item.senderId);
          if (update !== null) {
            msgs.push({ role: 'user', senderId: 'system:hitl', content: update });
          }
          pendingChanged = true;
          break; // the targeted action settled — nothing left to classify against
        }
        if (verdict.kind === 'refine') {
          const outcome = await relatedness.refine({
            conversationId,
            actionId: target.actionId,
            updatedArgs: verdict.updatedArgs,
          });
          if (outcome.kind === 'refined') {
            refinedReprompt = outcome;
            pendingChanged = true;
            break; // the turn closes with the re-prompt below
          }
          if (outcome.kind === 'already-resolved') {
            const update = renderApprovalOutcome(outcome, item.senderId);
            if (update !== null) {
              msgs.push({ role: 'user', senderId: 'system:hitl', content: update });
            }
            pendingChanged = true;
            break;
          }
          // invalid/unbound: action untouched, normal turn — never auto-deny
        }
        // unrelated: normal turn, action untouched (decision 10 names this)
      }
      if (pendingChanged && deps.loadPendingDigest !== undefined) {
        pendingEntries = await deps.loadPendingDigest(conversationId);
      }
    }

    if (refinedReprompt !== null) {
      // Refine re-prompts like a park: a deterministic closing message built
      // from the journaled refine outcome, no model rounds. The refine
      // transaction cleared prompt_message_id, so the composer's unstamped-
      // row marker re-sends this prompt and re-stamps the binding anchor.
      msgs.push({
        role: 'assistant',
        content: renderApprovalPrompt(refinedReprompt),
        toolCalls: [],
      });
      await deps.persistContext(conversationId, msgs);
      return { status: 'parked', rounds: 0 };
    }

    // Read after all resolution: a park created mid-turn ends the turn
    // anyway, so the digest can't go stale within one. Rendering is pure.
    const digest = renderPendingActionsDigest(pendingEntries);

    let status: TurnStatus = 'cap-hit';
    let rounds = 0;
    for (let i = 0; i < maxRounds; i++) {
      const assistant = await DBOS.runStep(
        () => deps.callModel(msgs, { forceFinal: false, digest }),
        { name: 'callModel' },
      );
      rounds += 1;
      msgs.push(assistant);
      if (assistant.toolCalls.length === 0) {
        status = 'completed';
        break;
      }

      let parked = false;
      const parkedCalls: Array<{ readonly call: ToolCall; readonly actionId: string }> = [];
      for (const call of assistant.toolCalls) {
        const result = await deps.runTool(call, conversationId);
        // ALWAYS answer — an unanswered tool_use errors the next model call.
        msgs.push({ role: 'tool', toolUseId: result.toolUseId, content: result.content });
        if (result.parked) {
          parked = true;
          if (result.actionId !== undefined) {
            parkedCalls.push({ call, actionId: result.actionId });
          }
        }
      }
      if (parked) {
        // Fire-and-fold: end the turn and free the slot; the real outcome
        // re-enters a fresh turn as a new context message, never a second
        // tool_result for this tool_use. The turn closes with one approval
        // prompt per parked action — rendered from journaled values only
        // (the assistant message holds the call), so replay regenerates the
        // identical closing message; the composer sends it and stamps its
        // receipt as prompt_message_id.
        for (const { call, actionId } of parkedCalls) {
          msgs.push({
            role: 'assistant',
            content: renderApprovalPrompt({
              actionId,
              toolName: call.name,
              summary: JSON.stringify(call.args),
            }),
            toolCalls: [],
          });
        }
        status = 'parked';
        break;
      }
    }

    if (status === 'cap-hit') {
      const finalMessage = await DBOS.runStep(
        () => deps.callModel(msgs, { forceFinal: true, digest }),
        { name: 'callModelForcedFinal' },
      );
      if (finalMessage.toolCalls.length > 0) {
        // A tool call here would go unanswered forever — fail loud instead
        // of persisting a transcript that errors every later turn.
        throw new Error('handleTurn: forced-final model call returned tool calls');
      }
      msgs.push(finalMessage);
    }

    // The full transcript persists BEFORE compaction: a failing summarize/embed
    // must never hold the turn's substance hostage (the chat would brick on a
    // side feature). Failure mode is a long transcript + loud workflow error;
    // the next over-threshold turn simply retries.
    await deps.persistContext(conversationId, msgs);

    const compaction = deps.compaction;
    if (compaction !== undefined && shouldCompact(msgs, compaction)) {
      const cut = findCompactionCut(msgs, compaction);
      if (cut !== null) {
        const workflowId = DBOS.workflowID;
        if (workflowId === undefined) {
          throw new Error('handleTurn: no workflowID — compaction needs it for the idempotency key');
        }
        const head = msgs.slice(0, cut);
        const summary = await DBOS.runStep(() => compaction.summarize(head), {
          name: 'summarizeContext',
        });
        const embedding = await DBOS.runStep(() => compaction.embedSummary(summary), {
          name: 'embedSummary',
        });
        // Keyed on the workflowID (≤ one compaction per turn): a crash-replay
        // re-derives the same key and the write is a no-op, never a duplicate.
        await compaction.writeMemory({
          conversationId,
          content: summary,
          embedding,
          sourceKey: `compact-${workflowId}`,
        });
        await deps.persistContext(
          conversationId,
          buildCompactedTranscript(summary, msgs.slice(cut)),
        );
      }
    }

    return { status, rounds };
  };
}
