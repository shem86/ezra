import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Icon } from './icon';
import { Badge, BarChart, Card, Cell, Dot, SectionTitle } from './primitives';
import { sColor, tierTone, toneForStatus } from './status';

afterEach(cleanup);

describe('primitives render without error', () => {
  it('Icon renders an svg for a named glyph and for database', () => {
    const { container, rerender } = render(<Icon name="bell" />);
    expect(container.querySelector('svg')).not.toBeNull();
    rerender(<Icon name="database" />);
    expect(container.querySelectorAll('path').length).toBeGreaterThan(0);
  });

  it('Dot, Badge, Card, SectionTitle mount', () => {
    render(
      <Card>
        <SectionTitle right={<Badge tone="ok">ok</Badge>}>title</SectionTitle>
        <Dot status="operational" pulse />
        <Badge tone="amber" mono>
          parked
        </Badge>
      </Card>,
    );
    expect(screen.getByText('title')).toBeInTheDocument();
    expect(screen.getByText('parked')).toBeInTheDocument();
  });

  it('Cell renders em-dash for empty, status badge, mono ids, and RTL Hebrew', () => {
    const { container, rerender } = render(<Cell col="text" val="" />);
    expect(container.textContent).toContain('—');

    rerender(<Cell col="status" val="overdue" />);
    expect(screen.getByText('overdue')).toBeInTheDocument();

    rerender(<Cell col="text" val="להתקשר" />);
    const he = screen.getByText('להתקשר');
    expect(he).toHaveStyle({ direction: 'rtl' });
  });

  it('BarChart renders one bar per datum', () => {
    const { container } = render(<BarChart data={[1, 2, 3]} />);
    // outer flex + 3 bars
    expect(container.querySelectorAll('div').length).toBe(4);
  });

  it('BarChart keeps finite heights on an all-zero series (no NaN%)', () => {
    const { container } = render(<BarChart data={[0, 0, 0]} />);
    const flex = container.querySelector('div')!; // outer flex wrapper
    const bars = flex.querySelectorAll<HTMLDivElement>(':scope > div');
    expect(bars.length).toBe(3);
    for (const bar of bars) {
      expect(bar.style.height).not.toContain('NaN');
    }
  });
});

describe('status helpers', () => {
  it('maps known/unknown statuses', () => {
    expect(sColor('operational')).toBe('var(--ok)');
    expect(sColor('nope')).toBe('var(--muted-2)');
    expect(toneForStatus('overdue')).toBe('err');
    expect(tierTone('confirm-before')).toBe('amber');
    expect(tierTone('autonomous')).toBe('neutral');
  });
});
