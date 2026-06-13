// The agent runs on the builder's personal WhatsApp number (not a dedicated
// bot account), so WhatsApp attributes every outbound message to the builder
// himself — the wife cannot tell an automated message from one the builder
// typed. A leading marker on the wire text is the ONLY signal that survives
// that shared identity (the participant name can't differ from the builder's).
//
// This is a wire-presentation concern, applied at the transport boundary only:
// the journaled assistant turn and the model context stay clean, so the marker
// never re-enters reasoning or Langfuse traces. It is also decoupled from
// echo suppression — that keys on sent message ids (see ingest.ts), never on
// this text — so the marker is purely cosmetic and carries no correctness load.

/** Prepended to every agent-originated message on the wire. Static (no clock,
 * counter, or randomness) so it is safe inside the durable send steps. */
export const AGENT_MARKER = '🤖 ';

/**
 * Render outbound text with the agent marker. Idempotent: text that already
 * begins with the marker is returned unchanged, so re-rendering a message
 * (e.g. a retried send) never stacks markers.
 */
export function markAgentText(text: string): string {
  return text.startsWith(AGENT_MARKER) ? text : `${AGENT_MARKER}${text}`;
}
