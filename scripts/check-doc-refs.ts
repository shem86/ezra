/**
 * Reference check for the docs that assert current state.
 *
 * Docs rot in two different ways and only one of them is mechanically
 * checkable:
 *
 *   - REFERENTIAL — the doc points at something that no longer matches (a
 *     moved file, a renamed symbol, a shifted line number). Deterministic,
 *     cheap, and exactly what this script covers.
 *   - SEMANTIC — the doc asserts a state the world contradicts ("gate —
 *     evaluate before flipping" a week after the repo went public). No grep
 *     reaches that. It stays a human reconcile; see STATUS.md.
 *
 * The load-bearing detail is WHEN this runs. STATUS.md's references were
 * invalidated by PR #35, which changed `src/main.ts`, `src/transport/baileys.ts`
 * and one test — and not a single line of markdown. A check that runs on doc
 * PRs would have been green through the very failure that motivated it, so
 * this is wired into `ci.yml` (fires on code changes, which `paths-ignore`
 * exempts from nothing but docs) *and* `docs.yml` (fires on the complement).
 * Together they cover every PR; neither alone does.
 *
 * Assertions:
 *   A. every relative markdown link resolves                    (all *.md)
 *   B. every cited repo path exists                             (STATE_DOCS)
 *   C. every cited src/ or tests/ path is bound to a symbol,
 *      and that symbol still greps in that file                 (STATUS.md)
 *   D. no bare `file.ts:NNN` citations                          (STATE_DOCS)
 *
 * C is the anti-silent-degradation rule. A check that quietly stops checking
 * when prose is rephrased is worse than no check — that is precisely how the
 * date-based staleness check this replaces would have failed. So a cited code
 * path with no resolvable symbol bound to it is an ERROR, not a skip.
 *
 * Escape hatch: `<!-- refcheck:off -->` … `<!-- refcheck:on -->` blanks a
 * region for every assertion. Used where a doc deliberately quotes rotted
 * references as examples (STATUS.md house rule 5).
 *
 * Run: pnpm check:docs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'

/** Docs that assert current state. History (V2_NOTES, TASKS, ADRs) is exempt:
 *  a line number that was true when written is a fact about the past. */
const STATE_DOCS = ['STATUS.md', 'CLAUDE.md', 'README.md']

/** Only STATUS.md carries per-claim code citations, and house rule 5 governs
 *  how they are written. Requiring symbol binding in CLAUDE.md would force
 *  architectural prose into an awkward shape for no gain. */
const SYMBOL_DOC = 'STATUS.md'

/** Top-level dirs a backticked path token may start with. Anything else is
 *  prose, not a path. */
const REPO_ROOTS = [
  'src', 'tests', 'infra', 'docs', 'migrations', 'evals', 'spikes',
  'eslint-rules', '.github', '.claude',
]

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
  encoding: 'utf8',
}).trim()

