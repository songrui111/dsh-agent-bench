// Plugin entry: read config, register the tools and the /bench command, wire
// up the real driver and reviewer. Everything else lives in the sibling
// modules, which don't import DSH.

import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { randomUUID } from 'node:crypto'
import { resolve, join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'

import { loadSuites, copyBundledSuites } from './suites.js'
import { renderRunSummary, renderHistoryRows } from './report.js'
import { resolveInside } from './assertions.js'
import { runSuite } from './runner.js'
import {
  resolveCli,
  prepareBenchHome,
  runCli,
  buildSpawn,
  DEFAULT_HOME_DIR,
  DEFAULT_PROFILE,
} from './host.js'
import {
  buildScorecard,
  writeScorecard,
  writeScorecardMarkdown,
  readScorecard,
  compareScorecards,
  renderComparison,
  readIndex,
  latestRunFor,
  listRuns,
} from './scorecard.js'

export const name = 'dsh-agent-bench'

// Starter suite inside the package, used read-only until the user copies it.
const BUNDLED_SUITES_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmarks')

export const Config = z.object({
  suitesRoot: z.string().default('benchmarks'),
  scorecardRoot: z.string().default('.agent-bench'),
  sandboxRoot: z.string().default('.agent-bench/sandboxes'),
  caseTimeoutMs: z.number().default(300000),
  keepSandboxes: z.boolean().default(false),
  llmReviewEnabled: z.boolean().default(true),
  maxArtifactBytes: z.number().default(262144),
  // Absolute path to the dsh CLI entry (…/@deepseek-ai/dsh/lib/bin.js).
  // A GUI-launched host does not inherit a shell environment, so this cannot
  // rely on DSH_BENCH_CLI being exported; the path belongs in profile config.
  cliPath: z.string().default(''),
  // DSH_HOME the benchmark runs use. Keep it separate from the user's real
  // home so a run never writes into their sessions or credentials.
  dshHome: z.string().default(''),
  // Launcher args for the spawned CLI. The default assumes a `headless`
  // profile exists in dshHome; a profile that needs an auth overlay supplies
  // its own e.g. ["--profile","bench","--patch",".../bench-overlay.yml"].
  cliArgs: z.array(z.string()).default(['--profile', 'headless']),
  // Optional reviewer target. When empty the plugin asks the host for the
  // currently selected model instead.
  llmProvider: z.string().default(''),
  llmModel: z.string().default(''),
  // Language of the human-readable output (summaries, history, .md report).
  // Tool descriptions stay English: they are read by the model, not the user.
  language: z.string().default('zh'),
})

function resolveConfig(raw) {
  const cfg = { ...Config(), ...(raw ?? {}) }
  if (!Number.isFinite(cfg.caseTimeoutMs) || cfg.caseTimeoutMs <= 0) {
    throw new Error('dsh-agent-bench: caseTimeoutMs must be a positive number')
  }
  if (!Number.isFinite(cfg.maxArtifactBytes) || cfg.maxArtifactBytes <= 0) {
    throw new Error('dsh-agent-bench: maxArtifactBytes must be a positive number')
  }
  return cfg
}

/** Absolute workspace root for this session, or process cwd as a fallback. */
function workspaceRootOf(ctx, exec) {
  const header = exec?.agent?.session?.header
  if (header && typeof header.cwd === 'string') return header.cwd
  return process.cwd()
}

// Runs the CLI with the case task inside the sandbox, under the isolated home.
// Works for both a JS entry under node and a `dsh` binary on PATH.
export function makeHeadlessDriver({ cli, cliArgs = [], home }) {
  return {
    async run({ task, sandboxDir, timeoutMs, signal }) {
      if (!cli) {
        return { ok: false, error: 'no dsh CLI resolved (set cliPath, export DSH_BENCH_CLI, or put dsh on PATH)' }
      }
      const plan = buildSpawn(cli, cliArgs, task)
      const useShell = plan.shell === true

      return await new Promise((resolveP) => {
        const child = spawn(
          useShell ? toShellCommand(plan.command, plan.args) : plan.command,
          useShell ? [] : plan.args,
          {
            cwd: sandboxDir,
            env: {
              ...process.env,
              // Hard isolation: sessions, storages and credentials live under
              // this throwaway home, never the user's real one.
              DSH_HOME: home ?? resolve(sandboxDir, '.bench-home'),
              DSH_PERMISSION_MODE: 'danger-full-access',
            },
            shell: useShell,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        )

        let out = ''
        let err = ''
        const cap = 200_000
        child.stdout.on('data', (d) => {
          if (out.length < cap) out += d.toString('utf8')
        })
        child.stderr.on('data', (d) => {
          if (err.length < cap) err += d.toString('utf8')
        })

        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {}
          resolveP({ ok: false, error: `timeout after ${timeoutMs}ms`, output: out })
        }, timeoutMs)

        const onAbort = () => {
          try {
            child.kill()
          } catch {}
        }
        signal?.addEventListener('abort', onAbort, { once: true })

        child.on('error', (e) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolveP({ ok: false, error: `spawn failed: ${e.message}` })
        })
        child.on('close', (code) => {
          clearTimeout(timer)
          signal?.removeEventListener('abort', onAbort)
          resolveP({
            ok: code === 0,
            exitCode: code,
            output: out.trim(),
            error: code === 0 ? null : (err.trim() || `exit ${code}`),
          })
        })
      })
    },
  }
}

