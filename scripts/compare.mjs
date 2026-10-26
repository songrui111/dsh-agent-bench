/**
 * Compare the two most recent stored runs of a suite and print the report.
 * Proves the regression path on real scorecards rather than fixtures.
 *
 * Run:  node scripts/compare.mjs [suiteId]
 */
import { readIndex, readScorecard, compareScorecards, renderComparison } from '../lib/scorecard.js'

const ROOT = '.agent-bench'
const suiteId = process.argv[2] ?? 'core'

const index = await readIndex(ROOT)
const rows = index.filter((r) => r.suiteId === suiteId)
if (rows.length < 2) {
  console.error(`need at least 2 runs of ${suiteId}; found ${rows.length}`)
  process.exit(1)
}
const [base, cand] = [rows[rows.length - 2], rows[rows.length - 1]]
const baseline = await readScorecard(ROOT, base.runId, suiteId)
const candidate = await readScorecard(ROOT, cand.runId, suiteId)

console.log(`baseline : ${baseline.runId}  ${baseline.summary.passed}/${baseline.summary.total}`)
console.log(`candidate: ${candidate.runId}  ${candidate.summary.passed}/${candidate.summary.total}`)
console.log()
console.log(renderComparison(compareScorecards(baseline, candidate)))
