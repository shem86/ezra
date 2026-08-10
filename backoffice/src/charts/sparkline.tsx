// A number with no trend is noise — this is what turns the Overview's bare KPI
// figures into readable ones. Axes are off (the scale is kept, the axis is
// omitted) because a sparkline's job is shape, not magnitude; the magnitude is
// the big number sitting directly above it.
import { areaY, defineChart, lineY } from '@tanstack/charts';
import { scaleLinear } from 'd3-scale';
import { EzraChart, motionOf } from './ezra-chart';

interface SparkPoint {
  i: number;
  v: number;
}

export function Sparkline({
  values,
  ariaLabel,
  color = 'var(--chart-1)',
  height = 34,
}: {
  values: readonly number[];
  ariaLabel: string;
  color?: string;
  height?: number;
}): React.JSX.Element | null {
  // Two points is the minimum that can describe a trend; below that a sparkline
  // would imply a shape the data doesn't have.
  if (values.length < 2) return null;
  const rows: SparkPoint[] = values.map((v, i) => ({ i, v }));

  const definition = defineChart(
    {
      marks: [
        areaY(rows, { x: 'i', y: 'v', key: 'i', fill: color, fillOpacity: 0.12 }),
        lineY(rows, { x: 'i', y: 'v', key: 'i', stroke: color, strokeWidth: 1.75 }),
      ],
      x: { scale: scaleLinear, axis: false },
      y: { scale: scaleLinear, axis: false },
    },
    // No tooltip: a sparkline this small has no hit target worth aiming at, and
    // the exact values live in the chart the tile links to.
    { ...motionOf('morph'), tooltip: false, pointer: false },
  );

  return <EzraChart definition={definition} height={height} ariaLabel={ariaLabel} />;
}
