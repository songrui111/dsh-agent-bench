/**
 * Negative control: prove the benchmark actually FAILS when work is bad.
 *
 * A benchmark that always passes is worthless, so this script builds a
 * throwaway suite whose fixture already violates its own assertion and
 * confirms the case is scored as failed.
 *
 * Run:  node scripts/negative-control.mjs
 */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadSuite } from '../lib/cases.js'
import { runCase } from '../lib/runner.js'

const root = await mkdtemp(join(tmpdir(), 'bench-negctl-'))
try {
  const suiteDir = join(root, 'negctl')
  const caseDir = join(suiteDir, 'already-broken')
  await mkdir(join(caseDir, 'fixture'), { recursive: true })
  await writeFile(join(suiteDir, 'suite.json'), JSON.stringify({ id: 'negctl', title: 'Negative control' }))
  await writeFile(
    join(caseDir, 'case.json'),
    JSON.stringify({
      id: 'already-broken',
      task: 'Do nothing at all.',
      assertions: [{ kind: 'file-exists', path: 'this-file-does-not-exist.txt' }],
    }),
  )
  await writeFile(join(caseDir, 'fixture', 'seed.txt'), 'unchanged\n')

  const suite = await loadSuite(suiteDir)

  // A driver that deliberately does nothing: the assertion MUST fail.
  const doNothing = { async run() { return { ok: true, exitCode: 0 } } }
  const lazy = await runCase({
    caseDef: suite.cases[0],
    sandboxRoot: join(root, 'sb'),
    runId: 'lazy',
    agentDriver: doNothing,
    caseTimeoutMs: 5000,
    maxArtifactBytes: 4096,
    keepSandbox: false,
  })
  console.log(`lazy agent    -> passed=${lazy.passed}  (expected false)  ${lazy.assertions[0]?.detail}`)

  // A driver that does the expected thing: the same assertion MUST pass.
  const worker = {
    async run({ sandboxDir }) {
      await writeFile(join(sandboxDir, 'this-file-does-not-exist.txt'), 'now it exists\n')
      return { ok: true, exitCode: 0 }
    },
  }
  const good = await runCase({
    caseDef: suite.cases[0],
    sandboxRoot: join(root, 'sb'),
    runId: 'good',
    agentDriver: worker,
    caseTimeoutMs: 5000,
    maxArtifactBytes: 4096,
    keepSandbox: false,
  })
  console.log(`working agent -> passed=${good.passed}  (expected true)   ${good.assertions[0]?.detail}`)

  const ok = lazy.passed === false && good.passed === true
  console.log(ok ? '\nNEGATIVE CONTROL OK: the benchmark discriminates.' : '\nNEGATIVE CONTROL FAILED: the benchmark cannot tell good from bad.')
  if (!ok) process.exitCode = 1
} finally {
  await rm(root, { recursive: true, force: true })
}
