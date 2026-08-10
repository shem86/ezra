// The two token-economics charts on the Costs screen.
//
// `SplitBar` replaces the 12px stacked <div> that showed the input/output mix,
// and `UsageBars` replaces the inline <div> width:pct% bars in the cost table.
// Both previously drew their four series with the UI's semantic tokens, which
// fail CVD separation on exactly the fresh-input/cache-read pair (see palette.ts).
//
// Honest scope note: the API returns ONE ratio (sampled from recent
// observations), not a per-day split, so these are composition-at-a-point.
// Turning them into the composition-over-time trend needs the server to return
// a bucketed split — it is not something the chart layer can invent.
import { barX, defineChart } from '@tanstack/charts';
import { tooltip } from '@tanstack/charts/tooltip';
import { scaleBand, scaleLinear } from 'd3-scale';
import { EzraChart, motionOf } from './ezra-chart';
import { usageColor } from './palette';
import type { TokenSplitSlice, UsageTypeRow } from '../api/types';

const pct = (v: number): string => Math.round(v * 100) + '%';

interface SplitDatum {
  label: string;
  pct: number;
  /** Single shared category so the slices stack into one bar. */
  row: string;
}

export function SplitBar({ split, height = 62 }: { split: readonly TokenSplitSlice[]; height?: number }): React.JSX.Element {
  const rows: SplitDatum[] = split.filter((s) => s.pct > 0).map((s) => ({ label: s.label, pct: s.pct, row: 'mix' }));

  const definition = defineChart(
    {
      marks: [
        barX(rows, {
          x: 'pct',
          y: 'row',
          key: 'label',
          color: 'label',
          fill: (d: SplitDatum) => usageColor(d.label),
          // A 2px gap keeps adjacent segments separable at this height, which a
          // shared edge does not — especially for the two smallest slices.
          insetRight: 2,
        }),
      ],
      x: { scale: scaleLinear, axis: false },
      y: { scale: () => scaleBand().padding(0.1), axis: false },
    },
    {
      ...motionOf('morph'),
      tooltip: {
        use: tooltip,
        items: [{ channel: 'x', label: 'Share', text: (p) => pct(Number(p.xValue ?? 0)) }],
      },
    },
  );

  return (
    <EzraChart
      definition={definition}
      height={height}
      ariaLabel={
        'Token mix by share: ' + rows.map((r) => `${r.label} ${pct(r.pct)}`).join(', ')
      }
    />
  );
}

export function UsageBars({ rows, height = 150 }: { rows: readonly UsageTypeRow[]; height?: number }): React.JSX.Element {
  // Sorted by cost so the table reads as a ranking; colour still follows the
  // usage type, never the rank, so re-sorting can't repaint a series.
  const data = [...rows].sort((a, b) => b.cost - a.cost);

  const definition = defineChart(
    {
      marks: [
        barX(data, {
          x: 'cost',
          y: 'name',
          key: 'name',
          fill: (d: UsageTypeRow) => usageColor(d.name),
        }),
      ],
      x: { scale: scaleLinear, nice: true, grid: true },
      y: { scale: () => scaleBand().padding(0.28) },
    },
    {
      ...motionOf('morph'),
      tooltip: {
        use: tooltip,
        items: [
          'y',
          { channel: 'x', label: 'Est. cost', text: (p) => '$' + Number(p.xValue ?? 0).toFixed(3) },
        ],
      },
    },
  );

  return (
    <EzraChart
      definition={definition}
      height={height}
      ariaLabel={'Estimated cost by usage type: ' + data.map((r) => `${r.name} $${r.cost.toFixed(3)}`).join(', ')}
    />
  );
}
