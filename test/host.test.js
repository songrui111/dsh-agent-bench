import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  resolveCli,
  probeCommand,
  pickAuthMode,
  renderOverlay,
  prepareBenchHome,
  runCli,
  buildSpawn,
  DEFAULT_PROFILE,
} from '../lib/host.js'

async function tmp() {
  return mkdtemp(join(tmpdir(), 'dsh-bench-host-'))
}

// ------------------------------------------------------------ resolveCli

test('resolveCli prefers explicit config over env and PATH', () => {
  const cli = resolveCli({
    explicit: 'C:/dsh/lib/bin.js',
    env: { DSH_BENCH_CLI: 'C:/other/bin.js' },
    probe: () => true,
  })
  assert.equal(cli.kind, 'node')
  assert.match(cli.path, /dsh[\\/]lib[\\/]bin\.js$/)
})

test('resolveCli falls back to env when config is empty', () => {
  const cli = resolveCli({ explicit: '   ', env: { DSH_BENCH_CLI: 'C:/env/bin.js' }, probe: () => false })
  assert.equal(cli.kind, 'node')
  assert.match(cli.path, /env[\\/]bin\.js$/)
})

test('resolveCli falls back to a PATH command probe', () => {
  const cli = resolveCli({ explicit: '', env: {}, probe: (n) => n === 'dsh' })
  assert.deepEqual(cli, { kind: 'command', command: 'dsh' })
})

test('resolveCli returns null when nothing is available', () => {
  assert.equal(resolveCli({ explicit: '', env: {}, probe: () => false }), null)
})

test('probeCommand reports false for a name that cannot exist', () => {
  assert.equal(probeCommand('definitely-not-a-real-command-xyzzy-42'), false)
})

// ------------------------------------------------------------ auth mode

test('pickAuthMode detects a DeepSeek account grant', () => {
  const yaml = 'records:\n  deepseek-account-platform/default:\n    kind: grant\n'
  assert.equal(pickAuthMode(yaml), 'account')
})

test('pickAuthMode falls back to passthrough without an account grant', () => {
  assert.equal(pickAuthMode('records:\n  llm-deepseek:\n    kind: secret\n'), 'passthrough')
  assert.equal(pickAuthMode(''), 'passthrough')
  assert.equal(pickAuthMode(undefined), 'passthrough')
})

test('renderOverlay emits an account overlay and nothing for passthrough', () => {
  assert.equal(renderOverlay('passthrough'), null)
  const yaml = renderOverlay('account')
  assert.match(yaml, /id: llm-deepseek\n\s+disabled: true/)
  assert.match(yaml, /provider: deepseek-account/)
  assert.match(yaml, /@deepseek-ai\/dsh-llm-deepseek-account/)
})

// ------------------------------------------------------------ home prep

/**
 * Fake CLI runner.
 *   mode 'shipped'  – the profile composes straight away (probe exits 0)
 *   mode 'missing'  – probe fails, initialise from the headless template
 *   mode 'broken'   – probe fails and initialise fails too
 */
function fakeRunner({ mode = 'shipped' } = {}) {
  const calls = []
  const fn = async (cli, args, cwd) => {
    calls.push({ cli, args: [...args], cwd })
    const isInit = args.includes('--from-default-profile')
    if (isInit && mode !== 'broken') {
      await mkdir(join(cwd, 'profiles', DEFAULT_PROFILE), { recursive: true })
      await writeFile(join(cwd, 'profiles', DEFAULT_PROFILE, 'package.json'), '{}')
      return { status: 0, stdout: '', stderr: '' }
    }
    if (isInit || mode === 'broken') return { status: 1, stdout: '', stderr: 'boom' }
    return { status: mode === 'shipped' ? 0 : 1, stdout: '', stderr: mode === 'shipped' ? '' : 'no such profile' }
  }
  fn.calls = calls
  return fn
}

