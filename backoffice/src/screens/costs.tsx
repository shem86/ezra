// Costs & tokenomics — Langfuse-derived. The BO-8 spike found Langfuse has no
// cost/model, so USD is ESTIMATED from token counts (labelled as such) and the
// per-model table degrades to per-usage-type. Token volume + cache-read split
// are real. Fetches /api/costs via the typed client.
//
// Charts are TanStack Charts (src/charts): the hand-rolled BarChart, the 12px
// stacked <div>, and the table's inline width:pct% bars are all gone. The
// series palette changed with them — the old one reused the UI's semantic
// tokens and failed CVD separation on the fresh-input/cache-read pair, which is
// the one comparison this screen exists to make.
import { Badge, Card, SectionTitle } from '../components/primitives';
import { SpendChart } from '../charts/spend-chart';
import { SplitBar, UsageBars } from '../charts/usage-charts';
import { usageColor } from '../charts/palette';
import { api, type ApiClient } from '../api/client';
import { useAsync } from '../api/use-async';
import type { CostsResponse } from '../api/types';

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}

/**
 * Straight-line projection of month-end spend from what's been spent so far.
 * The budget question is "am I going to blow it", which the MTD figure alone
 * cannot answer — $9 on the 3rd and $9 on the 28th are very different months.
 */
export function projectMonthEnd(monthCostUsd: number, today = new Date()): number {
  const elapsed = today.getDate();
  const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  if (elapsed <= 0) return monthCostUsd;
  return (monthCostUsd / elapsed) * daysInMonth;
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
  const projected = projectMonthEnd(c.monthCostUsd);
  const projectedOver = projected > c.budgetUsd;
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
          <div style={{ fontSize: 12, color: projectedOver ? 'var(--amber-ink)' : 'var(--muted)', marginTop: 6 }}>
            Projected month end{' '}
            <strong style={{ fontFamily: 'var(--mono)' }}>${projected.toFixed(2)}</strong> at this pace
          </div>
        </Card>
        <Card>
          <SectionTitle>Token economics</SectionTitle>
          <SplitBar split={c.tokenSplit} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
            {c.tokenSplit.map((s) => (
              <div key={s.label} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                <span style={{ width: 9, height: 9, borderRadius: 3, background: usageColor(s.label) }} />
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
        <SectionTitle right={<span style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>daily · last {c.dailyCost.length} days (est.)</span>}>
          Spend over time
        </SectionTitle>
        <div className="chart-host">
          <SpendChart dailyCost={c.dailyCost} budgetUsd={c.budgetUsd} height={168} />
        </div>
      </Card>

      <Card pad={0}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
          <SectionTitle>Estimated cost by usage type</SectionTitle>
          <div className="chart-host">
            <UsageBars rows={c.byUsage} height={Math.max(96, c.byUsage.length * 34)} />
          </div>
        </div>
        <div className="table-scroll">
        <table className="grid">
          <thead>
            <tr>
              <th>usage type</th>
              <th>price</th>
              <th style={{ textAlign: 'right' }}>tokens</th>
              <th style={{ textAlign: 'right' }}>est. cost</th>
              <th style={{ textAlign: 'right' }}>share</th>
            </tr>
          </thead>
          <tbody>
            {c.byUsage.map((r) => (
              <tr key={r.name}>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600 }}>
                  <span
                    style={{
                      display: 'inline-block',
                      width: 9,
                      height: 9,
                      borderRadius: 3,
                      background: usageColor(r.name),
                      marginRight: 8,
                    }}
                  />
                  {r.name}
                </td>
                <td style={{ color: 'var(--muted)', fontSize: 12.5 }}>{r.note}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5 }}>{fmtTokens(r.tokens)}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600 }}>
                  ${r.cost.toFixed(3)}
                </td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5, color: 'var(--muted)' }}>
                  {Math.round(r.share * 100)}%
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
