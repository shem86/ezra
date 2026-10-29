// `pnpm eval:route`, part 1 — Jev router accuracy (docs/specs/jev-turn-routing-plan.md §8a).
// Live Jev over the labelled cases, through the SHIPPING code: turnRouteQuestions,
// renderRouteState, makeJevClient, toRouteAnswers, decideTier. Costs fractions
// of a cent; never CI (no live calls in CI — testing.md). Skips without a key.
//
// The GATE reads the holdout split only (every third case per language — never
// looked at while tuning wording): zero cases harder than fast routed fast,
// and at most one tier miss per language. The tune split and every per-question
// agreement are REPORTED, not gated — read individual answers, not only totals.
//
// Re-run on any change to src/agent/turn-route.ts, the Jev pin, a tier model,
// or these fixtures (.claude/rules/testing.md "Routing evals"); put the report
// in the PR.

import { readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeJevClient, DEFAULT_JEV_MODEL } from '../src/agent/jev-client.ts';
import {
  decideTier,
  renderRouteState,
  routeQuestionsVersion,
  routeThresholds,
  toRouteAnswers,
  turnRouteQuestions,
  type RouteAnswers,
  type Tier,
} from '../src/agent/turn-route.ts';
import { readTurnRouteEvalEnv } from './harness/eval-env.ts';

interface Case {
  readonly id: string;
  readonly lang: 'en' | 'he' | 'mixed';
  readonly tier: Tier;
  readonly recent: ReadonlyArray<{ readonly from: string; readonly text: string }>;
  readonly latest: ReadonlyArray<{ readonly from: string; readonly text: string }>;
  readonly expect: Readonly<Record<string, boolean | string | null>>;
}

interface Row {
  readonly c: Case;
  readonly holdout: boolean;
  readonly routed: Tier;
  readonly answers: RouteAnswers;
  readonly ms: number;
  readonly model: string;
  readonly inputTokens: number;
}

const env = readTurnRouteEvalEnv();
const cases: Case[] = (
  JSON.parse(
    readFileSync(new URL('./fixtures/turn-route/phase1-cases.json', import.meta.url), 'utf8'),
  ) as { cases: Case[] }
).cases;
const isHoldout = (c: Case): boolean => Number(c.id.split('-')[1]) % 3 === 0;
const langs = ['en', 'he', 'mixed'] as const;

// wire question id → RouteAnswers field
const fields: Record<string, keyof RouteAnswers> = {
  asks_anything: 'asksAnything',
  intent: 'intent',
  several_requests: 'severalRequests',
  refers_back: 'refersBack',
  weighs_options: 'weighsOptions',
  schedule_reasoning: 'scheduleReasoning',
  corrects_previous: 'correctsPrevious',
};

const rows: Row[] = [];

describe.skipIf(env.typesafeApiKey === undefined)('turn routing — Jev accuracy', () => {
  beforeAll(async () => {
    const jev = makeJevClient({
      apiKey: env.typesafeApiKey!,
      model: env.jevModel ?? DEFAULT_JEV_MODEL,
    });
    // Sequential: per-request latency is part of the report.
    for (const c of cases) {
      const started = performance.now();
      const response = await jev.ask(
        renderRouteState({ recent: c.recent, latest: c.latest }),
        turnRouteQuestions,
      );
      const answers = toRouteAnswers(response.answers);
      rows.push({
        c,
        holdout: isHoldout(c),
        routed: decideTier(answers),
        answers,
        ms: Math.round(performance.now() - started),
        model: response.model,
        inputTokens: response.inputTokens,
      });
    }
  }, 300_000);

  afterAll(() => {
    if (rows.length === 0) return;
    const report = renderReport(rows);
    process.stdout.write(`\n${report}\n`);
    if (env.reportPath !== undefined) writeFileSync(env.reportPath, `${report}\n`);
  });

  it('holdout: no case harder than fast is routed fast (the asymmetric gate)', () => {
    const dangerous = rows.filter((r) => r.holdout && r.routed === 'fast' && r.c.tier !== 'fast');
    expect(dangerous.map((r) => `${r.c.id} ${r.c.tier}→fast`)).toEqual([]);
  });

  it.each(langs)('holdout (%s): at most one tier miss', (lang) => {
    const misses = rows.filter((r) => r.holdout && r.c.lang === lang && r.routed !== r.c.tier);
    expect(misses.length, misses.map((r) => `${r.c.id} ${r.c.tier}→${r.routed}`).join(', ')).toBeLessThanOrEqual(1);
  });
});

function renderReport(all: readonly Row[]): string {
  const out: string[] = [];
  out.push(
    `turn-route eval · ${[...new Set(all.map((r) => r.model))].join(',')} · questions ${routeQuestionsVersion} · n=${all.length}`,
  );

  out.push('', 'Tier routing (exact / n · fast-on-harder):');
  for (const split of ['tune', 'holdout'] as const) {
    for (const lang of langs) {
      const rs = all.filter((r) => r.c.lang === lang && r.holdout === (split === 'holdout'));
      const exact = rs.filter((r) => r.routed === r.c.tier).length;
      const danger = rs.filter((r) => r.routed === 'fast' && r.c.tier !== 'fast').length;
      out.push(`  ${split.padEnd(8)} ${lang.padEnd(6)} ${exact}/${rs.length} · ${danger}`);
    }
  }

  out.push('', 'Per-question agreement, all splits (ok/n [unsettled]):');
  for (const [wire, field] of Object.entries(fields)) {
    const cells = langs.map((lang) => {
      let ok = 0;
      let n = 0;
      let unsettled = 0;
      for (const r of all.filter((x) => x.c.lang === lang)) {
        const want = r.c.expect[wire];
        if (want === null || want === undefined) continue;
        n++;
        const got = r.answers[field];
        if (typeof got === 'string') {
          if (got === want) ok++;
        } else if (want ? got > routeThresholds.yes : got < routeThresholds.no) {
          ok++;
        } else if (got >= routeThresholds.no && got <= routeThresholds.yes) {
          unsettled++;
        }
      }
      return `${ok}/${n}${unsettled > 0 ? ` [${unsettled}]` : ''}`.padEnd(10);
    });
    out.push(`  ${wire.padEnd(20)}${cells.join('')}`);
  }

  out.push('', 'Misses (tier, then question):');
  for (const r of all) {
    const tag = `${r.c.id}${r.holdout ? '*' : ''}`;
    if (r.routed !== r.c.tier) out.push(`  ${tag} tier ${r.c.tier}→${r.routed}`);
    for (const [wire, field] of Object.entries(fields)) {
      const want = r.c.expect[wire];
      if (want === null || want === undefined) continue;
      const got = r.answers[field];
      const miss =
        typeof got === 'string'
          ? got !== want
          : !(want ? got > routeThresholds.yes : got < routeThresholds.no);
      if (miss) out.push(`  ${tag} ${wire}: ${typeof got === 'number' ? got.toFixed(2) : got} want ${String(want)}`);
    }
  }

  const lat = all.map((r) => r.ms).sort((a, b) => a - b);
  const pct = (p: number): number => lat[Math.min(lat.length - 1, Math.floor((p / 100) * lat.length))]!;
  const tokens = all.reduce((s, r) => s + r.inputTokens, 0);
  out.push(
    '',
    `latency ms p50 ${pct(50)} · p95 ${pct(95)} · max ${lat.at(-1)} · ${tokens} input tokens ($${((tokens * 0.042) / 1e6).toFixed(5)})`,
    '(* = holdout)',
  );
  return out.join('\n');
}
