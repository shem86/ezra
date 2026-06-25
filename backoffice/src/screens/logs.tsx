// Logs — durable turn list from the DBOS journal, enriched from Langfuse.
// Fetches /api/logs. Fields Langfuse can't supply (tokens/cache/cost/tool/tier)
// render `—`; the journal always supplies id/status/timing.
import { Fragment, useMemo, useState, type ReactNode } from 'react';
import { Icon } from '../components/icon';
import { Badge, Card, Dot } from '../components/primitives';
import { sColor, tierTone } from '../components/status';
import { api, type ApiClient } from '../api/client';
import { useAsync } from '../api/use-async';
import type { LogsResponse } from '../api/types';

type Level = 'all' | 'info' | 'warn' | 'error';

function fmtTs(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function LogsScreen({ client = api }: { client?: ApiClient }): React.JSX.Element {
  const { data, error, loading } = useAsync<LogsResponse>((signal) => client.logs(200, signal));
  const [lvl, setLvl] = useState<Level>('all');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const turns = data?.turns ?? [];
  const rows = useMemo(
    () =>
      turns.filter(
        (r) =>
          (lvl === 'all' || r.level === lvl) &&
          (!q.trim() || (r.id + (r.tool ?? '') + r.st).toLowerCase().includes(q.toLowerCase())),
      ),
    [lvl, q, turns],
  );

  const counts: Record<Level, number> = { all: turns.length, info: 0, warn: 0, error: 0 };
  for (const r of turns) counts[r.level]++;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {error !== null && (
        <Card>
          <span style={{ color: 'var(--err)' }}>
            {error === 'unauthorized' ? 'Unauthorized — open with ?token=…' : `Could not load logs: ${error}`}
          </span>
        </Card>
      )}
      {data !== null && !data.enriched && (
        <div style={{ fontSize: 12, color: 'var(--muted-2)' }}>
          Token / cost / tier enrichment is unavailable right now (Langfuse read) — turns still list from the
          journal; those columns show —.
        </div>
      )}
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
      </div>

      <Card pad={0} style={{ overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <table className="grid logs">
            <thead>
              <tr>
                <th style={{ width: 30 }}></th>
                <th>time</th>
                <th>turn id</th>
                <th>tool · tier</th>
                <th style={{ textAlign: 'right' }}>tokens</th>
                <th style={{ textAlign: 'right' }}>cache</th>
                <th style={{ textAlign: 'right' }}>est. cost</th>
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
                      {fmtTs(r.ts)}
                    </td>
                    <td style={{ fontFamily: 'var(--mono)', fontSize: 12, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {r.id}
                    </td>
                    <td>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <span style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{r.tool ?? '—'}</span>
                        {r.tier && (
                          <Badge tone={tierTone(r.tier)} mono>
                            {r.tier}
                          </Badge>
                        )}
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {r.tokens ? (r.tokens / 1000).toFixed(1) + 'k' : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {r.cache !== null ? r.cache + '%' : '—'}
                    </td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>
                      {r.cost ? '$' + r.cost.toFixed(3) : '—'}
                    </td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontFamily: 'var(--mono)',
                        fontSize: 12,
                        color: r.ms !== null && r.ms > 4000 ? 'var(--amber-ink)' : 'var(--muted)',
                      }}
                    >
                      {r.ms ?? '—'}
                    </td>
                    <td>
                      <Badge tone={sColor(r.st) === 'var(--ok)' ? 'ok' : sColor(r.st) === 'var(--err)' ? 'err' : 'amber'}>
                        {r.st}
                      </Badge>
                    </td>
                  </tr>
                  {open === r.id && (
                    <tr className="detail">
                      <td colSpan={9}>
                        <div style={{ padding: '4px 8px 14px', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 18 }}>
                          <Detail k="Turn id" v={r.id} mono />
                          <Detail k="Status" v={r.st} />
                          <Detail k="Tool tier" v={r.tier ?? '—'} mono />
                          <Detail k="Latency" v={r.ms !== null ? r.ms + ' ms' : '—'} mono />
                          <Detail k="Total tokens" v={r.tokens ? r.tokens.toLocaleString() : '—'} mono />
                          <Detail k="Cache read" v={r.cache !== null ? r.cache + '%' : '—'} mono />
                          <Detail k="Est. cost" v={r.cost ? '$' + r.cost.toFixed(4) : '—'} mono />
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
          {loading ? 'loading…' : `${rows.length} turns · click a row for details`}
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
