// Status → color + tier → badge-tone helpers, ported from the prototype's
// ui.jsx. Pure (no JSX) so screens and primitives can share them.

export const STATUS_COLOR: Record<string, string> = {
  operational: 'var(--ok)',
  ok: 'var(--ok)',
  committed: 'var(--ok)',
  done: 'var(--ok)',
  approved: 'var(--ok)',
  acked: 'var(--ok)',
  info: 'var(--muted-2)',
  degraded: 'var(--amber)',
  warn: 'var(--amber)',
  parked: 'var(--amber)',
  pending: 'var(--amber)',
  retried: 'var(--amber)',
  recovered: 'var(--amber)',
  down: 'var(--err)',
  error: 'var(--err)',
  overdue: 'var(--err)',
  denied: 'var(--err)',
  expired: 'var(--muted-2)',
};

export function sColor(status: string): string {
  return STATUS_COLOR[status] ?? 'var(--muted-2)';
}

export type BadgeTone = 'neutral' | 'ok' | 'amber' | 'err' | 'accent';

export function tierTone(tier: string): BadgeTone {
  if (tier === 'confirm-before') return 'amber';
  if (tier === 'notify-after') return 'accent';
  return 'neutral';
}

/** Map a status color back to the matching badge tone (used by Cell). */
export function toneForStatus(status: string): BadgeTone {
  const c = sColor(status);
  if (c === 'var(--ok)') return 'ok';
  if (c === 'var(--amber)') return 'amber';
  if (c === 'var(--err)') return 'err';
  return 'neutral';
}
