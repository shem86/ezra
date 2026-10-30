// Turn router panel (docs/specs/jev-turn-routing-plan.md §5b) — router health
// PULLED from turn_route_log, never paged: a dead router degrades turns to
// standard, so it is a degraded optimization, not an outage. Rows turn amber
// against the plan's starting thresholds; a recent turn expands into what Jev
// answered (the turn view — the workflow id joins it to the Logs screen).
import { useState } from 'react';
import { Badge, Card, Dot, SectionTitle } from '../components/primitives';
import type { RouterResponse } from '../api/types';

export function RouterPanel({ data }: { data: RouterResponse }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const amber = data.rows.filter((r) => r.status === 'amber').length;

  if (data.mode === null) {
    return (
      <Card>
        <SectionTitle>Turn router</SectionTitle>
        <div style={{ fontSize: 13, color: 'var(--muted)' }}>
          No routed turns yet — TURN_ROUTING is off, or nothing has been said since it was turned on.
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <SectionTitle
        right={amber > 0 ? <Badge tone="amber">needs a look</Badge> : <Badge tone="ok">healthy</Badge>}
      >
        Turn router · <Badge mono>{data.mode}</Badge>
      </SectionTitle>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {data.rows.map((r) => (
          <div key={r.name} style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
            <Dot status={r.status === 'ok' ? 'ok' : 'warn'} />
            <span style={{ fontSize: 13, fontWeight: 600, minWidth: 180 }}>{r.name}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5 }}>{r.value}</span>
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>{r.detail}</span>
          </div>
        ))}
      </div>

      {data.recent.length > 0 && (
        <div style={{ marginTop: 16, overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                <th>when</th>
                <th>ran / proposed</th>
                <th>source</th>
                <th>ms</th>
                <th>message</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.map((t) => (
                <RouteRow
                  key={t.workflowId}
                  turn={t}
                  open={open === t.workflowId}
                  onToggle={() => setOpen(open === t.workflowId ? null : t.workflowId)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function RouteRow({
  turn,
  open,
  onToggle,
}: {
  turn: RouterResponse['recent'][number];
  open: boolean;
  onToggle: () => void;
}): React.JSX.Element {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer', borderTop: '1px solid var(--border)' }}>
        <td style={{ fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>{turn.createdAt.slice(5, 16).replace('T', ' ')}</td>
        <td>
          <Badge mono>{turn.tier}</Badge>
          {turn.proposed !== turn.tier && <span style={{ color: 'var(--muted)' }}> / {turn.proposed}</span>}
        </td>
        <td style={{ fontFamily: 'var(--mono)' }}>{turn.source}</td>
        <td style={{ fontFamily: 'var(--mono)' }}>{turn.latencyMs ?? '—'}</td>
        <td dir="auto" style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {turn.latestText ?? '—'}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5} style={{ padding: '8px 0 12px' }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
              workflow {turn.workflowId} · {turn.conversationId}
            </div>
            <pre style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {turn.answers === null ? 'Jev not asked (pre-rule) or failed (fallback).' : JSON.stringify(turn.answers, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}
