/**
 * Vacuity check: every case must FAIL when the agent does nothing.
 *
 * A case whose assertions pass against an untouched sandbox measures nothing —
 * it would report "stable" forever and hide real regressions. This runs each
 * case with a do-nothing driver (no model calls, so it is instant and free)
 * and requires a failing verdict.
 *
 * Run:  node scripts/vacuity-check.mjs
 */
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { discoverSuites } from '../lib/cases.js'
import { runCase } from '../lib/runner.js'

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE = process.env.BENCH_WORKSPACE ?? resolve(PLUGIN_DIR, '..')

const suites = await discoverSuites(join(WORKSPACE, 'benchmarks'))
const doNothing = { async run() { return { ok: true, exitCode: 0 } } }

let vacuous = 0
let checked = 0

for (const suite of suites) {
  console.log(`\n${suite.id}`)
  for (const caseDef of suite.cases) {
    checked += 1
    const r = await runCase({
      caseDef,
      sandboxRoot: join(WORKSPACE, '.agent-bench', 'sandboxes'),
      runId: 'vacuity',
      agentDriver: doNothing,
      caseTimeoutMs: 5000,
      maxArtifactBytes: 4096,
      keepSandbox: false,
    })
    if (r.passed) {
      vacuous += 1
      console.log(`  VACUOUS  ${caseDef.id} — passes without any work being done`)
    } else {
      const failed = r.assertions.filter((a) => !a.passed).map((a) => `${a.kind}${a.path ? `(${a.path})` : ''}`)
      console.log(`  ok       ${caseDef.id} — fails as expected on: ${failed.slice(0, 3).join(', ')}`)
    }
  }
}

console.log(`\n${checked - vacuous}/${checked} cases reject a do-nothing agent`)
if (vacuous > 0) {
  console.log('FAIL: some cases cannot detect an agent that did nothing')
  process.exitCode = 1
} else {
  console.log('VACUITY CHECK OK')
}
