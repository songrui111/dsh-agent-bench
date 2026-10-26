// Per-case sandbox: copy fixture/ into a fresh directory, let the agent work
// there, delete it afterwards unless keepSandboxes is set. Same fixture bytes
// mean the same starting state, which is what makes runs comparable.

import { cp, mkdir, rm, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Create a sandbox directory for one case and copy its fixture into it.
 * A case without a fixture/ directory still gets an empty sandbox so the
 * agent prompt ("work in <dir>") is uniform.
 *
 * @param {{caseDef: object, sandboxRoot: string, runId: string}} args
 * @returns {Promise<string>} absolute sandbox path
 */
export async function createSandbox({ caseDef, sandboxRoot, runId }) {
  const dir = resolve(sandboxRoot, runId, caseDef.id)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  if (caseDef.fixtureDir) {
    await cp(caseDef.fixtureDir, dir, { recursive: true, force: true })
  }
  return dir
}

/** Remove a sandbox, ignoring "already gone". */
export async function destroySandbox(dir) {
  await rm(dir, { recursive: true, force: true })
}

/**
 * List files created or changed under a sandbox, relative to the sandbox
 * root. Used for the scorecard's artifact trail and for allowedPaths checks.
 * Symlinks are not followed.
 */
export async function listSandboxFiles(dir, { maxEntries = 500 } = {}) {
  const out = []
  async function walk(current, prefix) {
    if (out.length >= maxEntries) return
    const entries = await readdir(current, { withFileTypes: true })
    for (const e of entries) {
      if (out.length >= maxEntries) return
      const rel = prefix ? `${prefix}/${e.name}` : e.name
      const abs = join(current, e.name)
      if (e.isDirectory()) await walk(abs, rel)
      else if (e.isFile()) {
        const s = await stat(abs)
        out.push({ path: rel, bytes: s.size })
      }
    }
  }
  if (existsSync(dir)) await walk(dir, '')
  return out.sort((a, b) => a.path.localeCompare(b.path))
}
