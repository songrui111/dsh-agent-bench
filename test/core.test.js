import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadSuite, normalizeCase, CaseValidationError } from '../lib/cases.js'
import { resolveInside, evalAssertion, evalAssertions } from '../lib/assertions.js'
import { createSandbox, destroySandbox, listSandboxFiles } from '../lib/sandbox.js'
import { buildScorecard, compareScorecards, renderComparison } from '../lib/scorecard.js'
import { runCase, buildPrompt } from '../lib/runner.js'

async function tmp() {
  return mkdtemp(join(tmpdir(), 'dsh-agent-bench-'))
}

// ---------------------------------------------------------------- cases

test('normalizeCase rejects a missing task', () => {
  assert.throws(() => normalizeCase({ id: 'a' }, '/x'), CaseValidationError)
})

test('normalizeCase rejects a path-escaping id', () => {
  assert.throws(() => normalizeCase({ id: '../evil', task: 't' }, '/x'), CaseValidationError)
})

test('normalizeCase rejects an unknown assertion kind', () => {
  assert.throws(
    () => normalizeCase({ id: 'a', task: 't', assertions: [{ kind: 'teleport' }] }, '/x'),
    /unknown assertion kind/,
  )
})

test('normalizeCase fills defaults', () => {
  const c = normalizeCase({ id: 'ok', task: 'do it' }, '/x')
  assert.equal(c.id, 'ok')
  assert.equal(c.title, 'ok')
  assert.deepEqual(c.assertions, [])
  assert.equal(c.llmReview, null)
})

test('normalizeCase normalizes llmReview minScore default', () => {
  const c = normalizeCase({ id: 'ok', task: 't', llmReview: { criteria: 'must be good' } }, '/x')
  assert.equal(c.llmReview.minScore, 0.7)
})

