// Spend over time — the chart that replaces the 30 flexbox divs.
//
// What it adds over the old BarChart: a real time axis (the old one had no
// dates at all, so a bar meant nothing without counting backwards by hand), a
// budget-pace rule so the series is read against the thing that matters, a
// crosshair + tooltip instead of the OS `title=` delay, and honest zeros — the
// old bars floored at 6% height, so a zero-spend day looked like a small-spend
// day.
//
// `dailyCost` arrives as a bare number[] ending today (server builds it that
// way), so dates are reconstructed here rather than invented: index i is
// (today - (n-1-i)) days.
import { areaY, crosshair, defineChart, lineY, ruleY } from '@tanstack/charts';
import { tooltip } from '@tanstack/charts/tooltip';
import { scaleLinear, scaleUtc } from 'd3-scale';
import { EzraChart, motionOf } from './ezra-chart';
import { SERIES } from './palette';

export interface SpendPoint {
  date: Date;
  usd: number;
  /** Stable identity for keyed reconciliation — a Date isn't a valid key. */
  day: string;
}

/** Reconstruct dates for a trailing daily series ending today (local midnight). */
export function toSpendSeries(dailyCost: readonly number[], today = new Date()): SpendPoint[] {
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const n = dailyCost.length;
  return dailyCost.map((usd, i) => {
    const date = new Date(midnight.getTime() - (n - 1 - i) * 86_400_000);
    return { date, usd, day: date.toISOString().slice(0, 10) };
  });
}

/**
 * Budget spread evenly across the current month — the line that turns "what did
 * I spend" into "am I on track". Uses the real length of the current month.
 */
export function budgetPacePerDay(budgetUsd: number, today = new Date()): number {
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  return budgetUsd / daysInMonth;
}

const usd = (v: number): string => '$' + v.toFixed(v < 1 ? 3 : 2);

export function SpendChart({
  dailyCost,
  budgetUsd,
  height = 150,
  today,
}: {
  dailyCost: readonly number[];
  budgetUsd: number;
  height?: number;
  today?: Date;
}): React.JSX.Element {
  const rows = toSpendSeries(dailyCost, today);
  const pace = budgetPacePerDay(budgetUsd, today);
  const peak = rows.reduce((m, r) => Math.max(m, r.usd), 0);
  // A budget far above actual spend would squash the series into the bottom of
  // the plot to make room for its rule, so the rule is drawn only while it is
  // near enough to be worth the vertical space it costs.
  const showPace = pace <= peak * 1.6;

  const definition = defineChart(
    {
      marks: [
        areaY(rows, { x: 'date', y: 'usd', key: 'day', fill: SERIES.freshInput, fillOpacity: 0.13 }),
        ...(showPace ? [ruleY([pace], { stroke: 'var(--err)', strokeWidth: 1.5, strokeDasharray: '5 3' })] : []),
        lineY(rows, { x: 'date', y: 'usd', key: 'day', stroke: SERIES.freshInput, strokeWidth: 2 }),
        crosshair({ x: true, marker: true }),
      ],
      x: { scale: scaleUtc },
      y: { scale: scaleLinear, nice: true, grid: true },
    },
    {
      ...motionOf('morph'),
      tooltip: {
        use: tooltip,
        items: ['x', { channel: 'y', label: 'Spend', text: (p) => usd(Number(p.yValue ?? 0)) }],
      },
    },
  );

  return (
    <EzraChart
      definition={definition}
      height={height}
      ariaLabel={
        `Estimated daily spend over the last ${rows.length} days` +
        (showPace ? `, against a budget pace of ${usd(pace)} per day` : '')
      }
    />
  );
}
