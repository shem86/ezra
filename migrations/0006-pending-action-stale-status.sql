-- T35: an approved action that fails revalidation at execute time ends as
-- 'stale' — distinct from 'expired' (nobody answered before the TTL) so the
-- audit trail and T37's expiry surfacing never conflate the two.
ALTER TABLE pending_actions DROP CONSTRAINT pending_actions_status_check;
ALTER TABLE pending_actions ADD CONSTRAINT pending_actions_status_check
  CHECK (status IN ('pending', 'approved', 'denied', 'executed', 'expired', 'stale'));
