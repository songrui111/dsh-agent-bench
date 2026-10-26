// Run one suite against a real agent in a throwaway DSH home.
//
//   node scripts/run-suite.mjs [suiteId]
//
// The CLI is taken from DSH_BENCH_CLI, or from `dsh` on PATH. The isolated
// home is seeded from your real one (credentials are copied, never written
// back), so this behaves the same as the plugin does inside DSH.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverSuites } from '../lib/cases.js'
import { runSuite } from '../lib/runner.js'
import { buildScorecard } from '../lib/scorecard.js'
import { resolveCli, prepareBenchHome, runCli } from '../lib/host.js'
import { renderRunSummary } from '../lib/report.js'

const pluginDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = process.env.BENCH_WORKSPACE ?? resolve(pluginDir, '..')

const cli = resolveCli({ explicit: process.env.DSH_BENCH_CLI ?? '' })
if (!cli) {
  console.error('No dsh CLI found. Set DSH_BENCH_CLI, or put `dsh` on PATH.')
  process.exit(1)
}

const home = await mkdtemp(join(tmpdir(), 'bench-home-'))
const prepared = await prepareBenchHome({
  home,
  realHome: process.env.DSH_HOME || join(homedir(), '.dsh'),
  cli,
  runCli: (c, args, cwd) => runCli(c, args, cwd, { home }),
})

console.log(`cli: ${cli.path ?? cli.command}`)
console.log(`home: ${home}`)
console.log(`auth: ${prepared.mode}`)
for (const note of prepared.notes) console.log(`  - ${note}`)
console.log('')

const suites = await discoverSuites(join(workspace, 'benchmarks'))
const suiteId = process.argv[2] ?? suites[0]?.id
const suite = suites.find((s) => s.id === suiteId)
if (!suite) {
  console.error(`unknown suite "${suiteId}"; available: ${suites.map((s) => s.id).join(', ')}`)
  process.exit(1)
}

try {
  const runId = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const cases = await runSuite({
    suite,
    sandboxRoot: join(workspace, '.agent-bench', 'sandboxes'),
    runId,
    agentDriver: {
      async run({ task, sandboxDir, timeoutMs }) {
        const r = runCli(cli, [...prepared.cliArgs, task], sandboxDir, { home, timeout: timeoutMs })
        return {
          ok: r.status === 0,
          exitCode: r.status,
          output: (r.stdout ?? '').trim(),
          error: r.status === 0 ? null : (r.stderr ?? '').trim().slice(0, 600),
        }
      },
    },
    caseTimeoutMs: 240_000,
    maxArtifactBytes: 262_144,
    keepSandbox: false,
  })

  const card = buildScorecard({
    runId,
    suite,
    cases,
    environment: { mode: 'scripts/run-suite' },
    startedAt: cases[0]?.startedAt ?? new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  })
  console.log(renderRunSummary({
    suiteId: suite.id,
    runId,
    cases,
    passed: card.summary.passed,
    total: card.summary.total,
    passRate: card.summary.passRate,
    durationMs: cases.reduce((n, c) => n + (c.durationMs ?? 0), 0),
  }))
  if (card.summary.passed !== card.summary.total) process.exitCode = 1
} finally {
  await rm(home, { recursive: true, force: true })
}
