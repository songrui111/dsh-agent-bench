// Which suites to use: the workspace's own, or the bundled starter suite when
// the workspace has none. Also copies the bundled one on request.

import { readdir, cp } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { discoverSuites } from './cases.js'

/**
 * Load suites from the workspace, falling back to the bundled starter suite.
 * @returns {{suites: object[], source: 'workspace'|'bundled'|'none'}}
 */
export async function loadSuites({ workspaceRoot, bundledRoot }) {
  const fromWorkspace = await discoverSuites(workspaceRoot)
  if (fromWorkspace.length > 0) return { suites: fromWorkspace, source: 'workspace' }

  if (bundledRoot && existsSync(bundledRoot)) {
    const fromBundle = await discoverSuites(bundledRoot)
    if (fromBundle.length > 0) return { suites: fromBundle, source: 'bundled' }
  }
  return { suites: [], source: 'none' }
}

/**
 * Copy bundled suites into the workspace so the user can edit them.
 * Existing suites are never overwritten.
 * @returns {{copied: string[], skipped: string[]}}
 */
export async function copyBundledSuites({ bundledRoot, workspaceRoot }) {
  const copied = []
  const skipped = []
  if (!bundledRoot || !existsSync(bundledRoot)) return { copied, skipped }

  const entries = await readdir(bundledRoot, { withFileTypes: true })
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (!existsSync(join(bundledRoot, e.name, 'suite.json'))) continue
    const target = join(workspaceRoot, e.name)
    if (existsSync(target)) {
      skipped.push(e.name)
      continue
    }
    await cp(join(bundledRoot, e.name), target, { recursive: true })
    copied.push(e.name)
  }
  return { copied, skipped }
}
