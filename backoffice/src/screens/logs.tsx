// Logs — durable turn list (DBOS journal) + Langfuse enrichment. Renders the
// fixture `logs` for now; BO-10 wires /api/logs. Missing fields render `—`.
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../components/icon';
import { Badge, Card, Dot } from '../components/primitives';
import { sColor, tierTone } from '../components/status';
import { logs as logsFx, type LogRow } from '../fixtures';

const HEBREW = /[֐-׿]/;
type Level = 'all' | 'info' | 'warn' | 'error';

export function LogsScreen({ logs = logsFx }: { logs?: LogRow[] }): React.JSX.Element {
  const [lvl, setLvl] = useState<Level>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const rows = useMemo(
    () =>
      logs.filter(
        (r) =>
          (lvl === 'all' || r.level === lvl) &&
          (!q.trim() || (r.summary + r.trigger + r.tool).toLowerCase().includes(q.toLowerCase())),
      ),
    [lvl, q, logs],
  );

  const counts: Record<Level, number> = { all: logs.length, info: 0, warn: 0, error: 0 };
  for (const r of logs) counts[r.level]++;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div
          style={{
            display: 'flex',
            gap: 4,
            background: 'var(--surface-2)',
            padding: 4,
            borderRadius: 9,
            border: '1px solid var(--border)',
          }}
        >
          {(['all', 'info', 'warn', 'error'] as Level[]).map((l) => (
            <button
              key={l}
              onClick={() => setLvl(l)}
              className="seg"
              style={{
                background: lvl === l ? 'var(--surface)' : 'transparent',
                boxShadow: lvl === l ? '0 1px 2px rgba(0,0,0,.06)' : 'none',
                color: lvl === l ? 'var(--ink)' : 'var(--muted)',
              }}
            >
              {l !== 'all' && <Dot status={l} size={7} />}
              {l}
              <span style={{ opacity: 0.5, fontFamily: 'var(--mono)', fontSize: 11 }}>{counts[l]}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <div className="searchbox">
          <Icon name="search" size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search turns…" />
        </div>
        <button className="iconbtn" title="Live">
          <Icon name="refresh" size={15} />
        </button>
      </div>

      <Card pad={0} style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="grid logs">
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th>time</th>
                <th>trigger</th>
                <th>summary</th>
                <th>tool · tier</th>
                <th style={{ textAlign: 'right' }}>tokens</th>
                <th style={{ textAlign: 'right' }}>cache</th>
                <th style={{ textAlign: 'right' }}>cost</th>
                <th style={{ textAlign: 'right' }}>ms</th>
                <th>status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <Fragment key={r.id}>
                  <tr onClick={() => setOpen(open === r.id ? null : r.id)} className={open === r.id ? 'on' : ''}>
                    <td>
                      <Dot status={r.level} />
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                      {r.ts}
                    </td>
                    <td style={{ whiteSpace: 'nowrap', fontSize: 12.5 }}>{r.trigger}</td>
                    <td style={{ direction: HEBREW.test(r.summary) ? 'rtl' : 'ltr', unicodeBidi: 'plaintext' }}>
                      {r.summary}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.tool}</span>
                        <Badge tone={tierTone(r.tier)} mono>
                          {r.tier}
                        </Badge>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {r.tokens ? (r.tokens / 1000).toFixed(1) + 'k' : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {r.cache ? r.cache + '%' : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {r.cost ? '$' + r.cost.toFixed(3) : '—'}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontFamily: 'var(--mono)',
                        fontSize: 12,
                        color: r.ms > 4000 ? 'var(--amber-ink)' : 'var(--muted)',
                      }}
                    >
                      {r.ms || '—'}
                    </td>
                    <td>
                      <Badge tone={sColor(r.st) === 'var(--ok)' ? 'ok' : 'amber'}>{r.st}</Badge>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr className="detail">
                      <td colSpan={10}>
                        <div
                          style={{
                            padding: '4px 8px 14px',
                            display: 'grid',
                            gridTemplateColumns: 'repeat(4, 1fr)',
                            gap: 18,
                          }}
                        >
                          <Detail k="Turn id" v={r.id} mono />
                          <Detail k="Workflow" v={r.st} />
                          <Detail k="Tool tier" v={r.tier} mono />
                          <Detail k="Latency" v={r.ms ? r.ms + ' ms' : '—'} mono />
                          <Detail k="Total tokens" v={r.tokens ? r.tokens.toLocaleString() : '—'} mono />
                          <Detail k="Cache read" v={r.cache ? r.cache + '%' : '—'} mono />
                          <Detail k="Cost" v={r.cost ? '$' + r.cost.toFixed(4) : '—'} mono />
                          <Detail
                            k="Trace"
                            v={
                              <span className="link">
                                Langfuse <Icon name="ext" size={12} />
                              </span>
                            }
                          />
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding: '10px 16px', borderTop: '1px solid var(--border)', fontSize: 12, color: 'var(--muted)' }}>
          {rows.length} turns · click a row for the trace
        </div>
      </Card>
    </div>
  );
}

function Detail({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ fontSize: 11, color: 'var(--muted)', letterSpacing: '0.02em' }}>{k}</span>
      <span style={{ fontSize: 13, fontFamily: mono ? 'var(--mono)' : 'inherit' }}>{v}</span>
    </div>
  );
}
