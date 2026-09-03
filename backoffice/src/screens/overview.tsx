// Overview — the `focus` dashboard, composed LIVE from the other endpoints:
// spend (/api/costs), approvals (/api/db/pending_actions), turns + health
// (/api/status), recent turns (/api/logs). Read-only; Approve/Deny disabled.
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/icon';
import { Badge, Card, Dot, SectionTitle } from '../components/primitives';
import { SpendChart } from '../charts/spend-chart';
import { Sparkline } from '../charts/sparkline';
import { sColor, tierTone } from '../components/status';
import { api, type ApiClient } from '../api/client';
import { useAsync } from '../api/use-async';
import type { CostsResponse, LogsResponse, Row, ServiceRow, StatusResponse } from '../api/types';
import type { Route } from '../routes';

// Each tile/card sources its own endpoint and LOADS INDEPENDENTLY: a section is
// loading, loaded, or carries the reason it failed, so one bad endpoint degrades
// a single card (the Promise.all bug) and one SLOW endpoint delays a single card
// (the Promise.allSettled bug — /api/status spent 10.5s on a blocked calendar
// probe while the other three answered in <1s, and the page waited for all
// four; STATUS.md item 8).
type Section<T> = { state: 'loading' } | { state: 'ok'; value: T } | { state: 'error'; error: string };

function useSection<T>(loader: (signal: AbortSignal) => Promise<T>): Section<T> {
  const { data, error, loading } = useAsync<T>(loader);
  if (error !== null) return { state: 'error', error };
  if (loading || data === null) return { state: 'loading' };
  return { state: 'ok', value: data };
}

function valueOf<T>(s: Section<T>): T | null {
  return s.state === 'ok' ? s.value : null;
}

function isUnauthorized(s: Section<unknown>): boolean {
  return s.state === 'error' && s.error === 'unauthorized';
}

function SectionMessage({ section }: { section: Section<unknown> }): React.JSX.Element | null {
  if (section.state === 'loading') {
    return <span style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</span>;
  }
  if (section.state === 'error') {
    return (
      <span style={{ color: 'var(--err)', fontSize: 13 }}>
        {section.error === 'unauthorized' ? 'Session expired — sign in again.' : `Couldn't load: ${section.error}`}
      </span>
    );
  }
  return null;
}

function CardPending({ title, section }: { title: string; section: Section<unknown> }): React.JSX.Element {
  return (
    <Card>
      <SectionTitle>{title}</SectionTitle>
      <SectionMessage section={section} />
    </Card>
  );
}

function KpiTile({
  label,
  value,
  sub,
  tone,
  icon,
  onClick,
  spark,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'amber';
  icon?: IconName;
  onClick?: () => void;
  /** Only supplied where a real series exists — never a synthesised trend. */
  spark?: { values: readonly number[]; ariaLabel: string };
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
      {spark && (
        <div className="chart-host" style={{ marginTop: 2 }}>
          <Sparkline values={spark.values} ariaLabel={spark.ariaLabel} height={30} />
        </div>
      )}
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
      <div style={{ marginTop: 18 }} className="chart-host">
        <SpendChart dailyCost={costs.dailyCost} budgetUsd={costs.budgetUsd} height={124} />
        <div style={{ fontSize: 11, color: 'var(--muted-2)', marginTop: 6, textAlign: 'right' }}>
          daily · last {costs.dailyCost.length} days (est.)
        </div>
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
  const costsS = useSection<CostsResponse>((signal) => client.costs(signal));
  const statusS = useSection<StatusResponse>((signal) => client.status(signal));
  const logsS = useSection<LogsResponse>((signal) => client.logs(60, signal));
  const pendingS = useSection<Row[]>((signal) => client.table('pending_actions', 200, signal).then((t) => t.rows));

  // If every section is 401 the whole console is unauthed — surface the single
  // sign-in prompt instead of four identical per-card errors.
  const sections: Section<unknown>[] = [costsS, statusS, logsS, pendingS];
  if (sections.every(isUnauthorized)) {
    return (
      <Card>
        <span style={{ color: 'var(--err)' }}>Session expired — sign in again.</span>
      </Card>
    );
  }

  const costs = valueOf(costsS);
  const status = valueOf(statusS);
  const logs = valueOf(logsS);
  const pending = valueOf(pendingS);

  const parked = (pending ?? []).filter((p) => p['status'] === 'pending');
  const errCount = (logs?.turns ?? []).filter((t) => t.level === 'error').length;
  const tiles: {
    label: string;
    value: ReactNode;
    sub?: ReactNode;
    tone?: 'amber';
    icon?: IconName;
    go?: Route;
    spark?: { values: readonly number[]; ariaLabel: string };
  }[] = [
    {
      label: 'Spend (MTD, est.)',
      value: costs ? '$' + costs.monthCostUsd.toFixed(2) : '—',
      ...(costs ? { sub: `of $${costs.budgetUsd}` } : {}),
      icon: 'costs',
      // The only tile with a real series behind it; the other three have no
      // history in the API, and a fabricated trend would be worse than none.
      ...(costs ? { spark: { values: costs.dailyCost, ariaLabel: 'Daily estimated spend trend' } } : {}),
    },
    { label: 'Turns today', value: status ? status.turnsToday : '—', ...(status ? { sub: `avg ${status.avgLatency}` } : {}), icon: 'flow' },
    { label: 'Pending approvals', value: pending ? parked.length : '—', sub: 'awaiting', tone: 'amber', icon: 'pause', go: 'database' },
    { label: 'Errors · recent', value: logs ? errCount : '—', sub: 'of last 60 turns', icon: 'alert' },
  ];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="grid-ov-hero">
        {costs ? <SpendCard costs={costs} /> : <CardPending title="Spend this month (est.)" section={costsS} />}
        {pending ? <ApprovalsCard parked={parked} /> : <CardPending title="Awaiting approval" section={pendingS} />}
      </div>
      <div className="grid-ov-kpis">
        {tiles.map((t) => (
          <KpiTile
            key={t.label}
            label={t.label}
            value={t.value}
            {...(t.sub !== undefined ? { sub: t.sub } : {})}
            {...(t.tone !== undefined ? { tone: t.tone } : {})}
            {...(t.icon !== undefined ? { icon: t.icon } : {})}
            {...(t.spark !== undefined ? { spark: t.spark } : {})}
            {...(t.go !== undefined ? { onClick: () => onOpen(t.go!) } : {})}
          />
        ))}
      </div>
      <div className="grid-ov-feed">
        <Card pad={0}>
          <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)' }}>
            <SectionTitle>Recent turns</SectionTitle>
          </div>
          <div style={{ padding: '4px 18px 12px' }}>
            {logs ? <ActivityFeed logs={logs} onOpen={onOpen} /> : <SectionMessage section={logsS} />}
          </div>
        </Card>
        {status ? <HealthCard services={status.services} onOpen={onOpen} /> : <CardPending title="Service health" section={statusS} />}
      </div>
    </div>
  );
}
