import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Config, apply, makeHeadlessDriver, makeLlmReviewer, name } from '../lib/index.js'

async function tmp() {
  return mkdtemp(join(tmpdir(), 'dsh-bench-plugin-'))
}

/** A ctx whose llm.stream yields the given text chunks and records the options. */
function reviewCtx({ text = '{"score":1,"reason":"ok"}', calls = [], finishKind = 'ok' } = {}) {
  return {
    get: (svc) => {
      if (svc === 'llm') {
        return {
          async *stream(options) {
            calls.push(options)
            if (text !== '') yield { type: 'text-delta', text }
            yield { type: 'finish', reason: { kind: finishKind } }
          },
        }
      }
      if (svc === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'p', model: 'm' }) }
      return undefined
    },
  }
}

test('plugin exports the cordis contract', () => {
  assert.equal(name, 'dsh-agent-bench')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
})

test('Config fills every default so a bare install works', () => {
  const cfg = Config({})
  assert.equal(cfg.suitesRoot, 'benchmarks')
  assert.equal(cfg.scorecardRoot, '.agent-bench')
  assert.equal(cfg.caseTimeoutMs, 300000)
  assert.equal(cfg.maxArtifactBytes, 262144)
  assert.equal(cfg.llmReviewEnabled, true)
  assert.equal(cfg.keepSandboxes, false)
  // Discovery fields stay empty on purpose: resolveCli/probe decide at runtime.
  assert.equal(cfg.cliPath, '')
  assert.equal(cfg.dshHome, '')
  assert.deepEqual(cfg.cliArgs, ['--profile', 'headless'])
  assert.equal(cfg.llmProvider, '')
  assert.equal(cfg.llmModel, '')
})

test('Config rejects a non-object', () => {
  assert.throws(() => Config('nope'))
})

test('makeHeadlessDriver refuses to run without a CLI instead of faking a pass', async () => {
  const driver = makeHeadlessDriver({ cli: null, cliArgs: [], home: '/tmp/x' })
  const r = await driver.run({ task: 't', sandboxDir: '/tmp', timeoutMs: 1000 })
  assert.equal(r.ok, false)
  assert.match(r.error, /no dsh CLI resolved/)
})

test('makeLlmReviewer surfaces a missing llm service as an error', async () => {
  const reviewer = makeLlmReviewer({ get: () => undefined }, {})
  await assert.rejects(
    () => reviewer({ caseDef: { task: 't', llmReview: { criteria: 'c' } }, sandboxDir: '/tmp', artifacts: [] }),
    /ctx\.llm is not mounted/,
  )
})

test('reviewer sees files the agent changed even when no assertion names them', async () => {
  const root = await tmp()
  try {
    const fixtureDir = join(root, 'fixture')
    const sandboxDir = join(root, 'sandbox')
    await mkdir(fixtureDir, { recursive: true })
    await mkdir(sandboxDir, { recursive: true })
    // calc.js is the file the agent fixed; test.js is asserted but untouched.
    await writeFile(join(fixtureDir, 'calc.js'), 'return a - b\n')
    await writeFile(join(sandboxDir, 'calc.js'), 'return a + b\n')
    await writeFile(join(fixtureDir, 'test.js'), 'unchanged\n')
    await writeFile(join(sandboxDir, 'test.js'), 'unchanged\n')

    const calls = []
    const reviewer = makeLlmReviewer(reviewCtx({ calls }), {})
    const res = await reviewer({
      caseDef: {
        task: 'fix it',
        llmReview: { criteria: 'bug fixed' },
        assertions: [{ kind: 'file-equals-expect', path: 'test.js', expect: 'test.js' }],
        fixtureDir,
      },
      sandboxDir,
      artifacts: [
        { path: 'calc.js', bytes: 13 },
        { path: 'test.js', bytes: 10 },
      ],
    })

    const prompt = calls[0].messages[0].content[0].text
    assert.match(prompt, /calc\.js \(changed by the agent\)/, 'the fixed file must be shown')
    assert.match(prompt, /return a \+ b/, 'its content must be shown')
    assert.match(prompt, /test\.js \(unchanged from fixture\)/)
    assert.equal(res.score, 1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('reviewer escalates three attempts when the model emits no text', async () => {
  const calls = []
  const reviewer = makeLlmReviewer(reviewCtx({ text: '', calls }), {})
  await assert.rejects(
    () => reviewer({
      caseDef: { task: 't', llmReview: { criteria: 'c' }, assertions: [] },
      sandboxDir: '/tmp',
      artifacts: [],
    }),
    /produced no text after 3 attempts/,
  )
  assert.equal(calls.length, 3)
  assert.ok(calls[2].maxTokens > calls[1].maxTokens, 'budget must grow across attempts')
})

test('apply registers five tools and the /bench command against a stub ctx', async () => {
  const tools = []
  const commands = []
  const ctx = {
    tools: { register: (t) => { tools.push(t.name); return () => {} } },
    commands: { register: (c) => { commands.push(c.name); return () => {} } },
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    get: () => undefined,
  }
  await apply(ctx, {})
  assert.deepEqual(tools.sort(), ['bench_compare', 'bench_history', 'bench_init', 'bench_run', 'bench_suites'])
  assert.deepEqual(commands, ['bench'])
})

test('apply honours config overrides', async () => {
  const tools = []
  const ctx = {
    tools: { register: (t) => { tools.push(t); return () => {} } },
    commands: { register: () => () => {} },
    effect: (fn) => { const d = fn(); return () => { if (typeof d === 'function') d() } },
    get: () => undefined,
  }
  await apply(ctx, { caseTimeoutMs: 1234, cliPath: 'C:/x/bin.js' })
  assert.deepEqual(
    tools.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((t) => t.name),
    ['bench_compare', 'bench_history', 'bench_init', 'bench_run', 'bench_suites'],
  )
})
