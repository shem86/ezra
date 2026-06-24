// Overview — the `focus` dashboard (spend + approvals up top, KPI row, then
// recent turns + health). The prototype's `cards`/`dense` variants are dropped.
// Renders fixtures for now; Overview composes the live endpoints in BO-13.
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/icon';
import { Badge, BarChart, Card, Dot, SectionTitle } from '../components/primitives';
import { tierTone } from '../components/status';
import {
  activity as activityFx,
  dailyCost as dailyCostFx,
  kpis as kpisFx,
  pendingActions as pendingFx,
  services as servicesFx,
  type Kpis,
  type LogRow,
  type PendingAction,
  type ServiceRow,
} from '../fixtures';
import type { Route } from '../routes';

const HEBREW = /[֐-׿]/;

export interface OverviewData {
  kpis: Kpis;
  dailyCost: number[];
  pendingActions: PendingAction[];
  services: ServiceRow[];
  activity: LogRow[];
}

const FIXTURE_DATA: OverviewData = {
  kpis: kpisFx,
  dailyCost: dailyCostFx,
  pendingActions: pendingFx,
  services: servicesFx,
  activity: activityFx,
};

function KpiTile({
  label,
  value,
  sub,
  tone,
  icon,
  onClick,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'amber';
  icon?: IconName;
  onClick?: () => void;
}): React.JSX.Element {
  return (
    <Card
      pad={16}
      className="hov"
      style={{
        cursor: onClick ? 'pointer' : 'default',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        ...(tone === 'amber'
          ? {
              borderColor: 'color-mix(in oklch, var(--amber) 45%, var(--border))',
              background: 'color-mix(in oklch, var(--amber) 7%, var(--surface))',
            }
          : {}),
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 7, color: 'var(--muted)' }}>
        {icon && <Icon name={icon} size={14} />}
        <span style={{ fontSize: 12, fontWeight: 600, letterSpacing: '0.02em' }}>{label}</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span
          style={{
            fontSize: 27,
            fontWeight: 700,
            letterSpacing: '-0.02em',
            lineHeight: 1,
            fontFamily: 'var(--mono)',
          }}
        >
          {value}
        </span>
        {sub && (
          <span style={{ fontSize: 12.5, color: tone === 'amber' ? 'var(--amber-ink)' : 'var(--muted)' }}>
            {sub}
          </span>
        )}
      </div>
    </Card>
  );
}

function ActivityFeed({ rows, onOpen }: { rows: LogRow[]; onOpen: (r: Route) => void }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {rows.map((r, i) => (
        <button
          key={r.id}
          onClick={() => onOpen('logs')}
          className="actrow"
          style={{
            display: 'grid',
            gridTemplateColumns: 'auto 1fr auto',
            gap: 12,
            alignItems: 'center',
            padding: '11px 6px',
            background: 'none',
            border: 'none',
            borderTop: i ? '1px solid var(--border)' : 'none',
            textAlign: 'left',
            cursor: 'pointer',
            width: '100%',
            font: 'inherit',
            color: 'inherit',
          }}
        >
          <Dot status={r.level} />
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 13.5,
                fontWeight: 500,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                direction: HEBREW.test(r.summary) ? 'rtl' : 'ltr',
                unicodeBidi: 'plaintext',
              }}
            >
              {r.summary}
            </div>
            <div
              style={{
                fontSize: 11.5,
                color: 'var(--muted)',
                marginTop: 2,
                display: 'flex',
                gap: 8,
                alignItems: 'center',
              }}
            >
              <span>{r.trigger}</span>
              <span style={{ opacity: 0.5 }}>·</span>
              <span style={{ fontFamily: 'var(--mono)' }}>{r.ts}</span>
            </div>
          </div>
          <Badge tone={tierTone(r.tier)} mono>
            {r.tool}
          </Badge>
        </button>
      ))}
    </div>
  );
}

