// Deterministic checks over the sandbox after the agent finished.
// No model calls, no wall-clock dependence: same sandbox, same score.
// Each assertion resolves to { kind, path?, passed, detail }.

import { readFile, access } from 'node:fs/promises'
import { constants } from 'node:fs'
import { exec } from 'node:child_process'
import { isAbsolute, join, normalize, sep } from 'node:path'

/**
 * Resolve a case-relative path inside the sandbox, refusing to escape it.
 * A case may assert on `src/a.ts` but never on `../../etc/passwd`.
 */
export function resolveInside(sandboxDir, relPath) {
  const cleaned = String(relPath).replaceAll('\\', '/')
  if (isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new Error(`assertion path must be sandbox-relative, got absolute: ${relPath}`)
  }
  const base = normalize(sandboxDir)
  const target = normalize(join(base, cleaned))
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`assertion path escapes the sandbox: ${relPath}`)
  }
  return target
}

async function readTextCapped(absPath, maxBytes) {
  const buf = await readFile(absPath)
  const truncated = buf.length > maxBytes
  return { text: buf.subarray(0, maxBytes).toString('utf8'), truncated }
}

async function exists(absPath) {
  try {
    await access(absPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/** Run one assertion. Never throws for a plain assertion failure. */
export async function evalAssertion(assertion, ctx) {
  const { sandboxDir, maxArtifactBytes } = ctx
  const kind = assertion.kind

  try {
    switch (kind) {
      case 'file-exists': {
        const abs = resolveInside(sandboxDir, assertion.path)
        const ok = await exists(abs)
        return { kind, path: assertion.path, passed: ok, detail: ok ? 'present' : 'missing' }
      }
      case 'file-absent': {
        const abs = resolveInside(sandboxDir, assertion.path)
        const ok = await exists(abs)
        return { kind, path: assertion.path, passed: !ok, detail: ok ? 'present (should be absent)' : 'absent' }
      }
      case 'file-contains':
      case 'file-not-contains':
      case 'file-matches': {
        const abs = resolveInside(sandboxDir, assertion.path)
        if (!(await exists(abs))) {
          return { kind, path: assertion.path, passed: false, detail: 'file missing' }
        }
        const { text, truncated } = await readTextCapped(abs, maxArtifactBytes)
        let passed
        if (kind === 'file-contains') passed = text.includes(assertion.value)
        else if (kind === 'file-not-contains') passed = !text.includes(assertion.value)
        else passed = new RegExp(assertion.value).test(text)
        return {
          kind,
          path: assertion.path,
          passed,
          detail: `${passed ? 'match' : 'no match'} for ${JSON.stringify(assertion.value)}${truncated ? ' (file truncated at cap)' : ''}`,
        }
      }
      case 'file-equals-expect': {
        const abs = resolveInside(sandboxDir, assertion.path)
        if (!(await exists(abs))) {
          return { kind, path: assertion.path, passed: false, detail: 'file missing' }
        }
        if (!ctx.expectDir) {
          return { kind, path: assertion.path, passed: false, detail: 'case has no expect/ directory' }
        }
        const expected = await readFile(resolveInside(ctx.expectDir, assertion.expect), 'utf8')
        const actual = await readFile(abs, 'utf8')
        const passed = normalizeEol(actual) === normalizeEol(expected)
        return {
          kind,
          path: assertion.path,
          passed,
          detail: passed ? 'equals expect/' + assertion.expect : 'content differs from expect/' + assertion.expect,
        }
      }
      case 'command': {
        const res = await runCommand(assertion.run, sandboxDir, ctx.commandTimeoutMs)
        const wantExit = assertion.expectExitCode ?? 0
        const passed = res.exitCode === wantExit
        return {
          kind,
          passed,
          detail: `exit ${res.exitCode} (want ${wantExit})${res.output ? `: ${res.output.slice(0, 400)}` : ''}`,
        }
      }
      default:
        return { kind, passed: false, detail: `unsupported assertion kind ${kind}` }
    }
  } catch (e) {
    return { kind, path: assertion.path, passed: false, detail: `error: ${e.message}` }
  }
}

function normalizeEol(s) {
  return s.replaceAll('\r\n', '\n')
}

function runCommand(cmd, cwd, timeoutMs) {
  return new Promise((resolveP) => {
    exec(cmd, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = `${stdout ?? ''}${stderr ?? ''}`.trim()
      if (err && typeof err.code === 'number') resolveP({ exitCode: err.code, output: out })
      else if (err) resolveP({ exitCode: 1, output: out || err.message })
      else resolveP({ exitCode: 0, output: out })
    })
  })
}

/**
 * Evaluate every assertion of a case.
 * @returns {{assertions: object[], passed: boolean, passedCount: number, total: number}}
 */
export async function evalAssertions(caseDef, ctx) {
  const results = []
  for (const a of caseDef.assertions) results.push(await evalAssertion(a, ctx))
  const passedCount = results.filter((r) => r.passed).length
  return {
    assertions: results,
    passed: passedCount === results.length,
    passedCount,
    total: results.length,
  }
}
