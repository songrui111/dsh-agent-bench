// Runs one case end to end, and a suite case by case.
//
// The agent sits behind a small seam:
//   run({ task, sandboxDir, timeoutMs, signal }) -> { ok, output?, error? }
// The plugin passes a real dsh spawn; tests pass a stub that writes files.

import { createSandbox, destroySandbox, listSandboxFiles } from './sandbox.js'
import { evalAssertions } from './assertions.js'

/**
 * Compose the prompt handed to the agent. Keeping the workspace hint explicit
 * is what makes cases portable across models: the agent is never asked to
 * guess where it should write.
 */
export function buildPrompt(caseDef, sandboxDir) {
  return [
    `Work in this directory: ${sandboxDir}`,
    '',
    caseDef.task,
  ].join('\n')
}

/**
 * Run one case.
 * @param {object} args
 * @param {object} args.caseDef - normalized case
 * @param {string} args.sandboxRoot
 * @param {string} args.runId
 * @param {{run:Function}} args.agentDriver
 * @param {Function} [args.reviewer] - ({caseDef, sandboxDir, artifacts}) -> {score, approved, reason}
 * @param {number} args.caseTimeoutMs
 * @param {number} args.maxArtifactBytes
 * @param {boolean} args.keepSandbox
 * @param {AbortSignal} [args.signal]
 */
export async function runCase({
  caseDef,
  sandboxRoot,
  runId,
  agentDriver,
  reviewer,
  caseTimeoutMs,
  maxArtifactBytes,
  keepSandbox,
  signal,
}) {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  let sandboxDir = null
  let agent = { ok: false, error: 'not started' }

  try {
    sandboxDir = await createSandbox({ caseDef, sandboxRoot, runId })

    agent = await agentDriver.run({
      task: buildPrompt(caseDef, sandboxDir),
      sandboxDir,
      timeoutMs: caseTimeoutMs,
      signal,
    })

    const evalCtx = {
      sandboxDir,
      expectDir: caseDef.expectDir,
      maxArtifactBytes,
      commandTimeoutMs: 60000,
    }
    const verdict = await evalAssertions(caseDef, evalCtx)
    const files = await listSandboxFiles(sandboxDir)

    let llm = null
    if (caseDef.llmReview && reviewer) {
      try {
        const r = await reviewer({ caseDef, sandboxDir, artifacts: files })
        const minScore = caseDef.llmReview.minScore ?? 0.7
        llm = {
          score: r.score,
          approved: r.score >= minScore,
          minScore,
          reason: r.reason ?? '',
          // Review drift is a first-class concern: record which reviewer
          // model produced it so two runs are only compared like-for-like.
          reviewerModel: r.model ?? null,
        }
      } catch (e) {
        llm = { score: null, approved: null, error: e.message, minScore: caseDef.llmReview.minScore ?? 0.7 }
      }
    }

    return {
      id: caseDef.id,
      title: caseDef.title,
      passed: verdict.passed && agent.ok,
      assertions: verdict.assertions,
      passedCount: verdict.passedCount,
      total: verdict.total,
      agent: {
        ok: agent.ok,
        exitCode: agent.exitCode ?? null,
        error: agent.error ?? null,
        usage: agent.usage ?? null,
      },
      llm,
      artifacts: files,
      durationMs: Date.now() - t0,
      startedAt,
      sandboxDir: keepSandbox ? sandboxDir : null,
    }
  } catch (e) {
    return {
      id: caseDef.id,
      title: caseDef.title,
      passed: false,
      assertions: [],
      passedCount: 0,
      total: caseDef.assertions.length,
      agent: { ok: false, error: e.message },
      llm: null,
      artifacts: [],
      durationMs: Date.now() - t0,
      startedAt,
      error: e.message,
      sandboxDir: keepSandbox ? sandboxDir : null,
    }
  } finally {
    if (sandboxDir && !keepSandbox) {
      await destroySandbox(sandboxDir).catch(() => {})
    }
  }
}

/**
 * Run every case of a suite sequentially.
 *
 * Sequential is deliberate: cases share a model endpoint and a token budget,
 * so running them concurrently would make durations and costs incomparable
 * between runs — which would defeat the point of a regression benchmark.
 */
export async function runSuite({
  suite,
  sandboxRoot,
  runId,
  agentDriver,
  reviewer,
  caseTimeoutMs,
  maxArtifactBytes,
  keepSandbox,
  signal,
  onCaseDone,
}) {
  const results = []
  for (const caseDef of suite.cases) {
    if (signal?.aborted) break
    const result = await runCase({
      caseDef,
      sandboxRoot,
      runId,
      agentDriver,
      reviewer,
      caseTimeoutMs,
      maxArtifactBytes,
      keepSandbox,
      signal,
    })
    results.push(result)
    onCaseDone?.(result)
  }
  return results
}
