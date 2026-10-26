import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadSuites, copyBundledSuites } from '../lib/suites.js'

async function tmp() {
  return mkdtemp(join(tmpdir(), 'dsh-bench-suites-'))
}

/** Create a minimal valid suite directory. */
async function makeSuite(root, id, caseId = 'c1') {
  const suiteDir = join(root, id)
  await mkdir(join(suiteDir, caseId), { recursive: true })
  await writeFile(join(suiteDir, 'suite.json'), JSON.stringify({ id, title: id }))
  await writeFile(join(suiteDir, caseId, 'case.json'), JSON.stringify({ id: caseId, task: 'do it' }))
  return suiteDir
}

test('loadSuites prefers the workspace over the bundled starter suite', async () => {
  const root = await tmp()
  try {
    const workspace = join(root, 'ws')
    const bundled = join(root, 'pkg')
    await makeSuite(workspace, 'mine')
    await makeSuite(bundled, 'starter')

    const out = await loadSuites({ workspaceRoot: workspace, bundledRoot: bundled })
    assert.equal(out.source, 'workspace')
    assert.deepEqual(out.suites.map((s) => s.id), ['mine'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('loadSuites falls back to the bundled suite on a fresh install', async () => {
  const root = await tmp()
  try {
    const workspace = join(root, 'ws-empty')
    const bundled = join(root, 'pkg')
    await makeSuite(bundled, 'starter')

    const out = await loadSuites({ workspaceRoot: workspace, bundledRoot: bundled })
    assert.equal(out.source, 'bundled')
    assert.deepEqual(out.suites.map((s) => s.id), ['starter'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('loadSuites returns none when neither source has suites', async () => {
  const root = await tmp()
  try {
    const out = await loadSuites({ workspaceRoot: join(root, 'ws'), bundledRoot: join(root, 'pkg') })
    assert.equal(out.source, 'none')
    assert.deepEqual(out.suites, [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('copyBundledSuites copies once and never overwrites', async () => {
  const root = await tmp()
  try {
    const workspace = join(root, 'ws')
    const bundled = join(root, 'pkg')
    await makeSuite(bundled, 'starter')

    const first = await copyBundledSuites({ bundledRoot: bundled, workspaceRoot: workspace })
    assert.deepEqual(first.copied, ['starter'])
    assert.deepEqual(first.skipped, [])
    assert.ok(existsSync(join(workspace, 'starter', 'suite.json')))

    const second = await copyBundledSuites({ bundledRoot: bundled, workspaceRoot: workspace })
    assert.deepEqual(second.copied, [])
    assert.deepEqual(second.skipped, ['starter'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('copyBundledSuites tolerates a missing bundle', async () => {
  const root = await tmp()
  try {
    const out = await copyBundledSuites({ bundledRoot: join(root, 'nope'), workspaceRoot: join(root, 'ws') })
    assert.deepEqual(out, { copied: [], skipped: [] })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
