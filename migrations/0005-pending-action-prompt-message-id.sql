-- T34: persist the approval prompt's outbound message id with the action it
-- proposes. WhatsApp quoted replies carry the quoted message's id, so this
-- column is what lets T35 bind a quoted "yes" to the right action even with
-- several outstanding. Nullable: the id exists only after the send succeeds,
-- so park inserts NULL and the composer stamps it post-send.
ALTER TABLE pending_actions ADD COLUMN prompt_message_id text;
