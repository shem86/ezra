// Database browser — read-only direct SELECT over the real tables, served live
// by /api/db/:table (BO-7). The handler→client→screen slice this establishes is
// the template the B2 screens copy. Approve/Edit controls stay disabled.
import { useEffect, useMemo, useState } from 'react';
import { Icon, type IconName } from '../components/icon';
import { Badge, Card, Cell } from '../components/primitives';
import { api, type ApiClient } from '../api/client';
import type { Row, TableListing, TableMeta } from '../api/types';

export function DatabaseScreen({ client = api }: { client?: ApiClient }): React.JSX.Element {
  const [tables, setTables] = useState<TableMeta[]>([]);
  const [active, setActive] = useState('');
  const [listing, setListing] = useState<TableListing | null>(null);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Row | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    client
      .catalogue(ac.signal)
      .then((c) => {
        setTables(c.tables);
        setActive((prev) => prev || c.tables[0]?.table || '');
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) setError(e instanceof Error ? e.message : 'failed to load tables');
      });
    return () => ac.abort();
  }, [client]);

  useEffect(() => {
    if (!active) return;
    const ac = new AbortController();
    setLoading(true);
    setSel(null);
    setQ('');
    client
      .table(active, 200, ac.signal)
      .then((l) => {
        setListing(l);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!ac.signal.aborted) {
          setListing(null);
          setError(e instanceof Error ? e.message : 'failed to load table');
        }
      })
      .finally(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
    return () => ac.abort();
  }, [active, client]);

  const rows = useMemo(() => {
    if (listing === null) return [];
    if (!q.trim()) return listing.rows;
    const s = q.toLowerCase();
    return listing.rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(s)));
  }, [listing, q]);

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '210px 1fr', gap: 18, alignItems: 'start' }}>
      <Card pad={8} style={{ position: 'sticky', top: 0 }}>
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
            padding: '8px 10px 10px',
          }}
        >
          Tables
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {tables.map((t) => (
            <button
              key={t.table}
              onClick={() => setActive(t.table)}
              className="tablebtn"
              style={{
                background: t.table === active ? 'var(--accent-soft)' : 'none',
                color: t.table === active ? 'var(--accent-ink)' : 'var(--ink)',
              }}
            >
              <Icon name={t.icon as IconName} size={15} />
              <span style={{ flex: 1, textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                {t.label}
              </span>
            </button>
          ))}
        </div>
      </Card>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 19, fontWeight: 600 }}>
            {listing?.label ?? active ?? '—'}
          </h2>
          <Badge mono>
            <Icon name="lock" size={11} /> read-only
          </Badge>
          <span style={{ fontSize: 12, color: 'var(--muted-2)' }}>bypassing the agent</span>
          <div style={{ flex: 1 }} />
          <div className="searchbox">
            <Icon name="search" size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter rows…" />
          </div>
        </div>

        {error !== null && (
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--err)',
              background: 'color-mix(in oklch, var(--err) 8%, var(--surface))',
              border: '1px solid color-mix(in oklch, var(--err) 30%, var(--border))',
              borderRadius: 8,
              padding: '9px 12px',
            }}
          >
            {error === 'unauthorized'
              ? 'Unauthorized — open this console with ?token=… to sign in.'
              : `Could not load data: ${error}`}
          </div>
        )}

        <Card pad={0} style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="grid">
              <thead>
                <tr>
                  {(listing?.columns ?? []).map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr
                    key={String(r['id'] ?? r['action_id'] ?? r['idempotency_key'] ?? r['seq'] ?? r['key'] ?? i)}
                    onClick={() => setSel(r)}
                    className={sel && sel === r ? 'on' : ''}
                  >
                    {(listing?.columns ?? []).map((c) => (
                      <td key={c}>
                        <Cell col={c} val={r[c]} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div
            style={{
              padding: '10px 16px',
              borderTop: '1px solid var(--border)',
              fontSize: 12,
              color: 'var(--muted)',
              display: 'flex',
              justifyContent: 'space-between',
            }}
          >
            <span>{loading ? 'loading…' : `${rows.length} of ${listing?.rows.length ?? 0} rows`}</span>
            <span style={{ fontFamily: 'var(--mono)' }}>
              SELECT * FROM {listing?.table ?? active}
              {q ? ` WHERE … '${q}'` : ''}
            </span>
          </div>
        </Card>
      </div>

      {sel && listing && <RowDrawer label={listing.label} icon={listing.icon} row={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function RowDrawer({
  label,
  icon,
  row,
  onClose,
}: {
  label: string;
  icon: string;
  row: Row;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <div className="drawer-wrap" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Icon name={icon as IconName} size={16} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600 }}>{label}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--muted)' }}>
              {String(row['id'] ?? row['action_id'] ?? row['idempotency_key'] ?? row['key'] ?? '')}
            </span>
          </div>
          <button className="iconbtn" onClick={onClose}>
            <Icon name="x" size={16} />
          </button>
        </div>
        <div style={{ padding: 20, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {Object.keys(row).map((k, i) => (
            <div
              key={k}
              style={{
                display: 'grid',
                gridTemplateColumns: '130px 1fr',
                gap: 14,
                padding: '11px 0',
                borderTop: i ? '1px solid var(--border)' : 'none',
                alignItems: 'start',
              }}
            >
              <span style={{ fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--muted)' }}>{k}</span>
              <div style={{ fontSize: 13.5 }}>
                <Cell col={k} val={row[k]} />
              </div>
            </div>
          ))}
        </div>
        {/* Read-only console: edit disabled (spec decision 1). */}
        <div style={{ padding: '14px 20px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost" disabled>
            Edit row
          </button>
          <span style={{ fontSize: 11.5, color: 'var(--muted-2)', alignSelf: 'center' }}>
            writes go through the agent's tool layer
          </span>
        </div>
      </div>
    </div>
  );
}
