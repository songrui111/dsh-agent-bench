// Loading and validating suites and cases.
//
//   suite/
//     suite.json
//     <case>/
//       case.json      required
//       fixture/       copied into the sandbox before the agent runs
//       expect/        expected files for file-equals-expect
//
// Plain Node, no DSH imports.

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Thrown for a structurally invalid suite or case. */
export class CaseValidationError extends Error {
  constructor(message, path) {
    super(path ? `${message} (${path})` : message)
    this.name = 'CaseValidationError'
    this.path = path
  }
}

const CASE_ID_RE = /^[a-z0-9][a-z0-9._-]*$/

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Validate and normalize one case manifest.
 * @param {unknown} raw - parsed case.json
 * @param {string} dir - the case directory (for error messages and fixtures)
 */
export function normalizeCase(raw, dir) {
  if (!isPlainObject(raw)) throw new CaseValidationError('case.json must be an object', dir)

  const id = raw.id
  if (typeof id !== 'string' || !CASE_ID_RE.test(id)) {
    throw new CaseValidationError(`id must match ${CASE_ID_RE}`, dir)
  }
  if (typeof raw.task !== 'string' || raw.task.trim() === '') {
    throw new CaseValidationError('task must be a non-empty string', dir)
  }

  const assertions = raw.assertions ?? []
  if (!Array.isArray(assertions)) {
    throw new CaseValidationError('assertions must be an array', dir)
  }
  assertions.forEach((a, i) => assertAssertionShape(a, `${dir}#assertions[${i}]`))

  let llmReview = null
  if (raw.llmReview !== undefined && raw.llmReview !== null) {
    if (!isPlainObject(raw.llmReview)) {
      throw new CaseValidationError('llmReview must be an object', dir)
    }
    const { criteria, minScore } = raw.llmReview
    if (typeof criteria !== 'string' || criteria.trim() === '') {
      throw new CaseValidationError('llmReview.criteria must be a non-empty string', dir)
    }
    if (minScore !== undefined && (typeof minScore !== 'number' || minScore < 0 || minScore > 1)) {
      throw new CaseValidationError('llmReview.minScore must be a number in [0,1]', dir)
    }
    llmReview = { criteria, minScore: minScore ?? 0.7 }
  }

  const fixtureDir = join(dir, 'fixture')
  const expectDir = join(dir, 'expect')

  return {
    id,
    title: typeof raw.title === 'string' && raw.title ? raw.title : id,
    task: raw.task,
    // Files the agent is allowed to touch. Empty = whole sandbox.
    allowedPaths: Array.isArray(raw.allowedPaths) ? raw.allowedPaths.filter((p) => typeof p === 'string') : [],
    assertions,
    llmReview,
    fixtureDir: existsSync(fixtureDir) ? fixtureDir : null,
    expectDir: existsSync(expectDir) ? expectDir : null,
    dir,
  }
}

function assertAssertionShape(a, where) {
  if (!isPlainObject(a)) throw new CaseValidationError('assertion must be an object', where)
  const kind = a.kind
  switch (kind) {
    case 'file-exists':
    case 'file-absent':
      if (typeof a.path !== 'string' || !a.path) {
        throw new CaseValidationError(`${kind} requires a string path`, where)
      }
      break
    case 'file-contains':
    case 'file-matches':
    case 'file-not-contains':
      if (typeof a.path !== 'string' || !a.path) {
        throw new CaseValidationError(`${kind} requires a string path`, where)
      }
      if (typeof a.value !== 'string') {
        throw new CaseValidationError(`${kind} requires a string value`, where)
      }
      if (kind === 'file-matches') {
        try {
          new RegExp(a.value)
        } catch (e) {
          throw new CaseValidationError(`file-matches value is not a valid RegExp: ${e.message}`, where)
        }
      }
      break
    case 'file-equals-expect': {
      if (typeof a.path !== 'string' || !a.path) {
        throw new CaseValidationError(`${kind} requires a string path`, where)
      }
      if (typeof a.expect !== 'string' || !a.expect) {
        throw new CaseValidationError(`${kind} requires a string expect file name`, where)
      }
      break
    }
    case 'command': {
      if (typeof a.run !== 'string' || !a.run) {
        throw new CaseValidationError('command requires a string run', where)
      }
      if (a.expectExitCode !== undefined && !Number.isInteger(a.expectExitCode)) {
        throw new CaseValidationError('command.expectExitCode must be an integer', where)
      }
      break
    }
    default:
      throw new CaseValidationError(
        `unknown assertion kind ${JSON.stringify(kind)}; expected file-exists|file-absent|file-contains|file-matches|file-not-contains|file-equals-expect|command`,
        where,
      )
  }
}

/**
 * Load one suite directory.
 * @param {string} suiteDir - absolute or relative path to the suite
 * @returns {Promise<{id:string,title:string,dir:string,cases:object[]}>}
 */
export async function loadSuite(suiteDir) {
  const dir = resolve(suiteDir)
  const manifestPath = join(dir, 'suite.json')
  let manifestRaw
  try {
    manifestRaw = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (e) {
    throw new CaseValidationError(`cannot read suite.json: ${e.message}`, dir)
  }
  if (!isPlainObject(manifestRaw)) throw new CaseValidationError('suite.json must be an object', dir)
  if (typeof manifestRaw.id !== 'string' || !CASE_ID_RE.test(manifestRaw.id)) {
    throw new CaseValidationError(`suite id must match ${CASE_ID_RE}`, dir)
  }

  const entries = await readdir(dir, { withFileTypes: true })
  const caseDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
  const cases = []
  for (const name of caseDirs) {
    const caseDir = join(dir, name)
    if (!existsSync(join(caseDir, 'case.json'))) continue
    let raw
    try {
      raw = JSON.parse(await readFile(join(caseDir, 'case.json'), 'utf8'))
    } catch (e) {
      throw new CaseValidationError(`cannot read case.json: ${e.message}`, caseDir)
    }
    cases.push(normalizeCase(raw, caseDir))
  }

  const seen = new Set()
  for (const c of cases) {
    if (seen.has(c.id)) throw new CaseValidationError(`duplicate case id ${c.id}`, dir)
    seen.add(c.id)
  }
  if (cases.length === 0) throw new CaseValidationError('suite contains no cases', dir)

  return {
    id: manifestRaw.id,
    title: typeof manifestRaw.title === 'string' ? manifestRaw.title : manifestRaw.id,
    dir,
    cases,
  }
}

/**
 * Discover every suite under a root directory (each suite is a direct child
 * holding suite.json). Missing root yields an empty list rather than throwing,
 * so a fresh checkout reads as "no benchmarks yet".
 */
export async function discoverSuites(rootDir) {
  const dir = resolve(rootDir)
  if (!existsSync(dir)) return []
  const s = await stat(dir)
  if (!s.isDirectory()) throw new CaseValidationError('suitesRoot is not a directory', dir)
  const entries = await readdir(dir, { withFileTypes: true })
  const suites = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const candidate = join(dir, e.name)
    if (!existsSync(join(candidate, 'suite.json'))) continue
    suites.push(await loadSuite(candidate))
  }
  return suites.sort((a, b) => a.id.localeCompare(b.id))
}