test('loadSuite loads cases and sorts them', async () => {
  const root = await tmp()
  try {
    const suite = join(root, 'demo')
    await mkdir(join(suite, 'b-case'), { recursive: true })
    await mkdir(join(suite, 'a-case'), { recursive: true })
    await writeFile(join(suite, 'suite.json'), JSON.stringify({ id: 'demo', title: 'Demo' }))
    await writeFile(join(suite, 'b-case', 'case.json'), JSON.stringify({ id: 'b', task: 'tb' }))
    await writeFile(join(suite, 'a-case', 'case.json'), JSON.stringify({ id: 'a', task: 'ta' }))
    const loaded = await loadSuite(suite)
    assert.equal(loaded.id, 'demo')
    assert.deepEqual(loaded.cases.map((c) => c.id), ['a', 'b']) // directory order (a-case before b-case)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('loadSuite rejects duplicate case ids', async () => {
  const root = await tmp()
  try {
    const suite = join(root, 'demo')
    await mkdir(join(suite, 'x'), { recursive: true })
    await mkdir(join(suite, 'y'), { recursive: true })
    await writeFile(join(suite, 'suite.json'), JSON.stringify({ id: 'demo' }))
    await writeFile(join(suite, 'x', 'case.json'), JSON.stringify({ id: 'dup', task: 't' }))
    await writeFile(join(suite, 'y', 'case.json'), JSON.stringify({ id: 'dup', task: 't' }))
    await assert.rejects(() => loadSuite(suite), /duplicate case id/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- assertions

test('resolveInside refuses to escape the sandbox', () => {
  assert.throws(() => resolveInside('/sandbox', '../etc/passwd'), /escapes the sandbox/)
  assert.throws(() => resolveInside('/sandbox', 'C:/windows/system32'), /absolute/)
  assert.match(resolveInside('/sandbox', 'a/b.txt'), /a[\\/]b\.txt$/)
})

test('file-exists passes and fails correctly', async () => {
  const dir = await tmp()
  try {
    await writeFile(join(dir, 'here.txt'), 'x')
    const ctx = { sandboxDir: dir, maxArtifactBytes: 1024 }
    assert.equal((await evalAssertion({ kind: 'file-exists', path: 'here.txt' }, ctx)).passed, true)
    assert.equal((await evalAssertion({ kind: 'file-exists', path: 'gone.txt' }, ctx)).passed, false)
    assert.equal((await evalAssertion({ kind: 'file-absent', path: 'gone.txt' }, ctx)).passed, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file-contains and file-not-contains', async () => {
  const dir = await tmp()
  try {
    await writeFile(join(dir, 'a.txt'), 'hello world')
    const ctx = { sandboxDir: dir, maxArtifactBytes: 1024 }
    assert.equal((await evalAssertion({ kind: 'file-contains', path: 'a.txt', value: 'world' }, ctx)).passed, true)
    assert.equal((await evalAssertion({ kind: 'file-contains', path: 'a.txt', value: 'nope' }, ctx)).passed, false)
    assert.equal((await evalAssertion({ kind: 'file-not-contains', path: 'a.txt', value: 'nope' }, ctx)).passed, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('file-matches uses a real RegExp', async () => {
  const dir = await tmp()
  try {
    await writeFile(join(dir, 'a.txt'), 'version = "1.2.3"')
    const ctx = { sandboxDir: dir, maxArtifactBytes: 1024 }
    assert.equal((await evalAssertion({ kind: 'file-matches', path: 'a.txt', value: '1\\.2\\.\\d' }, ctx)).passed, true)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('missing file fails a contains assertion instead of throwing', async () => {
  const dir = await tmp()
  try {
    const r = await evalAssertion({ kind: 'file-contains', path: 'nope.txt', value: 'x' }, { sandboxDir: dir, maxArtifactBytes: 10 })
    assert.equal(r.passed, false)
    assert.match(r.detail, /missing/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('command assertion honours expectExitCode', async () => {
  const dir = await tmp()
  try {
    const ctx = { sandboxDir: dir, maxArtifactBytes: 1024, commandTimeoutMs: 20000 }
    const ok = await evalAssertion({ kind: 'command', run: 'node -e "process.exit(0)"' }, ctx)
    assert.equal(ok.passed, true, ok.detail)
    const bad = await evalAssertion({ kind: 'command', run: 'node -e "process.exit(3)"', expectExitCode: 3 }, ctx)
    assert.equal(bad.passed, true, bad.detail)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('evalAssertions reports the aggregate verdict', async () => {
  const dir = await tmp()
  try {
    await writeFile(join(dir, 'a.txt'), 'ok')
    const def = {
      assertions: [
        { kind: 'file-exists', path: 'a.txt' },
        { kind: 'file-exists', path: 'b.txt' },
      ],
    }
    const v = await evalAssertions(def, { sandboxDir: dir, maxArtifactBytes: 1024 })
    assert.equal(v.passed, false)
    assert.equal(v.passedCount, 1)
    assert.equal(v.total, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- sandbox

test('createSandbox copies the fixture and is idempotent', async () => {
  const root = await tmp()
  try {
    const fixture = join(root, 'fx')
    await mkdir(fixture, { recursive: true })
    await writeFile(join(fixture, 'seed.txt'), 'seed')
    const caseDef = { id: 'c1', fixtureDir: fixture }
    const sb = await createSandbox({ caseDef, sandboxRoot: join(root, 'sb'), runId: 'r1' })
    assert.equal(await readFile(join(sb, 'seed.txt'), 'utf8'), 'seed')
    // second create must not fail on an existing dir
    const sb2 = await createSandbox({ caseDef, sandboxRoot: join(root, 'sb'), runId: 'r1' })
    assert.equal(sb, sb2)
    await destroySandbox(sb2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('listSandboxFiles walks nested dirs', async () => {
  const dir = await tmp()
  try {
    await mkdir(join(dir, 'sub'), { recursive: true })
    await writeFile(join(dir, 'sub', 'x.txt'), 'abc')
    const files = await listSandboxFiles(dir)
    assert.deepEqual(files.map((f) => f.path), ['sub/x.txt'])
    assert.equal(files[0].bytes, 3)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- scorecard

function card(runId, cases) {
  const passed = cases.filter((c) => c.passed).length
  return buildScorecard({
    runId,
    suite: { id: 's', title: 'S' },
    cases,
    environment: {},
    startedAt: 't0',
    finishedAt: 't1',
  })
}

test('compareScorecards detects a regression', () => {
  const base = card('r1', [
    { id: 'a', title: 'A', passed: true, assertions: [] },
    { id: 'b', title: 'B', passed: true, assertions: [] },
  ])
  const cand = card('r2', [
    { id: 'a', title: 'A', passed: true, assertions: [] },
    { id: 'b', title: 'B', passed: false, assertions: [{ kind: 'file-exists', path: 'x', passed: false, detail: 'missing' }] },
  ])
  const cmp = compareScorecards(base, cand)
  assert.equal(cmp.verdict, 'regressed')
  assert.equal(cmp.regressions.length, 1)
  assert.equal(cmp.regressions[0].id, 'b')
  assert.match(cmp.regressions[0].detail, /missing/)
  assert.ok(cmp.delta < 0)
})

test('compareScorecards detects an improvement', () => {
  const base = card('r1', [{ id: 'a', title: 'A', passed: false, assertions: [] }])
  const cand = card('r2', [{ id: 'a', title: 'A', passed: true, assertions: [] }])
  const cmp = compareScorecards(base, cand)
  assert.equal(cmp.verdict, 'improved')
  assert.equal(cmp.fixed.length, 1)
})

test('LLM drift never changes the verdict', () => {
  const base = card('r1', [{ id: 'a', title: 'A', passed: true, assertions: [], llm: { approved: true, score: 0.9 } }])
  const cand = card('r2', [{ id: 'a', title: 'A', passed: true, assertions: [], llm: { approved: false, score: 0.4 } }])
  const cmp = compareScorecards(base, cand)
  assert.equal(cmp.verdict, 'stable')
  assert.equal(cmp.regressions.length, 0)
  assert.equal(cmp.unchanged[0].note.includes('LLM review went'), true)
})

test('renderComparison mentions regressed cases', () => {
  const base = card('r1', [{ id: 'a', title: 'A', passed: true, assertions: [] }])
  const cand = card('r2', [{ id: 'a', title: 'A', passed: false, assertions: [] }])
  const md = renderComparison(compareScorecards(base, cand))
  assert.match(md, /回归/)
  assert.match(md, /\*\*a\*\*/)
})

// ---------------------------------------------------------------- runner

test('buildPrompt names the sandbox', () => {
  const p = buildPrompt({ task: 'do the thing' }, 'C:/sb')
  assert.match(p, /C:\/sb/)
  assert.match(p, /do the thing/)
})

test('runCase passes when the driver produces the expected artifact', async () => {
  const root = await tmp()
  try {
    const caseDef = {
      id: 'ok',
      title: 'OK',
      task: 'write out.txt',
      assertions: [{ kind: 'file-contains', path: 'out.txt', value: 'done' }],
      llmReview: null,
      fixtureDir: null,
      expectDir: null,
    }
    const driver = {
      async run({ sandboxDir }) {
        await writeFile(join(sandboxDir, 'out.txt'), 'done')
        return { ok: true, exitCode: 0 }
      },
    }
    const r = await runCase({
      caseDef,
      sandboxRoot: join(root, 'sb'),
      runId: 'r1',
      agentDriver: driver,
      caseTimeoutMs: 10000,
      maxArtifactBytes: 1024,
      keepSandbox: false,
    })
    assert.equal(r.passed, true)
    assert.equal(r.passedCount, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runCase fails when the agent errors even if assertions pass', async () => {
  const root = await tmp()
  try {
    const caseDef = {
      id: 'half',
      title: 'H',
      task: 'x',
      assertions: [{ kind: 'file-exists', path: 'a.txt' }],
      llmReview: null,
      fixtureDir: null,
      expectDir: null,
    }
    const driver = {
      async run({ sandboxDir }) {
        await writeFile(join(sandboxDir, 'a.txt'), 'x')
        return { ok: false, error: 'model refused', exitCode: 1 }
      },
    }
    const r = await runCase({
      caseDef,
      sandboxRoot: join(root, 'sb'),
      runId: 'r1',
      agentDriver: driver,
      caseTimeoutMs: 10000,
      maxArtifactBytes: 1024,
      keepSandbox: false,
    })
    assert.equal(r.passed, false, 'an agent-side failure must not be scored as a pass')
    assert.equal(r.assertions[0].passed, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('runCase records LLM review separately and applies minScore', async () => {
  const root = await tmp()
  try {
    const caseDef = {
      id: 'rev',
      title: 'R',
      task: 'x',
      assertions: [],
      llmReview: { criteria: 'quality', minScore: 0.8 },
      fixtureDir: null,
      expectDir: null,
    }
    const r = await runCase({
      caseDef,
      sandboxRoot: join(root, 'sb'),
      runId: 'r1',
      agentDriver: { async run() { return { ok: true } } },
      reviewer: async () => ({ score: 0.5, reason: 'mediocre', model: 'deepseek' }),
      caseTimeoutMs: 10000,
      maxArtifactBytes: 1024,
      keepSandbox: false,
    })
    assert.equal(r.llm.approved, false)
    assert.equal(r.llm.score, 0.5)
    assert.equal(r.llm.reviewerModel, 'deepseek')
    // deterministic verdict is unaffected by the review
    assert.equal(r.passed, true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a throwing driver is captured as a failed case, not a crash', async () => {
  const root = await tmp()
  try {
    const caseDef = {
      id: 'boom',
      title: 'B',
      task: 'x',
      assertions: [],
      llmReview: null,
      fixtureDir: null,
      expectDir: null,
    }
    const r = await runCase({
      caseDef,
      sandboxRoot: join(root, 'sb'),
      runId: 'r1',
      agentDriver: { async run() { throw new Error('spawn failed') } },
      caseTimeoutMs: 10000,
      maxArtifactBytes: 1024,
      keepSandbox: false,
    })
    assert.equal(r.passed, false)
    assert.match(r.error, /spawn failed/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
