// Turn router panel (docs/specs/jev-turn-routing-plan.md §5b) — router health
// PULLED from turn_route_log, never paged: a dead router degrades turns to
// standard, so it is a degraded optimization, not an outage. Rows turn amber
// against the plan's starting thresholds; a recent turn expands into what Jev
// answered (the turn view — the workflow id joins it to the Logs screen).
// The router's pick gets its own column even when it matches what ran: in
// shadow every turn runs standard, and the pick is what is being evaluated.
import { Fragment, useState } from 'react';
import { Badge, Card, Dot, SectionTitle } from '../components/primitives';
import type { RouterResponse } from '../api/types';

const PAGE = 15;

/** ISO timestamps (e.g. "Last routed turn") read better as a local time. */
function prettyValue(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}T/.test(v)) {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) {
      return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    }
  }
  return v;
}

export function RouterPanel({ data }: { data: RouterResponse }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
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
    <Card pad={0} {...(amber > 0 ? { tone: 'amber' as const } : {})}>
      <div style={{ padding: '20px 20px 4px' }}>
        <SectionTitle
          right={amber > 0 ? <Badge tone="amber">needs a look</Badge> : <Badge tone="ok">healthy</Badge>}
        >
          Turn router · <Badge mono tone="accent">{data.mode}</Badge>
        </SectionTitle>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {data.rows.map((r) => (
            <div
              key={r.name}
              style={{
                padding: '12px 14px',
                borderRadius: 12,
                background:
                  r.status === 'ok' ? 'var(--surface-2)' : 'color-mix(in oklch, var(--amber) 14%, var(--surface))',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, color: 'var(--muted)', fontWeight: 600 }}>
                <Dot status={r.status === 'ok' ? 'ok' : 'warn'} size={7} />
                <span>{r.name}</span>
              </div>
              <div className="mono num" style={{ fontSize: 14, marginTop: 6, fontWeight: 500 }} title={r.value}>
                {prettyValue(r.value)}
              </div>
              <div style={{ fontSize: 11.5, color: 'var(--muted-2)', marginTop: 2 }}>{r.detail}</div>
            </div>
          ))}
        </div>
      </div>

      {data.recent.length > 0 && (
        <div style={{ marginTop: 16, overflowX: 'auto', borderTop: '1px solid var(--border)' }}>
          <table className="grid">
            <thead>
              <tr>
                <th>when</th>
                <th>ran</th>
                <th>router picked</th>
                <th>source</th>
                <th style={{ textAlign: 'right' }}>ms</th>
                <th>message</th>
              </tr>
            </thead>
            <tbody>
              {data.recent.slice(0, shown).map((t) => (
                <RouteRow
                  key={t.workflowId}
                  turn={t}
                  open={open === t.workflowId}
                  onToggle={() => setOpen(open === t.workflowId ? null : t.workflowId)}
                />
              ))}
            </tbody>
          </table>
          {data.recent.length > shown && (
            <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)' }}>
              <button className="btn btn-ghost" onClick={() => setShown(shown + PAGE)}>
                Show more ({data.recent.length - shown} older)
              </button>
            </div>
          )}
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
  const fellBack = turn.source.startsWith('fallback');
  return (
    <Fragment>
      <tr onClick={onToggle} className={open ? 'on' : ''}>
        <td className="mono" style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--muted)' }}>
          {turn.createdAt.slice(5, 16).replace('T', ' ')}
        </td>
        <td>
          <Badge mono>{turn.tier}</Badge>
        </td>
        <td>
          <Badge mono tone={turn.proposed === turn.tier ? 'neutral' : 'accent'}>
            {turn.proposed}
          </Badge>
        </td>
        <td className="mono" style={{ fontSize: 12, color: fellBack ? 'var(--amber-ink)' : 'var(--muted)' }}>
          {turn.source}
        </td>
        <td className="mono" style={{ fontSize: 12, textAlign: 'right' }}>
          {turn.latencyMs ?? '—'}
        </td>
        <td dir="auto" style={{ maxWidth: 380, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {turn.latestText ?? '—'}
        </td>
      </tr>
      {open && (
        <tr className="detail">
          <td colSpan={6} style={{ background: 'var(--surface-2)', padding: '12px 16px 14px' }}>
            <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 6 }}>
              workflow <span className="mono">{turn.workflowId}</span> · {turn.conversationId}
            </div>
            <pre className="mono" style={{ margin: 0, fontSize: 12, whiteSpace: 'pre-wrap' }}>
              {turn.answers === null ? 'Jev not asked (pre-rule) or failed (fallback).' : JSON.stringify(turn.answers, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </Fragment>
  );
}
