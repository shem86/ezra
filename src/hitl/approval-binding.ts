// Quoted-reply approval binding (T35, architecture decision 10): a reply
// that quotes an approval prompt is interpreted HERE, deterministically — a
// model never decides whether something was approved. The sets are
// deliberately narrow: anything hedged, qualified, or off-script is
// 'unclear', which degrades to a normal turn with the action untouched
// (never silently auto-deny — refinements and chatter are T36's job).

export type ApprovalReply = 'approve' | 'deny' | 'unclear';

const approveReplies = new Set([
  // English
  'yes',
  'y',
  'ok',
  'okay',
  'sure',
  'approve',
  'approved',
  'confirm',
  'confirmed',
  'do it',
  'go ahead',
  'yes please',
  '👍',
  // Hebrew
  'כן',
  'אישור',
  'אשר',
  'מאשר',
  'מאשרת',
  'בסדר',
  'אוקיי',
  'אוקי',
  'סבבה',
  'קדימה',
]);

const denyReplies = new Set([
  // English
  'no',
  'n',
  'nope',
  'deny',
  'denied',
  'decline',
  'declined',
  'cancel',
  "don't",
  'dont',
  'stop',
  'no thanks',
  '👎',
  // Hebrew
  'לא',
  'בטל',
  'תבטל',
  'בטלי',
  'עזוב',
  'עזבי',
  'לא תודה',
]);

/**
 * Strip edge punctuation (e.g. "yes!", "כן."), not symbols — 👍/👎 must
 * survive their own normalization — and collapse runs of whitespace so
 * multi-word entries match.
 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '')
    .replace(/\s+/g, ' ');
}

export function interpretApprovalReply(text: string): ApprovalReply {
  const trimmed = text.trim();
  // Exact emoji answers first: '👍' is Unicode Symbol, which normalize()
  // leaves alone, but checking pre-normalization keeps this independent of
  // how the punctuation stripping evolves.
  if (approveReplies.has(trimmed)) return 'approve';
  if (denyReplies.has(trimmed)) return 'deny';

  const normalized = normalize(trimmed);
  if (normalized.length === 0) return 'unclear';
  if (approveReplies.has(normalized)) return 'approve';
  if (denyReplies.has(normalized)) return 'deny';
  return 'unclear';
}
