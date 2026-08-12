// The two charts the Logs screen never had.
//
// Both are derived client-side from the turn rows the screen already fetches —
// no new endpoint. That bounds them honestly: they describe the fetched window
// (200 turns at most), not all of history. Widening that is a server change
// (`/api/logs` takes only `?limit` today), not a chart change.
import { barY, defineChart, dot, ruleY } from '@tanstack/charts';
import { tooltip } from '@tanstack/charts/tooltip';
import { scaleBand, scaleLinear, scaleUtc } from 'd3-scale';
import { EzraChart, motionOf } from './ezra-chart';
import { STATUS } from './palette';
import type { TurnRow } from '../api/types';

export interface VolumeBucket {
  /** Bucket start as an ISO string — also the reconcile key. */
  hour: string;
  label: string;
  level: TurnRow['level'];
  count: number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Bucket widths we're willing to draw, coarsest-last. */
const UNITS = [MINUTE, 5 * MINUTE, 15 * MINUTE, HOUR, 6 * HOUR, DAY] as const;

/** Aim for this many buckets across the observed span. */
const TARGET_BUCKETS = 24;
/**
 * Never draw fewer than this. A window where every turn lands in one bucket
 * would otherwise render as a single slab spanning the whole plot, which reads
 * as a broken chart rather than as "one busy minute".
 */
const MIN_BUCKETS = 8;

/** Pick the bucket width that puts the span nearest TARGET_BUCKETS. */
export function chooseBucketMs(spanMs: number): number {
  const ideal = spanMs / TARGET_BUCKETS;
  return UNITS.find((u) => u >= ideal) ?? UNITS[UNITS.length - 1] ?? HOUR;
}

const LEVELS: readonly TurnRow['level'][] = ['info', 'warn', 'error'];
const LEVEL_COLOR: Record<TurnRow['level'], string> = {
  info: STATUS.ok,
  warn: STATUS.warn,
  error: STATUS.err,
};
const LEVEL_LABEL: Record<TurnRow['level'], string> = {
  info: 'Committed',
  warn: 'Recovered',
  error: 'Error',
};

/**
 * Group turns into time buckets per outcome level, at a width chosen from the
 * observed span. Empty buckets inside the span are emitted as zeros so a quiet
 * night reads as quiet rather than as missing — the old screen had no such
 * notion at all.
 */
export function bucketTurns(turns: readonly TurnRow[]): VolumeBucket[] {
  if (turns.length === 0) return [];
  const times = turns.map((t) => new Date(t.ts).getTime()).filter((n) => Number.isFinite(n));
  if (times.length === 0) return [];

  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const bucketMs = chooseBucketMs(hi - lo);
  const floor = (ms: number): number => Math.floor(ms / bucketMs) * bucketMs;

  const counts = new Map<string, number>();
  for (const t of turns) {
    const ms = new Date(t.ts).getTime();
    if (!Number.isFinite(ms)) continue;
    const k = `${floor(ms)}|${t.level}`;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }

  // Widen a too-narrow span symmetrically. Those neighbouring buckets really
  // did have no turns, so showing them is accurate as well as legible.
  let start = floor(lo);
  let end = floor(hi);
  while ((end - start) / bucketMs + 1 < MIN_BUCKETS) {
    start -= bucketMs;
    if ((end - start) / bucketMs + 1 < MIN_BUCKETS) end += bucketMs;
  }

  const withDate = bucketMs >= HOUR;
  const out: VolumeBucket[] = [];
  for (let ms = start; ms <= end; ms += bucketMs) {
    const d = new Date(ms);
    const label = d.toLocaleString('en-US', {
      ...(withDate ? { month: 'short', day: 'numeric' } : {}),
      hour: 'numeric',
      ...(bucketMs < HOUR ? { minute: '2-digit' } : {}),
    });
    for (const level of LEVELS) {
      out.push({ hour: d.toISOString(), label, level, count: counts.get(`${ms}|${level}`) ?? 0 });
    }
  }
  return out;
}

/** Nearest-rank percentile over a numeric sample. Returns null for no sample. */
export function percentile(values: readonly number[], p: number): number | null {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[rank] ?? null;
}

export function TurnVolumeChart({ turns, height = 130 }: { turns: readonly TurnRow[]; height?: number }): React.JSX.Element {
  const rows = bucketTurns(turns);

  const definition = defineChart(
    {
      marks: [
        barY(rows, {
          x: 'label',
          y: 'count',
          z: 'level',
          key: (d: VolumeBucket) => `${d.hour}|${d.level}`,
          fill: (d: VolumeBucket) => LEVEL_COLOR[d.level],
          insetTop: 2,
        }),
      ],
      x: { scale: () => scaleBand().padding(0.18) },
      y: { scale: scaleLinear, nice: true, grid: true },
    },
    {
      ...motionOf('morph'),
      tooltip: {
        use: tooltip,
        items: [
          'x',
          { channel: 'y', label: 'Turns', text: (p) => String(p.yValue ?? 0) },
          { field: 'level', label: 'Outcome', text: (p) => LEVEL_LABEL[(p.datum as VolumeBucket).level] },
        ],
      },
    },
  );

  const total = turns.length;
  const errors = turns.filter((t) => t.level === 'error').length;
  return (
    <EzraChart
      definition={definition}
      height={height}
      ariaLabel={`Turn volume over the fetched window: ${total} turns, ${errors} of them errors`}
    />
  );
}

interface LatencyPoint {
  id: string;
  at: Date;
  ms: number;
}

export function LatencyChart({ turns, height = 130 }: { turns: readonly TurnRow[]; height?: number }): React.JSX.Element {
  const rows: LatencyPoint[] = turns
    .filter((t): t is TurnRow & { ms: number } => t.ms !== null && Number.isFinite(t.ms))
    .map((t) => ({ id: t.id, at: new Date(t.ts), ms: t.ms }))
    .filter((r) => Number.isFinite(r.at.getTime()));

  const p95 = percentile(rows.map((r) => r.ms), 95);

  const definition = defineChart(
    {
      marks: [
        ...(p95 === null
          ? []
          : [ruleY([p95], { stroke: 'var(--amber)', strokeWidth: 1.5, strokeDasharray: '5 3' })]),
        dot(rows, { x: 'at', y: 'ms', key: 'id', fill: 'var(--accent)', fillOpacity: 0.62, r: 3.5 }),
      ],
      x: { scale: scaleUtc },
      y: { scale: scaleLinear, nice: true, grid: true },
    },
    {
      ...motionOf('morph'),
      tooltip: {
        use: tooltip,
        items: ['x', { channel: 'y', label: 'Latency', text: (p) => `${Math.round(Number(p.yValue ?? 0))} ms` }],
      },
    },
  );

  return (
    <EzraChart
      definition={definition}
      height={height}
      ariaLabel={
        p95 === null
          ? 'Per-turn latency over the fetched window'
          : `Per-turn latency over the fetched window, 95th percentile ${Math.round(p95)} milliseconds`
      }
    />
  );
}