// Quote argv for shell: true. Only needed for the `dsh` shim on PATH, where
// Windows requires a shell; quoting keeps task text with spaces or & intact.
function toShellCommand(command, args) {
  const q = (s) => `"${String(s).replaceAll('"', '""')}"`
  return [command, ...args.map(q)].join(' ')
}

/** Bounds for what one review is allowed to read, so a big tree cannot blow the prompt. */
const REVIEW_MAX_FILES = 8
const REVIEW_MAX_CHARS_PER_FILE = 4000
const REVIEW_MAX_TOTAL_CHARS = 14000

// Files the reviewer gets to see: the ones the case asserts on, plus the ones
// the agent actually changed (diffed against fixture/).
//
// The second part matters. A case can express its whole verdict through a
// `command` assertion, which names no file, so reading only asserted paths
// hides the file the agent edited and the reviewer answers "cannot verify".
async function collectReviewExcerpts(caseDef, sandboxDir, artifacts) {
  const declared = []
  for (const a of caseDef.assertions ?? []) {
    if (typeof a.path === 'string' && !declared.includes(a.path)) declared.push(a.path)
  }

  // Diff the sandbox against fixture/ to find what the agent touched.
  const changed = []
  for (const a of (artifacts ?? []).slice(0, 200)) {
    let abs
    try {
      abs = resolveInside(sandboxDir, a.path)
    } catch {
      continue
    }
    let current
    try {
      current = await readFile(abs, 'utf8')
    } catch {
      continue
    }
    if (!caseDef.fixtureDir) {
      changed.push(a.path) // no fixture: everything is agent output
      continue
    }
    let original = null
    try {
      original = await readFile(resolveInside(caseDef.fixtureDir, a.path), 'utf8')
    } catch {
      original = null
    }
    if (original === null || original !== current) changed.push(a.path)
  }

  // Order: asserted AND changed (most informative), then asserted, then the rest.
  const ordered = []
  const push = (p) => {
    if (typeof p === 'string' && !ordered.includes(p)) ordered.push(p)
  }
  for (const p of declared) if (changed.includes(p)) push(p)
  for (const p of declared) push(p)
  for (const p of changed) push(p)
  if (ordered.length === 0) return ''

  const blocks = []
  let total = 0
  for (const rel of ordered.slice(0, REVIEW_MAX_FILES)) {
    let abs
    try {
      abs = resolveInside(sandboxDir, rel)
    } catch {
      continue
    }
    let text
    try {
      text = await readFile(abs, 'utf8')
    } catch {
      continue // absent: the assertion already reports that
    }
    let slice =
      text.length > REVIEW_MAX_CHARS_PER_FILE
        ? `${text.slice(0, REVIEW_MAX_CHARS_PER_FILE)}\n... (truncated)`
        : text
    const room = REVIEW_MAX_TOTAL_CHARS - total
    if (room <= 0) break
    if (slice.length > room) slice = `${slice.slice(0, room)}\n... (truncated)`
    total += slice.length
    const tag = changed.includes(rel) ? 'changed by the agent' : 'unchanged from fixture'
    blocks.push(`--- ${rel} (${tag}) ---\n${slice}`)
  }
  if (blocks.length === 0) return ''
  return `FILES TO JUDGE (asserted paths and files the agent changed):\n\n${blocks.join('\n\n')}`
}

