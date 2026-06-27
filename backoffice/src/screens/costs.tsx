// Costs & tokenomics — Langfuse-derived. The BO-8 spike found Langfuse has no
// cost/model, so USD is ESTIMATED from token counts (labelled as such) and the
// per-model table degrades to per-usage-type. Token volume + cache-read split
// are real. Fetches /api/costs via the typed client.
import { Badge, BarChart, Card, SectionTitle } from '../components/primitives';
import { api, type ApiClient } from '../api/client';
import { useAsync } from '../api/use-async';
import type { CostsResponse } from '../api/types';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

export function CostsScreen({ client = api }: { client?: ApiClient }): React.JSX.Element {
  const { data, error, loading } = useAsync<CostsResponse>((signal) => client.costs(signal));

  if (error !== null) {
    return (
      <Card>
        <span style={{ color: 'var(--err)' }}>
          {error === 'unauthorized' ? 'Unauthorized — open with ?token=…' : `Could not load costs: ${error}`}
        </span>
      </Card>
    );
  }
  if (data === null) {
    return <Card>{loading ? 'Loading costs…' : 'No cost data.'}</Card>;
  }

  const c = data;
  const pct = Math.round((c.monthCostUsd / c.budgetUsd) * 100);
  const overBudget = c.monthCostUsd > c.budgetUsd;
  const totalByUsage = c.byUsage.reduce((a, r) => a + r.cost, 0) || 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ fontSize: 12, color: 'var(--muted-2)' }}>
        Spend is <strong>estimated</strong> from token volume × Sonnet-class pricing — Langfuse records
        usage but not cost or model for this project. Token counts and the cache split are exact.
      </div>
      <div className="grid-costs">
        <Card>
          <SectionTitle right={<Badge tone={overBudget ? 'amber' : 'ok'}>{overBudget ? 'over budget' : 'under budget'}</Badge>}>
            Month to date (est.)
          </SectionTitle>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 42, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: '-0.03em' }}>
              ${c.monthCostUsd.toFixed(2)}
            </span>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>/ ${c.budgetUsd}</span>
          </div>
          <div
            style={{
              height: 8,
              background: 'var(--surface-2)',
              borderRadius: 99,
              marginTop: 12,
              overflow: 'hidden',
              border: '1px solid var(--border)',
            }}
          >
            <div style={{ width: Math.min(100, pct) + '%', height: '100%', background: overBudget ? 'var(--amber)' : 'var(--ok)' }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            {pct}% of budget · vs ${c.lastMonthCostUsd.toFixed(2)} last month
          </div>
        </Card>
        <Card>
          <SectionTitle>Token economics</SectionTitle>
          <div style={{ display: 'flex', height: 12, borderRadius: 99, overflow: 'hidden', border: '1px solid var(--border)' }}>
            {c.tokenSplit.map((s) => (
              <div key={s.label} style={{ width: s.pct * 100 + '%', background: s.color }} title={s.label} />
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
            {c.tokenSplit.map((s) => (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: s.color }} />
                <span style={{ flex: 1, color: 'var(--muted)' }}>{s.label}</span>
                <span style={{ fontFamily: 'var(--mono)' }}>{Math.round(s.pct * 100)}%</span>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <SectionTitle>This month</SectionTitle>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--mono)' }}>{fmtTokens(c.tokensMonth)}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>tokens processed</div>
            </div>
            <div>
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--mono)' }}>{c.cacheReadPct}%</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>input from prompt cache</div>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <SectionTitle right={<span style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>daily · last 30 days (est.)</span>}>
          Spend over time
        </SectionTitle>
        <BarChart data={c.dailyCost} height={140} fmt={(v) => '$' + v.toFixed(3)} />
      </Card>

      <Card pad={0}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
          <SectionTitle>Estimated cost by usage type</SectionTitle>
        </div>
        <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>usage type</th>
              <th>price</th>
              <th style={{ textAlign: 'right' }}>tokens</th>
              <th style={{ textAlign: 'right' }}>est. cost</th>
              <th style={{ width: 160 }}>share</th>
            </tr>
          </thead>
          <tbody>
            {c.byUsage.map((r) => (
              <tr key={r.name}>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600 }}>{r.name}</td>
                <td style={{ color: 'var(--muted)', fontSize: 12.5 }}>{r.note}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5 }}>{fmtTokens(r.tokens)}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600 }}>
                  ${r.cost.toFixed(3)}
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, height: 6, background: 'var(--surface-2)', borderRadius: 99, overflow: 'hidden' }}>
                      <div style={{ width: r.share * 100 + '%', height: '100%', background: 'var(--accent)' }} />
                    </div>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)', width: 30, textAlign: 'right' }}>
                      {Math.round(r.share * 100)}%
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
        <div
          style={{
            padding: '12px 18px',
            borderTop: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: 12.5,
          }}
        >
          <span style={{ color: 'var(--muted)' }}>
            Per-model attribution isn't recorded in traces — figures are a token-priced estimate.
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>${totalByUsage.toFixed(3)}</span>
        </div>
      </Card>
    </div>
  );
}
