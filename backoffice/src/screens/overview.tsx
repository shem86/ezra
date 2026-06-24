// Overview — the `focus` dashboard, composed LIVE from the other endpoints:
// spend (/api/costs), approvals (/api/db/pending_actions), turns + health
// (/api/status), recent turns (/api/logs). Read-only; Approve/Deny disabled.
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/icon';
import { Badge, BarChart, Card, Dot, SectionTitle } from '../components/primitives';
import { sColor, tierTone } from '../components/status';
import { api, type ApiClient } from '../api/client';
import { useAsync } from '../api/use-async';
import type { CostsResponse, LogsResponse, Row, ServiceRow, StatusResponse } from '../api/types';
import type { Route } from '../routes';

interface OverviewData {
  costs: CostsResponse;
  status: StatusResponse;
  logs: LogsResponse;
  pending: Row[];
}

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
        <span style={{ fontSize: 27, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1, fontFamily: 'var(--mono)' }}>
          {value}
        </span>
        {sub && <span style={{ fontSize: 12.5, color: tone === 'amber' ? 'var(--amber-ink)' : 'var(--muted)' }}>{sub}</span>}
      </div>
    </Card>
  );
}

function ActivityFeed({ logs, onOpen }: { logs: LogsResponse; onOpen: (r: Route) => void }): React.JSX.Element {
  const rows = logs.turns.slice(0, 9);
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
            <div style={{ fontSize: 13, fontFamily: 'var(--mono)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {r.id}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2, display: 'flex', gap: 8, alignItems: 'center' }}>
              <Badge tone={sColor(r.st) === 'var(--ok)' ? 'ok' : sColor(r.st) === 'var(--err)' ? 'err' : 'amber'}>{r.st}</Badge>
              <span style={{ fontFamily: 'var(--mono)' }}>{new Date(r.ts).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
            </div>
          </div>
          {r.tool && (
            <Badge tone={tierTone(r.tier ?? '')} mono>
              {r.tool}
            </Badge>
          )}
        </button>
      ))}
      {rows.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)', padding: '11px 6px' }}>No turns yet.</div>}
    </div>
  );
}

function ApprovalsCard({ parked }: { parked: Row[] }): React.JSX.Element {
  return (
    <Card
      style={{ borderColor: parked.length ? 'color-mix(in oklch, var(--amber) 45%, var(--border))' : 'var(--border)' }}
    >
      <SectionTitle right={<Badge tone="amber">{parked.length} pending</Badge>}>Awaiting approval</SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {parked.map((p) => (
          <div
            key={String(p['action_id'])}
            style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 12, background: 'var(--surface-2)', borderRadius: 10, border: '1px solid var(--border)' }}
          >
            <div style={{ fontSize: 13.5, fontWeight: 500, fontFamily: 'var(--mono)' }}>{String(p['tool'] ?? '—')}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)' }}>{String(p['action_id'])}</span>
              <span style={{ fontSize: 11.5, color: 'var(--muted)' }}>expires {String(p['expires_at'])}</span>
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
        {parked.length === 0 && <div style={{ fontSize: 12.5, color: 'var(--muted)' }}>Nothing parked — all clear.</div>}
      </div>
      <div style={{ fontSize: 11.5, color: 'var(--muted-2)', marginTop: 12, lineHeight: 1.5 }}>
        Re-checked right before the write · executed exactly once.
      </div>
    </Card>
  );
}

function SpendCard({ costs }: { costs: CostsResponse }): React.JSX.Element {
  const pct = Math.round((costs.monthCostUsd / costs.budgetUsd) * 100);
  const over = costs.monthCostUsd > costs.budgetUsd;
  return (
    <Card>
      <SectionTitle right={<Badge tone={over ? 'amber' : 'ok'}>{over ? 'over budget' : 'under budget'}</Badge>}>
        Spend this month (est.)
      </SectionTitle>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span style={{ fontSize: 44, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: '-0.03em' }}>
          ${costs.monthCostUsd.toFixed(2)}
        </span>
        <span style={{ fontSize: 13, color: 'var(--muted)' }}>/ ${costs.budgetUsd} budget</span>
      </div>
      <div style={{ height: 8, background: 'var(--surface-2)', borderRadius: 99, marginTop: 14, overflow: 'hidden', border: '1px solid var(--border)' }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: over ? 'var(--amber)' : 'var(--ok)', borderRadius: 99 }} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 11.5, color: 'var(--muted)' }}>
        <span>{pct}% of budget</span>
        <span style={{ fontFamily: 'var(--mono)' }}>{costs.cacheReadPct}% billed as cache reads</span>
      </div>
      <div style={{ marginTop: 18 }}>
        <BarChart data={costs.dailyCost} height={96} fmt={(v) => '$' + v.toFixed(3)} />
        <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 6, textAlign: 'right' }}>daily · last 30 days (est.)</div>
      </div>
    </Card>
  );
}

function HealthCard({ services, onOpen }: { services: ServiceRow[]; onOpen: (r: Route) => void }): React.JSX.Element {
  const ops = services.filter((s) => s.status === 'operational').length;
  const deg = services.filter((s) => s.status === 'degraded').length;
  const down = services.filter((s) => s.status === 'down').length;
  const shown = services.filter((s) => s.status !== 'operational').concat(services.filter((s) => s.status === 'operational').slice(0, 3));
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

export function OverviewScreen({ onOpen, client = api }: { onOpen: (r: Route) => void; client?: ApiClient }): React.JSX.Element {
  const { data, error, loading } = useAsync<OverviewData>(async (signal) => {
    const [costs, status, logs, pending] = await Promise.all([
      client.costs(signal),
      client.status(signal),
      client.logs(60, signal),
      client.table('pending_actions', 200, signal),
    ]);
    return { costs, status, logs, pending: pending.rows };
  });

  if (error !== null) {
    return (
      <Card>
        <span style={{ color: 'var(--err)' }}>
          {error === 'unauthorized' ? 'Unauthorized — open with ?token=…' : `Could not load overview: ${error}`}
        </span>
      </Card>
    );
  }
  if (data === null) {
    return <Card>{loading ? 'Loading overview…' : 'No data.'}</Card>;
  }

  const parked = data.pending.filter((p) => p['status'] === 'pending');
  const errors = data.logs.turns.filter((t) => t.level === 'error').length;
  const tiles: { label: string; value: ReactNode; sub?: ReactNode; tone?: 'amber'; icon?: IconName; go?: Route }[] = [
    { label: 'Spend (MTD, est.)', value: '$' + data.costs.monthCostUsd.toFixed(2), sub: `of $${data.costs.budgetUsd}`, icon: 'costs' },
    { label: 'Turns today', value: data.status.turnsToday, sub: `avg ${data.status.avgLatency}`, icon: 'flow' },
    { label: 'Pending approvals', value: parked.length, sub: 'awaiting', tone: 'amber', icon: 'pause', go: 'database' },
    { label: 'Errors · recent', value: errors, sub: 'of last 60 turns', icon: 'alert' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 18 }}>
        <SpendCard costs={data.costs} />
        <ApprovalsCard parked={parked} />
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
            <ActivityFeed logs={data.logs} onOpen={onOpen} />
          </div>
        </Card>
        <HealthCard services={data.status.services} onOpen={onOpen} />
      </div>
    </div>
  );
}
