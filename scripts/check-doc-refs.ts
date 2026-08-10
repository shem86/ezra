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
 *   A. every relative markdown link resolves, inline and
 *      reference-style                                          (all *.md)
 *   B. every cited repo path exists                             (STATE_DOCS)
 *   C. every cited src/ or tests/ FILE is bound to a symbol,
 *      and that symbol still greps in that file                 (STATUS.md)
 *   D. no bare `file.ts:NNN` citations                          (STATE_DOCS)
 *   E. refcheck:off/on markers are balanced                     (all *.md)
 *
 * C is the anti-silent-degradation rule. A check that quietly stops checking
 * when prose is rephrased is worse than no check — that is precisely how the
 * date-based staleness check this replaces would have failed. So a cited code
 * path with no resolvable symbol bound to it is an ERROR, not a skip.
 *
 * Fenced code blocks are blanked for every assertion. A fence is quoted
 * material — a log, a transcript, an example — and quoting a broken link is
 * not the same as having one.
 *
 * Escape hatch: `<!-- refcheck:off -->` … `<!-- refcheck:on -->` blanks a
 * region for every assertion. Used where a doc deliberately quotes rotted
 * references as examples (STATUS.md house rule 5). Assertion E keeps the hatch
 * itself honest: an unclosed marker is reported rather than silently ignored.
 *
 * Run: pnpm check:docs
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync, statSync } from 'node:fs'
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

/** A cited path is only greppable if it is a regular file. Directories exist
 *  but have no contents to read — `readFileSync` on one throws EISDIR. */
const isFile = (abs: string): boolean =>
  existsSync(abs) && statSync(abs).isFile()

/** Paths are compared as map keys in two places (citations and symbol
 *  bindings), so both sides must agree on the trailing slash. */
const normalisePath = (path: string): string => path.replace(/\/$/, '')

/** Blank refcheck:off regions in place, preserving line and column offsets so
 *  reported line numbers stay accurate. */
const maskDisabledRegions = (text: string): string => {
  const region = /<!--\s*refcheck:off\s*-->[\s\S]*?<!--\s*refcheck:on\s*-->/g
  return text.replace(region, (match) => match.replace(/[^\n]/g, ' '))
}

/** Blank fenced code blocks, offsets preserved. A fence holds quoted material —
 *  a shell transcript, a log, an example command — not a claim about this repo,
 *  so a link or path inside one is not a reference that can rot. Without this,
 *  pasting a failing CI log into STATUS.md can fail the check. */
const maskFencedBlocks = (text: string): string => {
  let fenceChar: string | null = null
  return text
    .split('\n')
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)
      const blank = ' '.repeat(line.length)
      if (fenceChar === null) {
        if (!marker) return line
        fenceChar = marker[1][0]
        return blank
      }
      if (marker && marker[1][0] === fenceChar) fenceChar = null
      return blank
    })
    .join('\n')
}

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split('\n').length

// ── A. relative links resolve ────────────────────────────────────────────────
const checkTarget = (
  file: string,
  text: string,
  target: string,
  index: number,
): void => {
  if (/^(https?:|mailto:|#)/.test(target)) return
  counts.links++
  const path = decodeURIComponent(target.split('#')[0])
  if (!path) return
  const abs = resolve(repoRoot, join(dirname(file), path))
  if (!existsSync(abs)) {
    fail(file, lineOf(text, index), `broken link → ${target}`)
  }
}

const checkLinks = (file: string, text: string): void => {
  // Inline: [label](target "title") — also covers ![image](target).
  const inline = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
  for (const match of text.matchAll(inline)) {
    checkTarget(file, text, match[1], match.index)
  }
  // Reference-style definitions: [label]: target "title" — same rot, and
  // invisible to the inline pattern because the target never appears in `()`.
  const definition = /^ {0,3}\[[^\]]+\]:\s*<?([^>\s]+)>?/gm
  for (const match of text.matchAll(definition)) {
    checkTarget(file, text, match[1], match.index)
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
    .map((m) => ({ path: normalisePath(m[1]), index: m.index }))

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
  // Anything that isn't a readable file is not this assertion's problem: a
  // missing path is already reported by B, and a directory is skipped by the
  // caller. Guarding on `isFile` rather than `existsSync` is what keeps a
  // directory citation from crashing the run with EISDIR instead of failing
  // cleanly — the same way the moved-file case used to.
  const abs = resolve(repoRoot, path)
  if (!isFile(abs)) return true
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
    // Prose puts plenty of non-identifiers next to a path — a CI run id, an
    // issue number, a duration. Only an identifier-shaped token is a claim
    // about the code, and only those are worth resolving.
    if (!/^[A-Za-z_$]/.test(symbol.trim())) continue
    const key = normalisePath(path)
    bound.set(key, [...(bound.get(key) ?? []), symbol])
  }

  // One entry per cited path, at its first citation — a path cited three times
  // is one claim, and reporting it three times says nothing extra.
  const cited = new Map<string, number>()
  for (const { path, index } of citedPaths(text)) {
    if (!/^(src|tests)\//.test(path)) continue
    // Only files carry symbols. A directory citation ("the tools live in
    // `src/tools`") is a legitimate thing to write and has nothing to bind to;
    // assertion B still holds it to existing.
    if (!isFile(resolve(repoRoot, path))) continue
    if (!cited.has(path)) cited.set(path, lineOf(text, index))
  }

  for (const [path, line] of cited) {
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
    for (const symbol of new Set(symbols)) {
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

// ── E. refcheck markers are balanced ─────────────────────────────────────────
/** An unclosed `refcheck:off` masks nothing — the region reads as disabled to
 *  whoever wrote it while the check still runs over it. That direction is safe
 *  today but the author's intent is silently broken, so say so. Runs on the raw
 *  text: masking blanks the markers it matched. */
const checkMarkers = (file: string, raw: string): void => {
  const marker = /<!--\s*refcheck:(off|on)\s*-->/g
  let openedAt: number | null = null
  for (const match of raw.matchAll(marker)) {
    const line = lineOf(raw, match.index)
    if (match[1] === 'off') {
      if (openedAt !== null) {
        fail(file, line, `refcheck:off inside a region already opened at line ${openedAt}`)
      }
      openedAt = line
    } else {
      if (openedAt === null) {
        fail(file, line, 'refcheck:on without a matching refcheck:off')
      }
      openedAt = null
    }
  }
  if (openedAt !== null) {
    fail(file, openedAt, 'refcheck:off is never closed — this region is NOT masked')
  }
}

// ── run ──────────────────────────────────────────────────────────────────────
for (const file of trackedMarkdown) {
  const raw = readFileSync(resolve(repoRoot, file), 'utf8')
  const text = maskFencedBlocks(maskDisabledRegions(raw))
  counts.files++
  checkMarkers(file, raw)
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
