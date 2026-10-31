// Overview — the `focus` dashboard, composed LIVE from the other endpoints:
// spend (/api/costs), approvals (/api/db/pending_actions), turns + health
// (/api/status), recent turns (/api/logs). Read-only; Approve/Deny disabled.
//
// Layout (2026-10-31 redesign): a greeting hero that says the day in one
// sentence, a KPI strip, then spend + recent turns beside approvals + health.
// Spend used to appear twice (hero card AND a KPI tile) and approvals twice
// (card AND tile); the hero sentence now carries the headline numbers so the
// tiles can show things that were missing (cache hit rate).
import type { ReactNode } from 'react';
import { Icon, type IconName } from '../components/icon';
import { Badge, Card, Dot, Meter, SectionTitle } from '../components/primitives';
import { SpendChart } from '../charts/spend-chart';
import { toneForStatus, tierTone } from '../components/status';
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

const HOUSEHOLD_TZ = 'America/New_York';

function greeting(now = new Date()): string {
  const h = Number(new Date(now).toLocaleString('en-US', { timeZone: HOUSEHOLD_TZ, hour: 'numeric', hour12: false })) % 24;
  if (h < 5) return 'Up late';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function fmtMs(ms: number | null): string | null {
  if (ms === null) return null;
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
}

function Hero({
  costs,
  status,
  parked,
  onOpen,
}: {
  costs: CostsResponse | null;
  status: StatusResponse | null;
  parked: Row[] | null;
  onOpen: (r: Route) => void;
}): React.JSX.Element {
  const unhealthy = status ? status.services.filter((s) => s.status !== 'operational') : [];
  const anyDown = unhealthy.some((s) => s.status === 'down');
  const parts: ReactNode[] = [];
  if (status) {
    parts.push(
      <span key="turns">
        Ezra has handled <b>{status.turnsToday} turns</b> today, averaging {status.avgLatency}.{' '}
      </span>,
    );
  }
  if (costs) {
    parts.push(
      <span key="spend">
        <b>${costs.monthCostUsd.toFixed(2)}</b> spent of the ${costs.budgetUsd} budget this month.{' '}
      </span>,
    );
  }
  if (parked) {
    parts.push(
      parked.length > 0 ? (
        <span key="parked">
          <b className="warn">
            {parked.length} action{parked.length > 1 ? 's' : ''}
          </b>{' '}
          {parked.length > 1 ? 'are' : 'is'} waiting on a yes or no.
        </span>
      ) : (
        <span key="parked">Nothing is waiting on you.</span>
      ),
    );
  }

  return (
    <section className="hero">
      <div style={{ position: 'relative', zIndex: 1 }}>
        <h2 className="hero-hello">{greeting()}.</h2>
        <p className="hero-line">{parts.length ? parts : 'Gathering the day…'}</p>
      </div>
      <button className="hero-status" type="button" onClick={() => onOpen('status')}>
        <Dot status={status === null ? 'info' : anyDown ? 'down' : unhealthy.length ? 'degraded' : 'operational'} size={9} pulse />
        {status === null
          ? 'Checking services…'
          : unhealthy.length
            ? `${unhealthy.length} service${unhealthy.length > 1 ? 's' : ''} need${unhealthy.length > 1 ? '' : 's'} attention`
            : 'All systems operational'}
        <Icon name="chevron" size={14} style={{ color: 'var(--muted-2)' }} />
      </button>
    </section>
  );
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
  tone?: 'amber' | 'err' | 'ok' | 'accent';
  icon: IconName;
  onClick?: () => void;
}): React.JSX.Element {
  // Tone tints the icon chip only; the whole card turns amber solely when
  // something is waiting on a human, so the tint keeps meaning "look here".
  return (
    <Card pad={18} className="kpi" {...(tone === 'amber' ? { tone } : {})} {...(onClick ? { onClick } : {})}>
      <div className="kpi-label" data-tone={tone}>
        <span className="kpi-icon">
          <Icon name={icon} size={14} />
        </span>
        {label}
        {onClick && (
          <span className="go">
            <Icon name="chevron" size={14} />
          </span>
        )}
      </div>
      <div className="kpi-value">
        <span className="big">{value}</span>
        {sub && <span className="kpi-sub">{sub}</span>}
      </div>
    </Card>
  );
}