function ApprovalsCard({ parked }: { parked: PendingAction[] }): React.JSX.Element {
  return (
    <Card
      style={{
        borderColor: parked.length
          ? 'color-mix(in oklch, var(--amber) 45%, var(--border))'
          : 'var(--border)',
      }}
    >
      <SectionTitle right={<Badge tone="amber">{parked.length} parked</Badge>}>Awaiting approval</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {parked.map((p) => (
          <div
            key={p.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: 12,
              background: 'var(--surface-2)',
              borderRadius: 10,
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 500 }}>{p.action}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <Badge tone="amber" mono>
                {p.tool}
              </Badge>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>
                by {p.requested_by} · TTL {p.ttl}
              </span>
            </div>
            {/* Read-only console: controls visible-but-disabled (spec decision 1). */}
            <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
              <button className="btn btn-ok" disabled>
                Approve
              </button>
              <button className="btn btn-ghost" disabled>
                Deny
              </button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted-2)', marginTop: 12, lineHeight: 1.5 }}>
        Re-checked right before the write · executed exactly once.
      </div>
    </Card>
  );
}

function SpendCard({ kpis, dailyCost }: { kpis: Kpis; dailyCost: number[] }): React.JSX.Element {
  const pct = Math.round((kpis.monthCost / kpis.budget) * 100);
  return (
    <Card>
      <SectionTitle right={<Badge tone="ok">under budget</Badge>}>Spend this month</SectionTitle>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 44, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: '-0.03em' }}>
          ${kpis.monthCost.toFixed(2)}
        </span>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>/ ${kpis.budget} budget</span>
      </div>
      <div
        style={{
          height: 8,
          background: 'var(--surface-2)',
          borderRadius: 99,
          marginTop: 14,
          overflow: 'hidden',
          border: '1px solid var(--border)',
        }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: 'var(--ok)', borderRadius: 99 }} />
      </div>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginTop: 8,
          fontSize: 11.5,
          color: 'var(--muted)',
        }}
      >
        <span>{pct}% of budget</span>
        <span style={{ fontFamily: 'var(--mono)' }}>{kpis.cacheReadPct}% billed as cache reads</span>
      </div>
      <div style={{ marginTop: 18 }}>
        <BarChart data={dailyCost} height={96} fmt={(v) => '$' + v.toFixed(2)} />
        <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 6, textAlign: 'right' }}>
          daily · last 30 days
        </div>
      </div>
    </Card>
  );
}

function HealthCard({ services, onOpen }: { services: ServiceRow[]; onOpen: (r: Route) => void }): React.JSX.Element {
  const ops = services.filter((s) => s.status === 'operational').length;
  const deg = services.filter((s) => s.status === 'degraded').length;
  const down = services.filter((s) => s.status === 'down').length;
  const shown = services
    .filter((s) => s.status !== 'operational')
    .concat(services.filter((s) => s.status === 'operational').slice(0, 3));
  return (
    <Card>
      <SectionTitle
        right={
          <button className="link" onClick={() => onOpen('status')}>
            View all <Icon name="chevron" size={13} />
          </button>
        }
      >
        Service health
      </SectionTitle>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
        <Badge tone="ok">{ops} operational</Badge>
        {deg > 0 && <Badge tone="amber">{deg} degraded</Badge>}
        {down > 0 && <Badge tone="err">{down} down</Badge>}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {shown.map((s) => (
          <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0' }}>
            <Dot status={s.status} pulse={s.status !== 'operational'} />
            <span style={{ fontSize: 13, flex: 1 }}>{s.name}</span>
            <span style={{ fontSize: 12, fontFamily: 'var(--mono)', color: 'var(--muted)' }}>{s.latency}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function OverviewScreen({
  onOpen,
  data = FIXTURE_DATA,
}: {
  onOpen: (r: Route) => void;
  data?: OverviewData;
}): React.JSX.Element {
  const k = data.kpis;
  const tiles: {
    label: string;
    value: ReactNode;
    sub?: ReactNode;
    tone?: 'amber';
    icon?: IconName;
    go?: Route;
  }[] = [
    { label: 'Spend (MTD)', value: '$' + k.monthCost.toFixed(2), sub: `of $${k.budget}`, icon: 'costs' },
    { label: 'Turns today', value: k.turnsToday, sub: `▲ ${k.turnsToday - k.turnsYesterday}`, icon: 'flow' },
    { label: 'Pending approvals', value: k.pendingApprovals, sub: 'parked', tone: 'amber', icon: 'pause', go: 'database' },
    { label: 'Errors · 24h', value: k.errors24h, sub: `${k.recovered7d} recovered`, icon: 'alert' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 18 }}>
        <SpendCard kpis={k} dailyCost={data.dailyCost} />
        <ApprovalsCard parked={data.pendingActions.filter((p) => p.status === 'parked')} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12 }}>
        {tiles.map((t) => (
          <KpiTile
            key={t.label}
            label={t.label}
            value={t.value}
            {...(t.sub !== undefined ? { sub: t.sub } : {})}
            {...(t.tone !== undefined ? { tone: t.tone } : {})}
            {...(t.icon !== undefined ? { icon: t.icon } : {})}
            {...(t.go !== undefined ? { onClick: () => onOpen(t.go!) } : {})}
          />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr', gap: 18 }}>
        <Card pad={0}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <SectionTitle>Recent turns</SectionTitle>
          </div>
          <div style={{ padding: '4px 18px 12px' }}>
            <ActivityFeed rows={data.activity} onOpen={onOpen} />
          </div>
        </Card>
        <HealthCard services={data.services} onOpen={onOpen} />
      </div>
    </div>
  );
}