// Config first, then whatever model the host has selected. If neither works we
// throw: a missing reviewer should show up as an error, not a made-up score.
function resolveReviewTarget(ctx, { provider, model }) {
  if (provider && model) return { provider, model }
  const sel = ctx.get('agentDefaultModel')
  if (sel && typeof sel.currentSelection === 'function') {
    const s = sel.currentSelection()
    if (s && typeof s.provider === 'string' && typeof s.model === 'string') {
      return { provider: s.provider, model: s.model }
    }
  }
  throw new Error(
    'no reviewer model: set llmProvider/llmModel in the dsh-agent-bench config, or select a model in the host',
  )
}

// The reviewer over ctx.llm. The host only offers a streaming call: chunks are
// {type:'text-delta', text}, ending with {type:'finish', reason}.
export function makeLlmReviewer(ctx, { provider, model } = {}) {
  return async ({ caseDef, sandboxDir, artifacts }) => {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') {
      throw new Error('ctx.llm is not mounted or does not support stream(); LLM review is unavailable')
    }
    const target = resolveReviewTarget(ctx, { provider, model })

    // Feed the reviewer the case task, the criteria, the artifact trail, and
    // the content of the files that matter: asserted paths AND whatever the
    // agent actually changed. Names alone let a reviewer only guess; asserted
    // paths alone hide a file that only a `command` assertion refers to.
    const artifactList = artifacts.slice(0, 200).map((a) => `${a.path} (${a.bytes}B)`).join('\n')
    const excerpts = await collectReviewExcerpts(caseDef, sandboxDir, artifacts)
    const prompt = [
      "You are grading an AI coding agent's work on a benchmark case.",
      '',
      'TASK THE AGENT WAS GIVEN:',
      caseDef.task,
      '',
      'ACCEPTANCE CRITERIA:',
      caseDef.llmReview.criteria,
      '',
      'FILES THE AGENT LEFT BEHIND:',
      artifactList || '(none)',
      '',
      excerpts || '(no relevant file could be read)',
      '',
      'Return a single JSON object on one line: {"score": <0..1>, "reason": "<one sentence>"}',
      'Score 0 when the work is missing or off-target, 1 when it fully meets the criteria.',
    ].join('\n')

    let text = ''
    let failure = null
    let lastFinishKind = null
    // A reasoning model can spend the whole output budget thinking and emit no
    // text at all (the same failure mode dsh-deepread documents). Escalate the
    // budget across attempts, and on the last one add an explicit nudge.
    const attempts = [
      { maxTokens: 1200, nudge: '' },
      { maxTokens: 2400, nudge: '' },
      { maxTokens: 3000, nudge: '\n\nDo not reason further. Output the JSON object now, nothing else.' },
    ]
    for (const { maxTokens, nudge } of attempts) {
      text = ''
      failure = null
      lastFinishKind = null
      for await (const chunk of llm.stream({
        provider: target.provider,
        model: target.model,
        system: 'You are a strict, terse grader. Reply with the JSON object only.',
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt + nudge }] }],
        temperature: 0.1,
        maxTokens,
      })) {
        if (!chunk || typeof chunk !== 'object') continue
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
          text += chunk.text
        } else if (chunk.type === 'finish') {
          const reason = chunk.reason
          lastFinishKind = reason && typeof reason.kind === 'string' ? reason.kind : null
          if (reason && (reason.kind === 'error' || reason.kind === 'aborted')) {
            const f = reason.failure
            failure = (f && (f.message || f.code)) || 'model call failed'
          }
        }
      }
      if (failure) break
      if (text.trim() !== '') break
    }
    if (failure) throw new Error(`reviewer model failed: ${failure}`)

    const parsed = extractJson(text)
    if (!parsed || typeof parsed.score !== 'number') {
      // Distinguish the two failure shapes for whoever reads the scorecard:
      // an empty stream means the model produced no text (usually reasoning
      // ate the budget), not that it answered with unparsable JSON.
      if (String(text).trim() === '') {
        throw new Error(
          `reviewer produced no text after ${attempts.length} attempts (last finish kind: ${lastFinishKind ?? 'unknown'})`,
        )
      }
      throw new Error(`reviewer did not return {score,reason}: ${String(text).slice(0, 200)}`)
    }
    return { score: parsed.score, reason: parsed.reason ?? '', model: target.model }
  }
}