function RecentTurns({ logs, onOpen }: { logs: LogsResponse; onOpen: (r: Route) => void }): React.JSX.Element {
  const rows = logs.turns.slice(0, 7);
  if (rows.length === 0) return <div className="empty">No turns yet — Ezra is waiting for the first message.</div>;
  return (
    <div className="rowlist">
      {rows.map((r) => (
        <button key={r.id} onClick={() => onOpen('logs')} className="rowitem" type="button">
          <Dot status={r.level === 'info' ? 'ok' : r.level} />
          <div className="row-line">
            <span className="row-title" style={r.tool ? undefined : { color: 'var(--muted)', fontFamily: 'inherit' }}>
              {r.tool ?? 'conversation'}
            </span>
            <span className="row-meta">
              <span>{fmtWhen(r.ts)}</span>
              {fmtMs(r.ms) && <span className="num">· {fmtMs(r.ms)}</span>}
              <span>·</span>
              <span className="mono" style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>
                {r.id}
              </span>
            </span>
          </div>
          <span style={{ display: 'flex', gap: 6 }}>
            {r.tier && r.tier !== 'autonomous' && <Badge tone={tierTone(r.tier)}>{r.tier}</Badge>}
            <Badge tone={toneForStatus(r.st)}>{r.st}</Badge>
          </span>
        </button>
      ))}
    </div>
  );
}

function ApprovalsCard({ parked }: { parked: Row[] }): React.JSX.Element {
  return (
    <Card {...(parked.length ? { tone: 'amber' as const } : {})}>
      <SectionTitle right={<Badge tone={parked.length ? 'amber' : 'ok'}>{parked.length} pending</Badge>}>
        Awaiting approval
      </SectionTitle>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {parked.map((p) => (
          <div
            key={String(p['action_id'])}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              padding: 14,
              background: 'var(--surface)',
              borderRadius: 12,
              border: '1px solid var(--border)',
              boxShadow: 'var(--shadow-sm)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span className="kpi-icon" style={{ background: 'var(--accent-soft)', color: 'var(--accent-ink)' }}>
                <Icon name="calendar" size={14} />
              </span>
              <div style={{ minWidth: 0 }}>
                <div className="mono" style={{ fontSize: 13, fontWeight: 600 }}>
                  {String(p['tool'] ?? '—')}
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 1 }}>
                  <span className="mono">{String(p['action_id'])}</span> · expires {String(p['expires_at'])}
                </div>
              </div>
            </div>
            {/* Read-only console: controls visible-but-disabled (spec decision 1). */}
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn btn-ok" disabled title="Approve from WhatsApp — the console is read-only">
                Approve
              </button>
              <button className="btn btn-ghost" disabled title="Deny from WhatsApp — the console is read-only">
                Deny
              </button>
            </div>
          </div>
        ))}
        {parked.length === 0 && (
          <div className="empty" style={{ padding: '12px 0 4px' }}>
            <span className="empty-mark">
              <Icon name="check" size={18} />
            </span>
            Nothing parked — all clear.
          </div>
        )}
      </div>
      <div className="hint" style={{ marginTop: 12, lineHeight: 1.5 }}>
        Re-checked right before the write · executed exactly once.
      </div>
    </Card>
  );
}

