// Shared UI primitives, ported from the prototype's ui.jsx as typed .tsx.
// Hebrew renders RTL via unicodeBidi:'plaintext' (the household is he/en).
import type { CSSProperties, ReactNode } from 'react';
import { sColor, tierTone, toneForStatus, type BadgeTone } from './status';

const HEBREW = /[֐-׿]/;

export function Dot({
  status,
  size = 8,
  pulse = false,
}: {
  status: string;
  size?: number;
  pulse?: boolean;
}): React.JSX.Element {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 99,
        background: sColor(status),
        display: 'inline-block',
        flex: 'none',
        boxShadow: pulse ? `0 0 0 0 ${sColor(status)}` : 'none',
        animation: pulse ? 'ezpulse 2s infinite' : 'none',
      }}
    />
  );
}

const BADGE_TONES: Record<BadgeTone, { bg: string; fg: string; bd: string }> = {
  neutral: { bg: 'var(--surface-2)', fg: 'var(--muted)', bd: 'var(--border)' },
  ok: {
    bg: 'color-mix(in oklch, var(--ok) 12%, transparent)',
    fg: 'var(--ok-ink)',
    bd: 'color-mix(in oklch, var(--ok) 30%, transparent)',
  },
  amber: {
    bg: 'color-mix(in oklch, var(--amber) 16%, transparent)',
    fg: 'var(--amber-ink)',
    bd: 'color-mix(in oklch, var(--amber) 34%, transparent)',
  },
  err: {
    bg: 'color-mix(in oklch, var(--err) 12%, transparent)',
    fg: 'var(--err)',
    bd: 'color-mix(in oklch, var(--err) 30%, transparent)',
  },
  accent: {
    bg: 'var(--accent-soft)',
    fg: 'var(--accent-ink)',
    bd: 'color-mix(in oklch, var(--accent) 28%, transparent)',
  },
};

export function Badge({
  children,
  tone = 'neutral',
  mono = false,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  mono?: boolean;
}): React.JSX.Element {
  const t = BADGE_TONES[tone];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '2px 8px',
        borderRadius: 6,
        fontSize: 11.5,
        fontWeight: 600,
        lineHeight: 1.5,
        background: t.bg,
        color: t.fg,
        border: `1px solid ${t.bd}`,
        fontFamily: mono ? 'var(--mono)' : 'inherit',
        whiteSpace: 'nowrap',
        letterSpacing: mono ? '-0.01em' : '0',
      }}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  style,
  pad = 18,
  className,
}: {
  children: ReactNode;
  style?: CSSProperties;
  pad?: number;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      className={className}
      style={{
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding: pad,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  right,
}: {
  children: ReactNode;
  right?: ReactNode;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 14,
      }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 13,
          fontWeight: 700,
          letterSpacing: '0.04em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        {children}
      </h3>
      {right}
    </div>
  );
}

/** A bare value-cell renderer that styles ids/mono/status/RTL nicely. */
export function Cell({ col, val }: { col: string; val: unknown }): React.JSX.Element {
  if (val === undefined || val === null || val === '') {
    return <span style={{ color: 'var(--muted-2)' }}>—</span>;
  }
  if (
    typeof val === 'boolean' &&
    /^(status|synced|done|active|checked|enabled|is_secret)$/.test(col)
  ) {
    return <Badge tone={val ? 'ok' : 'neutral'}>{val ? 'true' : 'false'}</Badge>;
  }
  const v = String(val);
  if (/^(status|synced|done|active|checked|enabled)$/.test(col)) {
    return <Badge tone={toneForStatus(v)}>{v}</Badge>;
  }
  if (col === 'risk') return <Badge tone={tierTone(v)} mono>{v}</Badge>;
  if (/^(id|gcal_id|source_turn|action_id|idempotency_key)$/.test(col) || /_id$/.test(col)) {
    return <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--muted)' }}>{v}</span>;
  }
  if (/^(tokens|cost|cache|confidence|qty)$/.test(col)) {
    return <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{v}</span>;
  }
  const hasHe = HEBREW.test(v);
  return (
    <span style={{ direction: hasHe ? 'rtl' : 'ltr', unicodeBidi: 'plaintext', display: 'inline-block' }}>
      {v}
    </span>
  );
}

export function BarChart({
  data,
  height = 90,
  color = 'var(--accent)',
  fmt = (v: number): string => String(v),
}: {
  data: number[];
  height?: number;
  color?: string;
  fmt?: (v: number) => string;
}): React.JSX.Element {
  // Guard the divisor: an all-zero series (e.g. a zero-spend day) would make
  // `peak` 0 and every `v / peak` NaN → `height: 'NaN%'`. Floor it at 1.
  const peak = data.length > 0 ? Math.max(...data) : 0;
  const max = peak > 0 ? peak : 1;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height }}>
      {data.map((v, i) => (
        <div
          key={i}
          title={fmt(v)}
          style={{
            flex: 1,
            height: `${Math.max(6, (v / max) * 100)}%`,
            background:
              i === data.length - 1
                ? color
                : `color-mix(in oklch, ${color} 55%, var(--surface-2))`,
            borderRadius: '3px 3px 0 0',
            transition: 'height .3s ease',
          }}
        />
      ))}
    </div>
  );
}
