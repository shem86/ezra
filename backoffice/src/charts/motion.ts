// The console's motion vocabulary, in one place.
//
// TanStack Charts 0.9.0 takes animation on the *definition* as `svgAnimation`
// (there is no `animate` prop on the React adapter at this version — the docs on
// main are ahead of the release). Two properties of that implementation shape
// what is expressible here, both verified against the 0.9.0 renderer source:
//
//   1. It animates UPDATES only — the renderer passes animation options through
//      `hasRendered ? … : undefined`, so a chart's first paint is never animated.
//      There is therefore no "enter" tier; the tiers below all describe what
//      happens when data or scale CHANGES underneath a mounted chart.
//   2. `respectReducedMotion` defaults to true and is honoured by the renderer
//      against `(prefers-reduced-motion: reduce)`. It is spelled out on every
//      tier anyway so the intent survives a future default change.
//
// Smooth motion also depends on marks carrying a stable `key` channel: the SVG
// is reconciled by `data-ts-key`, so keyed marks tween between states while
// unkeyed ones are torn down and rebuilt (a blink at the same duration).

import type { ChartAnimationOptions } from '@tanstack/charts';

/** Data changed under a mounted chart — a new range, filter, or bucket. */
const morph: ChartAnimationOptions = {
  duration: 240,
  easing: 'ease-out',
  respectReducedMotion: true,
};

/** Direct manipulation (brush/zoom): faster, and the axis rescale rides along. */
const brush: ChartAnimationOptions = {
  duration: 180,
  easing: 'ease-in-out',
  respectReducedMotion: true,
  resize: true,
};

/** Background refresh. Deliberately slow and even so it never grabs the eye. */
const tick: ChartAnimationOptions = {
  duration: 600,
  easing: 'linear',
  respectReducedMotion: true,
};

/**
 * Readouts never animate. Crosshair and tooltip are excluded from motion by
 * omission, not by a zero duration — on a console you read while something is
 * broken, eased feedback reads as lag.
 */
export const MOTION = { morph, brush, tick } as const;

export type MotionTier = keyof typeof MOTION;