function SpendCard({ costs }: { costs: CostsResponse }): React.JSX.Element {
  const pct = Math.round((costs.monthCostUsd / costs.budgetUsd) * 100);
  const over = costs.monthCostUsd > costs.budgetUsd;
  const today = new Date();
  const monthFrac = today.getDate() / new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  return (
    <Card>
      <SectionTitle right={<Badge tone={over ? 'amber' : 'ok'}>{over ? 'over budget' : 'under budget'}</Badge>}>
        Spend this month (est.)
      </SectionTitle>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <span className="big" style={{ fontSize: 48 }}>
          ${costs.monthCostUsd.toFixed(2)}
        </span>
        <span style={{ fontSize: 13.5, color: 'var(--muted)' }}>of ${costs.budgetUsd} budget</span>
      </div>
      <div style={{ marginTop: 16 }}>
        <Meter pct={pct} over={over} mark={monthFrac} />
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, fontSize: 12, color: 'var(--muted)' }}>
        <span className="num">{pct}% of budget · tick marks today</span>
        <span className="num">{costs.cacheReadPct}% billed as cache reads</span>
      </div>
      <div style={{ marginTop: 20 }} className="chart-host">
        <SpendChart dailyCost={costs.dailyCost} budgetUsd={costs.budgetUsd} height={132} />
        <div className="hint" style={{ marginTop: 6, textAlign: 'right' }}>
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
  const shown = services
    .filter((s) => s.status !== 'operational')
    .concat(services.filter((s) => s.status === 'operational'))
    .slice(0, 5);
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
      <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
        <Badge tone="ok">{ops} operational</Badge>
        {deg > 0 && <Badge tone="amber">{deg} degraded</Badge>}
        {down > 0 && <Badge tone="err">{down} down</Badge>}
      </div>
      <div className="rowlist">
        {shown.map((s) => (
          <button key={s.name} className="rowitem" type="button" onClick={() => onOpen('status')} style={{ padding: '8px 10px' }}>
            <Dot status={s.status} pulse={s.status !== 'operational'} />
            <span style={{ fontSize: 13.5 }}>{s.name}</span>
            <span className="mono" style={{ fontSize: 12, color: 'var(--muted)' }}>
              {s.latency}
            </span>
          </button>
        ))}
      </div>
      {services.length > shown.length && (
        <div className="hint" style={{ marginTop: 6 }}>
          +{services.length - shown.length} more on Status
        </div>
      )}
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

  const parked = pending === null ? null : pending.filter((p) => p['status'] === 'pending');
  const errCount = (logs?.turns ?? []).filter((t) => t.level === 'error').length;

  return (
    <div className="stack stagger">
      <Hero costs={costs} status={status} parked={parked} onOpen={onOpen} />

      <div className="grid-ov-kpis">
        <KpiTile
          label="Turns today"
          icon="flow"
          tone="accent"
          value={status ? status.turnsToday : '—'}
          {...(status ? { sub: `avg ${status.avgLatency}` } : {})}
          onClick={() => onOpen('logs')}
        />
        <KpiTile
          label="Pending approvals"
          icon="pause"
          value={parked ? parked.length : '—'}
          sub={parked && parked.length ? 'awaiting you' : 'all clear'}
          {...(parked && parked.length ? { tone: 'amber' as const } : {})}
          onClick={() => onOpen('database')}
        />
        <KpiTile
          label="Errors · recent"
          icon="alert"
          value={logs ? errCount : '—'}
          sub={`of last ${logs?.turns.length ?? 60} turns`}
          {...(errCount > 0 ? { tone: 'err' as const } : {})}
          onClick={() => onOpen('logs')}
        />
        <KpiTile
          label="Prompt cache"
          icon="zap"
          value={costs ? `${costs.cacheReadPct}%` : '—'}
          sub="of input from cache"
          tone="ok"
          onClick={() => onOpen('costs')}
        />
      </div>

      <div className="grid-ov-main">
        <div className="stack">
          {costs ? <SpendCard costs={costs} /> : <CardPending title="Spend this month (est.)" section={costsS} />}
          <Card>
            <SectionTitle
              right={
                <button className="link" onClick={() => onOpen('logs')}>
                  All logs <Icon name="chevron" size={13} />
                </button>
              }
            >
              Recent turns
            </SectionTitle>
            {logs ? <RecentTurns logs={logs} onOpen={onOpen} /> : <SectionMessage section={logsS} />}
          </Card>
        </div>
        <div className="stack">
          {parked ? <ApprovalsCard parked={parked} /> : <CardPending title="Awaiting approval" section={pendingS} />}
          {status ? <HealthCard services={status.services} onOpen={onOpen} /> : <CardPending title="Service health" section={statusS} />}
        </div>
      </div>
    </div>
  );
}
