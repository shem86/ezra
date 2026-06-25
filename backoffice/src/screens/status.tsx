// Status — LIVE service probes grouped by area + static reliability edges
// (recovery-runbook copy). Fetches /api/status (BO-11).
import { useState } from 'react';
import { Icon } from '../components/icon';
import { Badge, Card, Dot } from '../components/primitives';
import { api, type ApiClient } from '../api/client';
import { useAsync } from '../api/use-async';
import type { StatusResponse } from '../api/types';

export function StatusScreen({ client = api }: { client?: ApiClient }): React.JSX.Element {
  // Re-run the probes when the refresh button is pressed (useAsync re-loads on key change).
  const [reload, setReload] = useState(0);
  const { data, error, loading } = useAsync<StatusResponse>((signal) => client.status(signal), reload);

  if (error !== null) {
    return (
      <Card>
        <span style={{ color: 'var(--err)' }}>
          {error === 'unauthorized' ? 'Unauthorized — open with ?token=…' : `Could not load status: ${error}`}
        </span>
      </Card>
    );
  }
  if (data === null) {
    return <Card>{loading ? 'Running probes…' : 'No status.'}</Card>;
  }

  const groups = [...new Set(data.services.map((s) => s.group))];
  const deg = data.services.filter((s) => s.status !== 'operational');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <Card
        style={{
          background: deg.length
            ? 'color-mix(in oklch, var(--amber) 8%, var(--surface))'
            : 'color-mix(in oklch, var(--ok) 8%, var(--surface))',
          borderColor: deg.length
            ? 'color-mix(in oklch, var(--amber) 40%, var(--border))'
            : 'color-mix(in oklch, var(--ok) 40%, var(--border))',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <Dot status={deg.length ? 'degraded' : 'operational'} size={14} pulse />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 17, fontWeight: 700 }}>
              {deg.length ? `Degraded — ${deg.length} integration${deg.length > 1 ? 's' : ''} slow` : 'All systems operational'}
            </div>
            <div style={{ fontSize: 13, color: 'var(--muted)', marginTop: 2 }}>
              Agent live · {data.turnsToday} turns today · avg latency {data.avgLatency}
            </div>
          </div>
          <button
            className="iconbtn"
            onClick={() => setReload((n) => n + 1)}
            disabled={loading}
            aria-label="Refresh probes"
            title="Refresh probes"
          >
            <Icon name="refresh" size={16} />
          </button>
        </div>
      </Card>

      <Card>
        <div style={{ marginBottom: 14, fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>
          Reliability edges
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
          {data.edges.map((e) => (
            <div key={e.name} style={{ padding: 14, background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginBottom: 8 }}>
                <Dot status={e.status} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{e.name}</span>
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted)', lineHeight: 1.45 }}>{e.detail}</div>
            </div>
          ))}
        </div>
      </Card>

      {groups.map((g) => (
        <div key={g}>
          <div style={{ marginBottom: 14, fontSize: 13, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            {g}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            {data.services
              .filter((s) => s.group === g)
              .map((s) => (
                <Card key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                  <Dot status={s.status} size={11} pulse={s.status !== 'operational'} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 14, fontWeight: 600 }}>{s.name}</span>
                      <Badge tone={s.status === 'operational' ? 'ok' : s.status === 'degraded' ? 'amber' : 'err'}>
                        {s.status}
                      </Badge>
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 3 }}>{s.detail}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>{s.latency}</div>
                    <div style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--muted-2)' }}>{s.uptime}</div>
                  </div>
                </Card>
              ))}
          </div>
        </div>
      ))}
    </div>
  );
}
