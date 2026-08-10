// The single door every chart in the console goes through, so sizing and the
// accessibility contract are properties of the console rather than decisions
// re-made on each screen.
//
// `ariaLabel` is required by the library and by us: an SVG chart is opaque to a
// screen reader, and every caller here has a one-line summary it can give.
// Motion is NOT applied here — in 0.9.0 `svgAnimation` belongs to the chart
// definition, so it is set by the builders in this directory via `motionOf`.
import { Chart } from '@tanstack/react-charts';
import type { ChartDefinition } from '@tanstack/react-charts';
import type { ChartValue } from '@tanstack/charts';
import { MOTION, type MotionTier } from './motion';

// Generic over the axis value types as well as the datum: a definition built on
// a time axis carries `Date` for X, and collapsing that to the `ChartValue`
// default here would reject every real chart at this boundary.
export function EzraChart<TDatum, TXValue extends ChartValue = ChartValue, TYValue extends ChartValue = ChartValue>({
  definition,
  height,
  ariaLabel,
}: {
  definition: ChartDefinition<TDatum, TXValue, TYValue>;
  height: number;
  ariaLabel: string;
}): React.JSX.Element {
  return <Chart definition={definition} height={height} ariaLabel={ariaLabel} />;
}

/** The `svgAnimation` slice of a `defineChart` options object, for one tier. */
export function motionOf(tier: MotionTier = 'morph'): { svgAnimation: (typeof MOTION)[MotionTier] } {
  return { svgAnimation: MOTION[tier] };
}
