// Costs & tokenomics — Langfuse-derived MTD spend, daily bars, per-model table,
// token-economics split. Renders fixtures for now; BO-9 wires /api/costs.
import { Badge, BarChart, Card, SectionTitle } from '../components/primitives';
import {
  dailyCost as dailyCostFx,
  kpis as kpisFx,
  models as modelsFx,
  tokenSplit as tokenSplitFx,
  type Kpis,
  type ModelCost,
  type TokenSplitSlice,
} from '../fixtures';

export interface CostsData {
  kpis: Kpis;
  dailyCost: number[];
  models: ModelCost[];
  tokenSplit: TokenSplitSlice[];
}

const FIXTURE_DATA: CostsData = {
  kpis: kpisFx,
  dailyCost: dailyCostFx,
  models: modelsFx,
  tokenSplit: tokenSplitFx,
};

export function CostsScreen({ data = FIXTURE_DATA }: { data?: CostsData }): React.JSX.Element {
  const k = data.kpis;
  const pct = Math.round((k.monthCost / k.budget) * 100);
  const totalModel = data.models.reduce((a, m) => a + m.cost, 0) || 1;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1.2fr 1fr 1fr', gap: 16 }}>
        <Card>
          <SectionTitle right={<Badge tone="ok">under budget</Badge>}>Month to date</SectionTitle>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
            <span style={{ fontSize: 42, fontWeight: 700, fontFamily: 'var(--mono)', letterSpacing: '-0.03em' }}>
              ${k.monthCost.toFixed(2)}
            </span>
            <span style={{ fontSize: 13, color: 'var(--muted)' }}>/ ${k.budget}</span>
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
            <div style={{ width: pct + '%', height: '100%', background: 'var(--ok)' }} />
          </div>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 8 }}>
            {pct}% of budget · vs ${k.lastMonthCost.toFixed(2)} last month
          </div>
        </Card>
        <Card>
          <SectionTitle>Token economics</SectionTitle>
          <div style={{ display: 'flex', height: 12, borderRadius: 99, overflow: 'hidden', border: '1px solid var(--border)' }}>
            {data.tokenSplit.map((s) => (
              <div key={s.label} style={{ width: s.pct * 100 + '%', background: s.color }} title={s.label} />
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 14 }}>
            {data.tokenSplit.map((s) => (
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
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--mono)' }}>{k.tokensMonth}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>tokens processed</div>
            </div>
            <div>
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'var(--mono)' }}>{k.cacheReadPct}%</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>input from prompt cache</div>
            </div>
          </div>
        </Card>
      </div>

      <Card>
        <SectionTitle right={<span style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>daily · last 30 days</span>}>
          Spend over time
        </SectionTitle>
        <BarChart data={data.dailyCost} height={140} fmt={(v) => '$' + v.toFixed(2)} />
      </Card>

      <Card pad={0}>
        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border)' }}>
          <SectionTitle>Cost by model</SectionTitle>
        </div>
        <table className="grid">
          <thead>
            <tr>
              <th>model</th>
              <th>role</th>
              <th style={{ textAlign: 'right' }}>calls</th>
              <th style={{ textAlign: 'right' }}>tokens</th>
              <th style={{ textAlign: 'right' }}>cost</th>
              <th style={{ width: 160 }}>share</th>
            </tr>
          </thead>
          <tbody>
            {data.models.map((m, i) => (
              <tr key={m.name + i}>
                <td style={{ fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600 }}>{m.name}</td>
                <td style={{ color: 'var(--muted)', fontSize: 12.5 }}>{m.role}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5 }}>
                  {m.calls.toLocaleString()}
                </td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5 }}>{m.tokens}</td>
                <td style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12.5, fontWeight: 600 }}>
                  ${m.cost.toFixed(2)}
                </td>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, height: 6, background: 'var(--surface-2)', borderRadius: 99, overflow: 'hidden' }}>
                      <div style={{ width: (m.cost / totalModel) * 100 + '%', height: '100%', background: 'var(--accent)' }} />
                    </div>
                    <span style={{ fontFamily: 'var(--mono)', fontSize: 11.5, color: 'var(--muted)', width: 30, textAlign: 'right' }}>
                      {Math.round((m.cost / totalModel) * 100)}%
                    </span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
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
            A turn-router was removed once traces showed it forfeited the prompt cache for no real saving.
          </span>
          <span style={{ fontFamily: 'var(--mono)', fontWeight: 700 }}>${totalModel.toFixed(2)}</span>
        </div>
      </Card>
    </div>
  );
}
