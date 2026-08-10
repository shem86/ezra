// Smoke test for the chart layer itself, not for any screen.
//
// It exists because two assumptions underpin every chart in the console and
// neither is guaranteed by a type-check:
//
//   1. TanStack Charts renders under jsdom (it measures text and builds SVG;
//      a jsdom gap there would fail at runtime, not at build).
//   2. `@tanstack/react-charts` declares a `react@^19` peer while this package
//      is pinned to React 18.3.1. Inspection says it only uses hooks stable in
//      18 plus `createPortal` — this asserts that rather than trusting it, so
//      the day the assumption breaks, CI says so instead of the browser.
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { barY, defineChart } from '@tanstack/charts';
import { scaleBand, scaleLinear } from 'd3-scale';
import { EzraChart, motionOf } from './ezra-chart';
import { MOTION } from './motion';

afterEach(cleanup);

const rows = [
  { label: 'a', value: 3 },
  { label: 'b', value: 7 },
];

const definition = defineChart({
  marks: [barY(rows, { x: 'label', y: 'value', key: 'label' })],
  x: { scale: () => scaleBand().padding(0.2) },
  y: { scale: scaleLinear, grid: true },
});

describe('EzraChart', () => {
  it('renders an accessible SVG chart under jsdom with React 18', () => {
    render(<EzraChart definition={definition} height={120} ariaLabel="Test chart" />);
    const chart = screen.getByRole('img', { name: 'Test chart' });
    expect(chart).toBeInTheDocument();
    expect(chart.querySelectorAll('rect').length).toBeGreaterThan(0);
  });

  it('motionOf yields the tier the console expects, in the shape defineChart takes', () => {
    expect(motionOf()).toEqual({ svgAnimation: MOTION.morph });
    expect(motionOf('tick')).toEqual({ svgAnimation: MOTION.tick });
  });

  it('honours reduced motion on every tier', () => {
    // The renderer skips animation when this is set and the media query matches;
    // leaving it unset on any tier would animate against the user's preference.
    for (const tier of Object.values(MOTION)) {
      expect(tier.respectReducedMotion).toBe(true);
    }
  });

  it('keeps readouts out of the motion vocabulary', () => {
    // Guards the decision in motion.ts: no tier may be added that would ease a
    // hover readout. Every tier is an update animation.
    expect(Object.keys(MOTION).sort()).toEqual(['brush', 'morph', 'tick']);
  });
});
