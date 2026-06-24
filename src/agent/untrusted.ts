// Untrusted-content boundary (ADR-0005, docs/untrusted-content-spec.md).
// Third-party text — calendar event data, recalled history, stored facts —
// reaches the turn model wrapped so the model treats it as DATA, never
// instructions. Provenance separation, not content inspection: this helper
// marks a span by where it came from; the system-prompt rule (src/agent/
// prompts.ts) tells the model what the marker means. Pure string-in/string-out,
// so no DI seam and nothing to journal.
//
// The boundary is ADVISORY (LLM-enforced), not a sandbox — but the ONE thing
// this helper must guarantee structurally is that fenced content cannot forge
// the close marker and "break out" to smuggle trailing text past the fence.
// That is why the close literal is scrubbed from everything we wrap.

// Guillemets are vanishingly rare in WhatsApp Hebrew/English, so collision with
// genuine content is near-zero; the scrub below covers the residual case. The
// open marker carries the source label: `«untrusted:calendar»`.
export const UNTRUSTED_OPEN = '«untrusted:';
export const UNTRUSTED_CLOSE = '«/untrusted»';

// What a forged close marker is rewritten to — visibly inert, never matches
// UNTRUSTED_CLOSE, and honest in traces about what happened.
const NEUTRALIZED_CLOSE = '(fence marker removed)';

/** Replace every literal close marker so the wrapped text can't end the fence early. */
function scrub(text: string): string {
  return text.split(UNTRUSTED_CLOSE).join(NEUTRALIZED_CLOSE);
}

/**
 * Wrap third-party `body` as data the model must not obey. `source` is a short
 * provenance label (e.g. 'calendar', 'recalled', 'stored-fact'). Both source and
 * body are scrubbed of the close marker, so the only structural close in the
 * output is the framing one this function appends — including under double-wrap.
 */
export function fenceUntrusted(source: string, body: string): string {
  return `${UNTRUSTED_OPEN}${scrub(source)}»\n${scrub(body)}\n${UNTRUSTED_CLOSE}`;
}