const trackedMarkdown = execFileSync('git', ['ls-files', '*.md'], {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split('\n')
  .filter(Boolean)

const failures: string[] = []
const counts = { links: 0, paths: 0, symbols: 0, files: 0 }

const fail = (file: string, line: number, message: string): void => {
  failures.push(`${file}:${line}  ${message}`)
}

/** Blank refcheck:off regions in place, preserving line and column offsets so
 *  reported line numbers stay accurate. */
const maskDisabledRegions = (text: string): string => {
  const region = /<!--\s*refcheck:off\s*-->[\s\S]*?<!--\s*refcheck:on\s*-->/g
  return text.replace(region, (match) => match.replace(/[^\n]/g, ' '))
}

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split('\n').length

// ── A. relative links resolve ────────────────────────────────────────────────
const checkLinks = (file: string, text: string): void => {
  const link = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const match of text.matchAll(link)) {
    const target = match[1]
    if (/^(https?:|mailto:|#)/.test(target)) continue
    counts.links++
    const path = target.split('#')[0]
    if (!path) continue
    const abs = resolve(repoRoot, join(dirname(file), path))
    if (!existsSync(abs)) {
      fail(file, lineOf(text, match.index), `broken link → ${target}`)
    }
  }
}

// ── path tokens ──────────────────────────────────────────────────────────────
const isRepoPath = (token: string): boolean => {
  if (!/^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*\/?$/.test(token)) return false
  const head = token.split('/')[0]
  return token.includes('/') && REPO_ROOTS.includes(head)
}

const citedPaths = (text: string): { path: string; index: number }[] =>
  [...text.matchAll(/`([^`\n]+)`/g)]
    .filter((m) => isRepoPath(m[1]))
    .map((m) => ({ path: m[1].replace(/\/$/, ''), index: m.index }))

// ── B. cited paths exist ─────────────────────────────────────────────────────
const checkPaths = (file: string, text: string): void => {
  for (const { path, index } of citedPaths(text)) {
    counts.paths++
    if (!existsSync(resolve(repoRoot, path))) {
      fail(file, lineOf(text, index), `cited path does not exist → ${path}`)
    }
  }
}

// ── C. cited code paths are bound to a symbol that still resolves ────────────
/** Does `symbol` still appear in `path`? Tries the literal text first, then
 *  falls back to the parts of a dotted reference (`IngestionDeps.wasSentByBot`
 *  reads naturally in prose but is two separate tokens in the source). */
const symbolResolves = (symbol: string, path: string): boolean => {
  // A missing file is already reported by assertion B; don't crash on it here.
  const abs = resolve(repoRoot, path)
  if (!existsSync(abs)) return true
  const body = readFileSync(abs, 'utf8')
  if (body.includes(symbol)) return true
  const bare = symbol.replace(/\(\)$/, '')
  if (body.includes(bare)) return true
  const parts = bare.split('.').filter((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p))
  return parts.length > 1 && parts.every((part) => body.includes(part))
}

const checkSymbolBindings = (file: string, text: string): void => {
  // Prose wraps across lines, so flatten whitespace before matching. Line
  // numbers come from the unflattened text via the path index.
  const flat = text.replace(/\s+/g, ' ')
  const bound = new Map<string, string[]>()

  // `symbol` … in `path` — up to 60 chars of connective prose between them
  // ("the `X` wiring in `path`", "(declared and checked in `path`)").
  for (const m of flat.matchAll(/`([^`]+)`[^`]{0,60}?\bin\s+`([^`]+)`/g)) {
    const [, symbol, path] = m
    if (!isRepoPath(path)) continue
    bound.set(path, [...(bound.get(path) ?? []), symbol])
  }

  for (const { path, index } of citedPaths(text)) {
    if (!/^(src|tests)\//.test(path)) continue
    const line = lineOf(text, index)
    const symbols = bound.get(path)
    if (!symbols) {
      fail(
        file,
        line,
        `code path cited with no symbol bound to it → ${path}\n` +
          `        House rule 5: cite a symbol, not a location. ` +
          `Phrase it as \`someSymbol\` … in \`${path}\`.`,
      )
      continue
    }
    for (const symbol of symbols) {
      counts.symbols++
      if (!symbolResolves(symbol, path)) {
        fail(file, line, `symbol no longer found in ${path} → \`${symbol}\``)
      }
    }
  }
}

// ── D. no bare line-number citations ─────────────────────────────────────────
const checkLineNumbers = (file: string, text: string): void => {
  const cite = /`[^`\n]*?[A-Za-z0-9_./-]+\.(?:ts|js|sh|sql|ya?ml|md):\d+[^`\n]*`/g
  for (const match of text.matchAll(cite)) {
    fail(
      file,
      lineOf(text, match.index),
      `line-number citation → ${match[0]}\n` +
        `        House rule 5: line numbers rot silently. Cite a symbol.`,
    )
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
for (const file of trackedMarkdown) {
  const text = maskDisabledRegions(readFileSync(resolve(repoRoot, file), 'utf8'))
  counts.files++
  checkLinks(file, text)
  if (STATE_DOCS.includes(file)) {
    checkPaths(file, text)
    checkLineNumbers(file, text)
  }
  if (file === SYMBOL_DOC) checkSymbolBindings(file, text)
}

// Counts are printed on success too: a check that silently stops checking is
// the failure mode this replaces. If `symbols` drops to 0, something is wrong
// with the check, not with the docs.
console.log(
  `doc refs: ${counts.files} files · ${counts.links} links · ` +
    `${counts.paths} paths · ${counts.symbols} symbols`,
)

if (failures.length > 0) {
  console.error(`\n${failures.length} reference problem(s):\n`)
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('')
  process.exit(1)
}

console.log('all references resolve')
