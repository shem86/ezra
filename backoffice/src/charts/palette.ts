// Series colours for charts — deliberately NOT the UI's semantic tokens.
//
// The console previously drew its four cost series with `--ok`, `--accent`,
// `--amber` and `--muted-2`. Validated against the console surface (#fffdfa)
// that set fails three ways: `--muted-2` is chroma 0.01 (reads as grey, i.e.
// "no data"), `--amber` sits at 2.01:1 contrast, and worst, `--accent` against
// `--ok` separates by only ΔE 6.1 for deuteranopia — and those two are exactly
// "fresh input" vs "cache read", the one comparison the token-economics widget
// exists to make.
//
// The set below passes all five checks (lightness band, chroma floor, CVD
// separation, normal-vision floor, contrast ≥ 3:1) on that surface. Terracotta
// is stepped darker than the brand `--accent` so it can carry a series without
// colliding with the gold. Values live in styles.css as `--chart-1..4`; these
// names are the indirection so a mark never hard-codes a hex.
//
// Order is fixed and assigned by identity, never by rank — a filter that drops
// a series must not repaint the survivors.

export const SERIES = {
  /** #0f74c5 light / #3b90e0 dark */
  freshInput: 'var(--chart-1)',
  /** #b38d00 light / #b48e00 dark */
  cacheWrite: 'var(--chart-2)',
  /** #94468f light / #af5ca9 dark */
  output: 'var(--chart-3)',
  /** #8c3d12 light / #ae532d dark */
  cacheRead: 'var(--chart-4)',
} as const;

/**
 * Cost/usage-type name (as the API spells it) → its fixed series colour.
 * The API's own `color` field is ignored: it carries the old semantic tokens.
 */
export const USAGE_COLORS: Record<string, string> = {
  'Cache read': SERIES.cacheRead,
  'Fresh input': SERIES.freshInput,
  'Cache write': SERIES.cacheWrite,
  Output: SERIES.output,
};

export function usageColor(name: string): string {
  return USAGE_COLORS[name] ?? 'var(--muted-2)';
}

/** Status colours are reserved for state and never reused as a series hue. */
export const STATUS = {
  ok: 'var(--ok)',
  warn: 'var(--amber)',
  err: 'var(--err)',
} as const;
