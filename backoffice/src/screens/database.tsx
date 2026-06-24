// Database browser — read-only direct SELECT over the real tables. Renders the
// fixture `tables` for now; BO-7 swaps in the typed /api/db/:table client.
import { useMemo, useState } from 'react';
import { Icon } from '../components/icon';
import { Badge, Card, Cell } from '../components/primitives';
import { tables as tablesFx, type Row, type TableFixture } from '../fixtures';

export function DatabaseScreen({
  tables = tablesFx,
}: {
  tables?: Record<string, TableFixture>;
}): React.JSX.Element {
  const keys = Object.keys(tables);
  const [active, setActive] = useState(keys[0] ?? '');
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<Row | null>(null);
  const tbl = tables[active];

  const rows = useMemo(() => {
    if (tbl === undefined) return [];
    if (!q.trim()) return tbl.rows;
    const s = q.toLowerCase();
    return tbl.rows.filter((r) => Object.values(r).some((v) => String(v).toLowerCase().includes(s)));
  }, [q, tbl]);

  if (tbl === undefined) {
    return <Card>No tables.</Card>;
  }

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
          {keys.map((k) => (
            <button
              key={k}
              onClick={() => {
                setActive(k);
                setSel(null);
                setQ('');
              }}
              className="tablebtn"
              style={{
                background: k === active ? 'var(--accent-soft)' : 'none',
                color: k === active ? 'var(--accent-ink)' : 'var(--ink)',
              }}
            >
              <Icon name={tables[k]!.icon as never} size={15} />
              <span style={{ flex: 1, textAlign: 'left', fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                {tables[k]!.label}
              </span>
              <span style={{ fontSize: 11, color: 'var(--muted-2)', fontFamily: 'var(--mono)' }}>
                {tables[k]!.rows.length}
              </span>
            </button>
          ))}
        </div>
      </Card>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: 19, fontWeight: 600 }}>{tbl.label}</h2>
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

        {tbl.note && (
          <div
            style={{
              fontSize: 12.5,
              color: 'var(--muted)',
              background: 'var(--surface-2)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '9px 12px',
              lineHeight: 1.5,
            }}
          >
            {tbl.note}
          </div>
        )}

        <Card pad={0} style={{ overflow: 'hidden' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="grid">
              <thead>
                <tr>
                  {tbl.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={String(r['id'] ?? JSON.stringify(r))}
                    onClick={() => setSel(r)}
                    className={sel && sel['id'] === r['id'] ? 'on' : ''}
                  >
                    {tbl.columns.map((c) => (
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
            <span>
              {rows.length} of {tbl.rows.length} rows
            </span>
            <span style={{ fontFamily: 'var(--mono)' }}>
              SELECT * FROM {tbl.label}
              {q ? ` WHERE … '${q}'` : ''}
            </span>
          </div>
        </Card>
      </div>

      {sel && <RowDrawer table={tbl} row={sel} onClose={() => setSel(null)} />}
    </div>
  );
}

function RowDrawer({
  table,
  row,
  onClose,
}: {
  table: TableFixture;
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
            <Icon name={table.icon as never} size={16} />
            <span style={{ fontFamily: 'var(--mono)', fontSize: 14, fontWeight: 600 }}>{table.label}</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--muted)' }}>
              {String(row['id'] ?? '')}
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