function extractJson(text) {
  const m = /{[^{}]*"score"[^{}]*}/.exec(String(text))
  if (!m) return null
  try {
    return JSON.parse(m[0])
  } catch {
    return null
  }
}

export async function apply(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig)

  const resolveRoots = (exec) => {
    const base = workspaceRootOf(ctx, exec)
    return {
      base,
      suitesRoot: resolve(base, config.suitesRoot),
      scorecardRoot: resolve(base, config.scorecardRoot),
      sandboxRoot: resolve(base, config.sandboxRoot),
      bundledRoot: BUNDLED_SUITES_ROOT,
    }
  }

  /** Suites from the workspace, or the bundled starter suite when it is empty. */
  const suitesFor = (roots) => loadSuites({ workspaceRoot: roots.suitesRoot, bundledRoot: roots.bundledRoot })

  // Resolve the CLI and prepare the isolated home at most once per workspace.
  // Both are expensive (a probe + a possible profile init), and every case of
  // a run wants the same answer.
  const hostCache = new Map()

  const ensureHost = async (exec) => {
    const roots = resolveRoots(exec)
    const key = roots.base
    if (!hostCache.has(key)) {
      hostCache.set(
        key,
        (async () => {
          const cli = resolveCli({ explicit: config.cliPath })
          if (cli === null) {
            throw new Error(
              'no dsh CLI found: set `cliPath` to …/@deepseek-ai/dsh/lib/bin.js, '
                + 'export DSH_BENCH_CLI, or put `dsh` on PATH',
            )
          }
          const home = config.dshHome ? resolve(roots.base, config.dshHome) : join(roots.base, DEFAULT_HOME_DIR)
          const realHome = process.env.DSH_HOME || join(homedir(), '.dsh')
          const prepared = await prepareBenchHome({
            home,
            realHome,
            cli,
            profile: DEFAULT_PROFILE,
            runCli: (c, args, cwd) => runCli(c, args, cwd, { home }),
          })
          return { cli, prepared }
        })(),
      )
    }
    return hostCache.get(key)
  }

  const makeDriver = (exec) => ({
    async run(args) {
      const host = await ensureHost(exec)
      // An explicit cliArgs in config wins; otherwise use the derived ones
      // (profile + generated auth overlay).
      const cliArgs =
        Array.isArray(config.cliArgs) && config.cliArgs.length ? config.cliArgs : host.prepared.cliArgs
      return makeHeadlessDriver({ cli: host.cli, cliArgs, home: host.prepared.home }).run(args)
    },
  })

  // ---------------------------------------------------------------- tools

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bench_suites',
          description:
            'List the benchmark suites and cases available, with case counts and assertion counts. On a fresh install this reports the bundled starter suite (source "bundled"); call bench_init to copy it into the workspace so it can be edited.',
          parameters: {},
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                root: { type: 'string' },
                source: { type: 'string' },
                suites: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      title: { type: 'string' },
                      path: { type: 'string' },
                      cases: { type: 'integer' },
                      assertions: { type: 'integer' },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
            render(_args, value) {
              const zh = config.language !== 'en'
              if (!value.suites.length) {
                return [
                  {
                    type: 'text',
                    text: zh
                      ? `${value.root} 下没有找到基准套件。新建方式是：一个 suite.json 加每个用例一个目录。`
                      : `No benchmark suites under ${value.root}. Create one with a suite.json plus one directory per case.`,
                  },
                ]
              }
              const lines = value.suites.map((s) =>
                zh
                  ? `- ${s.id}（${s.title}）— ${s.cases} 条用例，${s.assertions} 条断言`
                  : `- ${s.id} (${s.title}) — ${s.cases} case(s), ${s.assertions} assertion(s)`,
              )
              const where =
                value.source === 'bundled'
                  ? zh
                    ? `${value.root}（内置起始套件 —— 运行 bench_init 可复制到工作区）`
                    : `${value.root} (bundled starter suite — run bench_init to copy it into the workspace)`
                  : value.root
              return [
                {
                  type: 'text',
                  text: zh
                    ? `基准套件（位于 ${where}）：\n${lines.join('\n')}`
                    : `Benchmark suites under ${where}:\n${lines.join('\n')}`,
                },
              ]
            },
          },
          async execute(_args, exec) {
            const roots = resolveRoots(exec)
            const { suites, source } = await suitesFor(roots)
            return {
              ok: true,
              root: source === 'bundled' ? roots.bundledRoot : roots.suitesRoot,
              source,
              suites: suites.map((s) => ({
                id: s.id,
                title: s.title,
                path: s.dir,
                cases: s.cases.length,
                assertions: s.cases.reduce((n, c) => n + c.assertions.length, 0),
              })),
            }
          },
        }),
      ),
    'dsh-agent-bench: bench_suites tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bench_init',
          description:
            'Copy the bundled starter benchmark suite into the workspace so it can be edited and extended. Existing suites are never overwritten.',
          parameters: {},
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                root: { type: 'string' },
                copied: { type: 'array', items: { type: 'string' } },
                skipped: { type: 'array', items: { type: 'string' } },
              },
              additionalProperties: false,
            },
            render(_args, value) {
              const zh = config.language !== 'en'
              if (!value.copied.length && !value.skipped.length) {
                return [
                  {
                    type: 'text',
                    text: zh ? '没有可复制的内容：这个版本没有内置套件。' : 'Nothing to copy: this build ships no starter suite.',
                  },
                ]
              }
              const parts = []
              if (value.copied.length) parts.push(zh ? `已复制：${value.copied.join('、')}` : `copied: ${value.copied.join(', ')}`)
              if (value.skipped.length) parts.push(zh ? `已存在，跳过：${value.skipped.join('、')}` : `already present: ${value.skipped.join(', ')}`)
              return [
                {
                  type: 'text',
                  text: zh
                    ? `${value.root} 下的基准套件 —— ${parts.join('；')}`
                    : `Benchmarks in ${value.root} — ${parts.join('; ')}`,
                },
              ]
            },
          },
          async execute(_args, exec) {
            const roots = resolveRoots(exec)
            const { copied, skipped } = await copyBundledSuites({
              bundledRoot: roots.bundledRoot,
              workspaceRoot: roots.suitesRoot,
            })
            return { ok: true, root: roots.suitesRoot, copied, skipped }
          },
        }),
      ),
    'dsh-agent-bench: bench_init tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bench_run',
          description:
            'Run a benchmark suite. Each case is copied into an isolated sandbox, the agent is invoked through `dsh headless`, deterministic assertions are evaluated, and (when the case declares llmReview) an LLM review verdict is recorded separately. Writes a scorecard under the scorecard root and returns the run id. This is slow and spends model tokens: one real agent run per case.',
          parameters: {
            suite: { type: 'string', description: 'Suite id to run.', required: true },
            cases: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional subset of case ids. Omit to run every case.',
            },
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                runId: { type: 'string' },
                suiteId: { type: 'string' },
                passed: { type: 'integer' },
                total: { type: 'integer' },
                passRate: { type: 'number' },
                scorecard: { type: 'string' },
                report: { type: 'string' },
                summary: { type: 'string' },
              },
              additionalProperties: false,
            },
            render(_args, value) {
              return [{ type: 'text', text: value.summary }]
            },
          },
          async execute(args, exec) {
            const roots = resolveRoots(exec)
            const { suites: available, source } = await suitesFor(roots)
            const suite = available.find((s) => s.id === args.suite)
            if (!suite) {
              throw new Error(
                available.length
                  ? `unknown suite ${JSON.stringify(args.suite)} (${source}); available: ${available.map((s) => s.id).join(', ')}`
                  : `no benchmark suites found under ${roots.suitesRoot}`,
              )
            }
            const wanted = Array.isArray(args.cases) && args.cases.length ? new Set(args.cases) : null
            const selected = {
              ...suite,
              cases: wanted ? suite.cases.filter((c) => wanted.has(c.id)) : suite.cases,
            }
            if (selected.cases.length === 0) {
              throw new Error(`no matching cases in suite ${suite.id} for: ${[...(wanted ?? [])].join(', ')}`)
            }

            const runId = newRunId()
            const driver = makeDriver(exec)
            const reviewer =
              config.llmReviewEnabled && selected.cases.some((c) => c.llmReview)
                ? makeLlmReviewer(ctx, { provider: config.llmProvider, model: config.llmModel })
                : undefined

            const cases = await runSuite({
              suite: selected,
              sandboxRoot: roots.sandboxRoot,
              runId,
              agentDriver: driver,
              reviewer,
              caseTimeoutMs: config.caseTimeoutMs,
              maxArtifactBytes: config.maxArtifactBytes,
              keepSandbox: config.keepSandboxes,
              signal: exec.signal,
            })

            const card = buildScorecard({
              runId,
              suite: selected,
              cases,
              environment: {
                plugin: name,
                node: process.version,
                platform: process.platform,
                arch: process.arch,
                llmReviewEnabled: config.llmReviewEnabled,
              },
              startedAt: cases[0]?.startedAt ?? new Date().toISOString(),
              finishedAt: new Date().toISOString(),
            })
            const file = await writeScorecard(roots.scorecardRoot, card)
            const report = await writeScorecardMarkdown(roots.scorecardRoot, card, { language: config.language })
            const durationMs = cases.reduce((n, c) => n + (c.durationMs ?? 0), 0)
            return {
              ok: true,
              runId,
              suiteId: selected.id,
              passed: card.summary.passed,
              total: card.summary.total,
              passRate: card.summary.passRate,
              scorecard: file,
              report,
              summary: renderRunSummary({
                suiteId: selected.id,
                runId,
                cases,
                passed: card.summary.passed,
                total: card.summary.total,
                passRate: card.summary.passRate,
                durationMs,
                scorecardPath: file,
                reportPath: report,
                language: config.language,
              }),
            }
          },
        }),
      ),
    'dsh-agent-bench: bench_run tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bench_compare',
          description:
            'Compare two benchmark runs of the same suite and report regressions. With no run ids it compares the newest run against the one before it. The verdict is driven by deterministic assertions only; LLM review differences are reported as drift, never as a regression.',
          parameters: {
            suite: { type: 'string', description: 'Suite id.', required: true },
            baseline: { type: 'string', description: 'Baseline run id. Defaults to the second-newest run.' },
            candidate: { type: 'string', description: 'Candidate run id. Defaults to the newest run.' },
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                verdict: { type: 'string' },
                fromRate: { type: 'number' },
                toRate: { type: 'number' },
                regressions: { type: 'integer' },
                fixed: { type: 'integer' },
                report: { type: 'string' },
              },
              additionalProperties: false,
            },
            render(_args, value) {
              return [{ type: 'text', text: value.report }]
            },
          },
          async execute(args, exec) {
            const roots = resolveRoots(exec)
            const candidateId = args.candidate ?? (await latestRunFor(roots.scorecardRoot, args.suite))
            const baselineId =
              args.baseline ?? (candidateId ? await latestRunFor(roots.scorecardRoot, args.suite, candidateId) : null)
            if (!baselineId || !candidateId) {
              throw new Error(
                `need two runs of suite ${args.suite} to compare; found baseline=${baselineId ?? 'none'} candidate=${candidateId ?? 'none'}`,
              )
            }
            const baseline = await readScorecard(roots.scorecardRoot, baselineId, args.suite)
            const candidate = await readScorecard(roots.scorecardRoot, candidateId, args.suite)
            if (!baseline) throw new Error(`baseline scorecard not found: ${baselineId}/${args.suite}`)
            if (!candidate) throw new Error(`candidate scorecard not found: ${candidateId}/${args.suite}`)

            const cmp = compareScorecards(baseline, candidate)
            return {
              ok: true,
              verdict: cmp.verdict,
              fromRate: cmp.fromRate,
              toRate: cmp.toRate,
              regressions: cmp.regressions.length,
              fixed: cmp.fixed.length,
              report: renderComparison(cmp, { language: config.language }),
            }
          },
        }),
      ),
    'dsh-agent-bench: bench_compare tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'bench_history',
          description: 'List stored benchmark runs (newest last) with suite, time and pass rate, so a run to compare against can be chosen.',
          parameters: {
            suite: { type: 'string', description: 'Optional suite id filter.' },
          },
          output: {
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                runs: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      runId: { type: 'string' },
                      suiteId: { type: 'string' },
                      finishedAt: { type: 'string' },
                      passRate: { type: 'number' },
                      passed: { type: 'integer' },
                      total: { type: 'integer' },
                    },
                    additionalProperties: false,
                  },
                },
              },
              additionalProperties: false,
            },
            render(_args, value) {
              return [{ type: 'text', text: renderHistoryRows(value.runs, { language: config.language }) }]
            },
          },
          async execute(args, exec) {
            const roots = resolveRoots(exec)
            const all = await readIndex(roots.scorecardRoot)
            const runs = args.suite ? all.filter((r) => r.suiteId === args.suite) : all
            return { ok: true, runs }
          },
        }),
      ),
    'dsh-agent-bench: bench_history tool',
  )

  // ---------------------------------------------------------------- command

  ctx.effect(
    () =>
      ctx.commands.register({
        name: 'bench',
        description: 'Agent capability benchmark: list suites, show run history, or compare two runs',
        handler: async (invocation) => {
          const zh = config.language !== 'en'
          try {
            const arg = invocation.rawInput.trim()
            const roots = resolveRoots()
            if (arg === '' || arg === 'list') {
              const { suites, source } = await suitesFor(roots)
              if (!suites.length) {
                return {
                  kind: 'success',
                  text: zh ? `${roots.suitesRoot} 下没有基准套件。` : `No benchmark suites under ${roots.suitesRoot}.`,
                }
              }
              const suffix = source === 'bundled'
                ? zh
                  ? '\n（内置起始套件 —— 运行 bench_init 可复制到工作区）'
                  : '\n(bundled starter suite — run bench_init to copy it locally)'
                : ''
              return {
                kind: 'success',
                text: suites
                  .map((s) => (zh
                    ? `${s.id}：${s.cases.length} 条用例 — ${s.title}`
                    : `${s.id}: ${s.cases.length} case(s) — ${s.title}`))
                  .join('\n') + suffix,
              }
            }
            if (arg === 'runs') {
              const runs = await readIndex(roots.scorecardRoot)
              return { kind: 'success', text: renderHistoryRows(runs, { language: config.language }) }
            }
            if (arg.startsWith('compare ')) {
              const suite = arg.slice('compare '.length).trim()
              const candidateId = await latestRunFor(roots.scorecardRoot, suite)
              const baselineId = candidateId ? await latestRunFor(roots.scorecardRoot, suite, candidateId) : null
              if (!baselineId || !candidateId) {
                return {
                  kind: 'error',
                  text: zh ? `套件 ${suite} 需要至少两次运行才能对比。` : `need two runs of ${suite} to compare`,
                }
              }
              const b = await readScorecard(roots.scorecardRoot, baselineId, suite)
              const c = await readScorecard(roots.scorecardRoot, candidateId, suite)
              if (!b || !c) return { kind: 'error', text: zh ? '成绩卡缺失。' : 'scorecard missing' }
              return { kind: 'success', text: renderComparison(compareScorecards(b, c), { language: config.language }) }
            }
            return {
              kind: 'error',
              text: zh ? '用法：/bench [list|runs|compare <套件名>]' : 'usage: /bench [list|runs|compare <suite>]',
            }
          } catch (e) {
            return { kind: 'error', text: e instanceof Error ? e.message : String(e) }
          }
        },
      }),
    'dsh-agent-bench: /bench command',
  )
}

function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `${stamp}-${randomUUID().slice(0, 8)}`
}