test('prepareBenchHome copies credentials, writes the overlay, and composes a shipped profile', async () => {
  const root = await tmp()
  try {
    const realHome = join(root, 'real')
    await mkdir(realHome, { recursive: true })
    await writeFile(join(realHome, '.credentials.yaml'), 'records:\n  deepseek-account-platform/default:\n    kind: grant\n')

    const home = join(root, 'bench')
    const run = fakeRunner({ mode: 'shipped' })
    const out = await prepareBenchHome({ home, realHome, cli: { kind: 'command', command: 'dsh' }, runCli: run })

    assert.equal(out.mode, 'account')
    assert.ok(existsSync(join(home, '.credentials.yaml')), 'credentials copied')
    assert.ok(existsSync(join(home, 'bench-overlay.yml')), 'overlay written')
    assert.deepEqual(out.cliArgs.slice(0, 2), ['--profile', DEFAULT_PROFILE])
    assert.equal(out.cliArgs[2], '--patch')
    // A shipped profile must not be re-created as a custom one.
    assert.equal(run.calls.filter((c) => c.args.includes('--from-default-profile')).length, 0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepareBenchHome initialises the profile when the name is not available', async () => {
  const root = await tmp()
  try {
    const run = fakeRunner({ mode: 'missing' })
    const out = await prepareBenchHome({
      home: join(root, 'bench'),
      realHome: join(root, 'real'),
      cli: {},
      runCli: run,
    })
    const inits = run.calls.filter((c) => c.args.includes('--from-default-profile'))
    assert.equal(inits.length, 1, 'exactly one init attempt')
    assert.ok(out.notes.some((n) => n.includes('initialised profile')))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepareBenchHome is idempotent: second call reuses credentials and profile', async () => {
  const root = await tmp()
  try {
    const realHome = join(root, 'real')
    await mkdir(realHome, { recursive: true })
    await writeFile(join(realHome, '.credentials.yaml'), 'x: 1\n')
    const home = join(root, 'bench')
    const run = fakeRunner({ mode: 'shipped' })

    await prepareBenchHome({ home, realHome, cli: { kind: 'command', command: 'dsh' }, runCli: run })
    // Credentials changed upstream must NOT be re-copied over the isolated home.
    await writeFile(join(realHome, '.credentials.yaml'), 'changed: true\n')
    const second = await prepareBenchHome({ home, realHome, cli: { kind: 'command', command: 'dsh' }, runCli: run })

    assert.equal(
      run.calls.filter((c) => c.args.includes('--from-default-profile')).length,
      0,
      'no profile init on either call',
    )
    assert.equal(second.mode, 'passthrough')
    assert.equal(second.overlayPath, null, 'passthrough writes no overlay')
    assert.match(await readFile(join(home, '.credentials.yaml'), 'utf8'), /^x: 1/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepareBenchHome throws a useful error when the profile cannot be composed', async () => {
  const root = await tmp()
  try {
    const run = fakeRunner({ mode: 'broken' })
    await assert.rejects(
      () => prepareBenchHome({ home: join(root, 'bench'), realHome: join(root, 'real'), cli: {}, runCli: run }),
      /is not usable/,
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('prepareBenchHome notes the missing-credentials case instead of failing', async () => {
  const root = await tmp()
  try {
    const run = fakeRunner()
    const out = await prepareBenchHome({
      home: join(root, 'bench'),
      realHome: join(root, 'nope'),
      cli: {},
      runCli: run,
    })
    assert.ok(out.notes.some((n) => n.includes('no credentials')))
    assert.equal(out.mode, 'passthrough')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------ spawn plan

test('buildSpawn runs a JS entry under node', () => {
  const plan = buildSpawn({ kind: 'node', path: 'C:/dsh/lib/bin.js' }, ['--profile', 'headless'], 'do it')
  assert.equal(plan.shell, false)
  assert.deepEqual(plan.args, ['C:/dsh/lib/bin.js', '--profile', 'headless', 'do it'])
})

test('buildSpawn uses the command directly for a PATH binary', () => {
  const plan = buildSpawn({ kind: 'command', command: 'dsh' }, ['--profile', 'headless'], 'do it')
  assert.equal(plan.command, 'dsh')
  assert.equal(plan.shell, process.platform === 'win32')
})

test('runCli reports a clear result when the CLI is null', () => {
  const r = runCli(null, [], process.cwd())
  assert.equal(r.status, 1)
  assert.match(r.stderr, /not resolved/)
})
