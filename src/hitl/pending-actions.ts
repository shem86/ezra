// Pending-action status transitions (T24): the execute-once guard lands in
// M3 even though full HITL (approval binding, revalidation, TTL GC) is M5.
// Duplicate approvals are duplicate EVENTS with distinct workflowIDs, so
// workflow dedupe cannot collapse them — these guarded row transitions are
// the single arbiter. Callers run them inside a datasource transaction
// (registerTransactionalStep) so the claim and the executed effect commit
// atomically.

import type { Queryable } from '../memory/store.js';

/** pending → approved. True only for the call that flipped it. */
export async function markApproved(db: Queryable, actionId: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE pending_actions SET status = 'approved' WHERE action_id = $1 AND status = 'pending' RETURNING action_id",
    [actionId],
  );
  return res.rows.length > 0;
}

/** pending → denied. True only for the call that flipped it. */
export async function markDenied(db: Queryable, actionId: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE pending_actions SET status = 'denied' WHERE action_id = $1 AND status = 'pending' RETURNING action_id",
    [actionId],
  );
  return res.rows.length > 0;
}

/**
 * approved → stale: the action survived to execution but failed its
 * revalidation check (T35) — terminal, never executed. Distinct from
 * 'expired' (unanswered past TTL) on purpose. True only for the flipping call.
 */
export async function markStale(db: Queryable, actionId: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE pending_actions SET status = 'stale' WHERE action_id = $1 AND status = 'approved' RETURNING action_id",
    [actionId],
  );
  return res.rows.length > 0;
}

/**
 * pending → expired: nobody answered before the TTL (T37's sweep). Terminal,
 * never executed — and pending-only, so expiry can never overwrite a settled
 * action and a racing approval beats the sweep cleanly. Distinct from
 * 'stale' (approved but failed revalidation). True only for the flipping call.
 */
export async function markExpired(db: Queryable, actionId: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE pending_actions SET status = 'expired' WHERE action_id = $1 AND status = 'pending' RETURNING action_id",
    [actionId],
  );
  return res.rows.length > 0;
}

/**
 * approved/executed → pending (T40 ledger #5): the settle core caught a
 * transient external failure mid-resolution, so the row goes back to
 * approvable — within the SAME transaction that flipped it, so it never
 * visibly left 'pending'. A re-approval retries; the TTL still bounds it.
 * Never valid from any settled status. True only for the flipping call.
 */
export async function returnToPending(db: Queryable, actionId: string): Promise<boolean> {
  const res = await db.query(
    "UPDATE pending_actions SET status = 'pending' WHERE action_id = $1 AND status IN ('approved', 'executed') RETURNING action_id",
    [actionId],
  );
  return res.rows.length > 0;
}

/** What the winning executor gets back: enough to run the parked tool call. */
export interface ClaimedAction {
  readonly actionId: string;
  readonly toolCall: unknown;
}

/**
 * approved → executed, single-winner. Postgres row locking serializes
 * concurrent claims; only the transaction that performs the flip gets the
 * row back, every other caller (duplicate approval, replayed step that
 * never committed — anything) gets null and must not execute.
 */
export async function claimForExecution(
  db: Queryable,
  actionId: string,
): Promise<ClaimedAction | null> {
  const res = await db.query(
    "UPDATE pending_actions SET status = 'executed' WHERE action_id = $1 AND status = 'approved' RETURNING action_id, tool_call",
    [actionId],
  );
  const row = res.rows[0];
  if (!row) return null;
  return { actionId: row.action_id as string, toolCall: row.tool_call };
}
