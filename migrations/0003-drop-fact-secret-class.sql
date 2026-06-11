-- Remove the user-facing secret-fact class (docs/adr-0001). As built it was
-- write-only: get_fact withheld the value and the chat is the only read
-- surface, so a stored secret could never be used by anyone. "Secret-class"
-- now refers solely to operational credentials (API keys, OAuth tokens,
-- Baileys session state), which never enter the model path by construction.
ALTER TABLE household_facts DROP COLUMN is_secret;
