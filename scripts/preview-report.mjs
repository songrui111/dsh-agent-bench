/**
 * Preview the human-readable rendering of an EXISTING scorecard.
 * No agent runs, no tokens — it just re-renders stored data.
 *
 * Run:  node scripts/preview-report.mjs [runId] [suiteId]
 */
import { readFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderRunSummary } from '../lib/report.js'
import { renderRunMarkdown } from '../lib/scorecard.js'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = process.env.BENCH_WORKSPACE ?? resolve(PLUGIN_DIR, '..')
const ROOT = join(WORKSPACE, '.agent-bench')

const index = JSON.parse(await readFile(join(ROOT, 'index.json'), 'utf8'))
const target = index[index.length - 1]
const runId = process.argv[2] ?? target.runId
const suiteId = process.argv[3] ?? target.suiteId

const card = JSON.parse(await readFile(join(ROOT, 'runs', runId, `${suiteId}.json`), 'utf8'))

console.log('=========== bench_run output (what the user sees) ===========\n')
console.log(
  renderRunSummary({
    suiteId: card.suiteId,
    runId: card.runId,
    cases: card.cases,
    passed: card.summary.passed,
    total: card.summary.total,
    passRate: card.summary.passRate,
    durationMs: card.cases.reduce((n, c) => n + (c.durationMs ?? 0), 0),
    scorecardPath: join(ROOT, 'runs', runId, `${suiteId}.json`),
    reportPath: join(ROOT, 'runs', runId, `${suiteId}.md`),
  }),
)

console.log('\n=========== readable report (.md, first 30 lines) ===========\n')
console.log(renderRunMarkdown(card).split('\n').slice(0, 30).join('\n'))
