// Status — LIVE service probes grouped by area + static reliability edges
// (recovery-runbook copy). Fetches /api/status (BO-11).
//
// Layout (2026-10-31): each probe group is ONE card of rows, status-page style,
// in a two-up grid — the old one-card-per-service layout left most groups as a
// lone half-width card under a heading.
import { useState } from 'react';
import { Icon } from '../components/icon';
import { Badge, Card, Dot, SectionTitle } from '../components/primitives';
import { api, type ApiClient } from '../api/client';
import { useAsync } from '../api/use-async';
import type { RouterResponse, ServiceRow, StatusResponse } from '../api/types';
import { RouterPanel } from './router-panel';

/** Its own fetch, so a router-read failure never blanks the probe list. */
function RouterSection({ client, reload }: { client: ApiClient; reload: number }): React.JSX.Element | null {
  const { router } = client;
  const { data, error } = useAsync<RouterResponse | null>(
    (signal) => (router === undefined ? Promise.resolve(null) : router(signal)),
    reload,
  );
  if (router === undefined) return null;
  if (error !== null) {
    return (
      <Card>
        <span style={{ color: 'var(--muted)' }}>Turn router: could not load ({error}).</span>
      </Card>
    );
  }
  if (data === null) return null;
  return <RouterPanel data={data} />;
}

function ServiceLine({ s }: { s: ServiceRow }): React.JSX.Element {
  const tone = s.status === 'operational' ? 'ok' : s.status === 'degraded' ? 'amber' : 'err';
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: 14, alignItems: 'center', padding: '13px 0' }}>
      <Dot status={s.status} size={10} pulse={s.status !== 'operational'} />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</span>
          {s.status !== 'operational' && <Badge tone={tone}>{s.status}</Badge>}
        </div>
        {s.detail && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 2 }}>{s.detail}</div>}
      </div>
      <div style={{ textAlign: 'right' }} className="num">
        <div className="mono" style={{ fontSize: 13 }}>
          {s.latency}
        </div>
        {s.uptime && (
          <div style={{ fontSize: 11.5, color: 'var(--muted-2)' }} title="uptime">
            {s.uptime} up
          </div>
        )}
      </div>
    </div>
  );
}

export function StatusScreen({ client = api }: { client?: ApiClient }): React.JSX.Element {
  // Re-run the probes when the refresh button is pressed (useAsync re-loads on key change).
  const [reload, setReload] = useState(0);
  const { data, error, loading } = useAsync<StatusResponse>((signal) => client.status(signal), reload);

  if (error !== null) {
    return (
      <Card>
        <span style={{ color: 'var(--err)' }}>
          {error === 'unauthorized' ? 'Session expired — sign in again.' : `Could not load status: ${error}`}
        </span>
      </Card>
    );
  }
  if (data === null) {
    return <Card>{loading ? 'Running probes…' : 'No status.'}</Card>;
  }

  const groups = [...new Set(data.services.map((s) => s.group))];
  const deg = data.services.filter((s) => s.status !== 'operational');
  const anyDown = deg.some((s) => s.status === 'down');

  return (
    <div className="stack stagger">
      <section className="hero" style={{ padding: '22px 26px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18, position: 'relative', zIndex: 1 }}>
          <span
            style={{
              width: 48,
              height: 48,
              borderRadius: 14,
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
              background: `color-mix(in oklch, ${deg.length ? (anyDown ? 'var(--err)' : 'var(--amber)') : 'var(--ok)'} 16%, transparent)`,
              color: deg.length ? (anyDown ? 'var(--err)' : 'var(--amber-ink)') : 'var(--ok-ink)',
            }}
          >
            <Icon name={deg.length ? 'alert' : 'check'} size={24} />
          </span>
          <div>
            <h2 className="hero-hello" style={{ fontSize: 26 }}>
              {deg.length ? `Degraded — ${deg.length} integration${deg.length > 1 ? 's' : ''} slow` : 'All systems operational'}
            </h2>
            <div style={{ fontSize: 13.5, color: 'var(--muted)', marginTop: 4 }}>
              Agent live · {data.turnsToday} turns today · avg latency {data.avgLatency}
            </div>
          </div>
        </div>
        <button
          className="iconbtn spin"
          style={{ position: 'relative', zIndex: 1 }}
          onClick={() => setReload((n) => n + 1)}
          disabled={loading}
          aria-label="Refresh probes"
          title="Refresh probes"
        >
          <Icon name="refresh" size={16} />
        </button>
      </section>

      <Card>
        <SectionTitle right={<span className="hint">from the recovery runbook</span>}>Reliability edges</SectionTitle>
        <div className="grid-status-edges">
          {data.edges.map((e) => (
            <div
              key={e.name}
              style={{ display: 'flex', gap: 10, padding: '12px 14px', background: 'var(--surface-2)', borderRadius: 12 }}
            >
              <span style={{ color: e.status === 'ok' ? 'var(--ok-ink)' : 'var(--amber-ink)', marginTop: 1 }}>
                <Icon name={e.status === 'ok' ? 'check' : 'alert'} size={15} />
              </span>
              <div>
                <div style={{ fontSize: 13.5, fontWeight: 600 }}>{e.name}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.45, marginTop: 2 }}>{e.detail}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>

      <div className="grid-status-services">
        {groups.map((g) => {
          const items = data.services.filter((s) => s.group === g);
          const bad = items.filter((s) => s.status !== 'operational').length;
          return (
            <Card key={g} style={{ paddingBottom: 8 }} {...(bad ? { tone: 'amber' as const } : {})}>
              <SectionTitle
                right={
                  bad ? (
                    <Badge tone="amber">{bad} need attention</Badge>
                  ) : (
                    <span className="hint" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <Dot status="operational" size={6} /> all good
                    </span>
                  )
                }
              >
                {g}
              </SectionTitle>
              <div>
                {items.map((s, i) => (
                  <div key={s.name} style={{ borderTop: i ? '1px solid var(--border)' : 'none' }}>
                    <ServiceLine s={s} />
                  </div>
                ))}
              </div>
            </Card>
          );
        })}
      </div>

      <RouterSection client={client} reload={reload} />
    </div>
  );
}
