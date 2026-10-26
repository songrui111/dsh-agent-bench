// Scorecards and the regression comparison.
//
// The deterministic verdict and the optional LLM review are separate fields
// on purpose: review drift must not read as a regression.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { formatDuration, formatPercent } from './report.js'

/** Build a scorecard object. */
export function buildScorecard({ runId, suite, cases, environment, startedAt, finishedAt }) {
  const total = cases.length
  const passed = cases.filter((c) => c.passed).length
  return {
    schema: 'dsh-agent-bench/scorecard',
    version: 1,
    runId,
    suiteId: suite.id,
    suiteTitle: suite.title,
    startedAt,
    finishedAt,
    environment,
    summary: {
      total,
      passed,
      failed: total - passed,
      // Deterministic pass rate only. LLM review never moves this number.
      passRate: total === 0 ? 0 : round(passed / total),
      llmReviewed: cases.filter((c) => c.llm).length,
      llmApproved: cases.filter((c) => c.llm?.approved).length,
    },
    cases,
  }
}

function round(n) {
  return Math.round(n * 10000) / 10000
}

/**
 * Render one scorecard as a readable Markdown report.
 *
 * The JSON is for diffing; this is for a person opening the folder. Same data,
 * ordered by what a reader wants first: verdict, then the case table, then the
 * evidence behind each case.
 */
export function renderRunMarkdown(card, { language = 'zh' } = {}) {
  const zh = language !== 'en'
  const lines = []
  const s = card.summary
  const icon = s.passed === s.total ? '✅' : s.passed === 0 ? '❌' : '⚠️'
  lines.push(zh ? `# 基准运行 — ${card.suiteId}` : `# Benchmark run — ${card.suiteId}`)
  lines.push('')
  lines.push(
    zh
      ? `**${icon} ${s.passed} / ${s.total} 通过（${formatPercent(s.passRate)}）**`
      : `**${icon} ${s.passed} / ${s.total} passed (${formatPercent(s.passRate)})**`,
  )
  lines.push('')
  lines.push(zh ? `- 套件：${card.suiteId} — ${card.suiteTitle}` : `- suite: ${card.suiteId} — ${card.suiteTitle}`)
  lines.push(zh ? `- 运行：\`${card.runId}\`` : `- run: \`${card.runId}\``)
  lines.push(
    zh
      ? `- 完成时间：${String(card.finishedAt).replace('T', ' ').slice(0, 19)}`
      : `- finished: ${String(card.finishedAt).replace('T', ' ').slice(0, 19)}`,
  )
  if (card.environment?.node) {
    const env = Object.entries(card.environment)
      .filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${v}`)
      .join(', ')
    if (env) lines.push(zh ? `- 环境：${env}` : `- environment: ${env}`)
  }
  lines.push('')

  lines.push(
    zh ? '| # | 用例 | 结果 | 耗时 | 评审 |' : '| # | case | result | time | review |',
  )
  lines.push('|---|------|--------|------|--------|')
  card.cases.forEach((c, i) => {
    const review = typeof c.llm?.score === 'number'
      ? `${c.llm.score.toFixed(1)}${c.llm.approved ? '' : zh ? '（低于阈值）' : ' (below bar)'}`
      : c.llm?.error
        ? zh ? '不可用' : 'n/a'
        : '—'
    const result = c.passed ? (zh ? '✅ 通过' : '✅ pass') : (zh ? '❌ 失败' : '❌ fail')
    lines.push(`| ${i + 1} | ${c.id} | ${result} | ${formatDuration(c.durationMs ?? 0, language)} | ${review} |`)
  })
  lines.push('')

  lines.push(zh ? '## 用例详情' : '## Case details')
  for (const c of card.cases) {
    lines.push('')
    lines.push(`### ${c.passed ? '✅' : '❌'} ${c.id} — ${c.title}`)
    lines.push('')
    for (const a of c.assertions ?? []) {
      const target = a.path ? ` \`${a.path}\`` : ''
      const mark = a.passed ? (zh ? '通过' : 'pass') : zh ? '**失败**' : '**fail**'
      lines.push(`- ${mark} — ${a.kind}${target}: ${a.detail}`)
    }
    if (c.agent && c.agent.ok === false) {
      lines.push(
        zh
          ? `- Agent：**未跑完** — ${c.agent.error ?? '未知原因'}`
          : `- agent: **did not finish** — ${c.agent.error ?? 'unknown'}`,
      )
    }
    if (c.llm) {
      if (typeof c.llm.score === 'number') {
        const verdict = c.llm.approved ? (zh ? '通过' : 'approved') : zh ? '低于阈值' : 'below bar'
        const reason = c.llm.reason || (zh ? '未给出理由' : 'no reason given')
        lines.push(zh
          ? `- 评审：${c.llm.score.toFixed(1)}（${verdict}）— ${reason}`
          : `- review: ${c.llm.score.toFixed(1)} (${verdict}) — ${reason}`)
      } else if (c.llm.error) {
        lines.push(zh ? `- 评审：不可用 — ${c.llm.error}` : `- review: unavailable — ${c.llm.error}`)
      }
    }
    if (c.error) lines.push(zh ? `- 错误：${c.error}` : `- error: ${c.error}`)
  }
  if (card.cases.some((c) => !c.passed)) {
    lines.push('')
    lines.push(
      zh
        ? '> 失败的用例会列出它的每一条断言，不用重跑就能看明白为什么失败。'
        : '> A failing case lists every assertion, so the reason is readable without rerunning anything.',
    )
  }
  return lines.join('\n')
}

/** Write the Markdown report next to the JSON. Returns its path. */
export async function writeScorecardMarkdown(root, card, { language = 'zh' } = {}) {
  const dir = join(root, 'runs', card.runId)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${card.suiteId}.md`)
  await writeFile(file, renderRunMarkdown(card, { language }), 'utf8')
  return file
}

/** Persist a scorecard under <root>/<runId>/<suiteId>.json and refresh index.json. */
export async function writeScorecard(root, card) {
  const dir = join(root, 'runs', card.runId)
  await mkdir(dir, { recursive: true })
  const file = join(dir, `${card.suiteId}.json`)
  await writeFile(file, JSON.stringify(card, null, 2), 'utf8')
  await appendIndex(root, {
    runId: card.runId,
    suiteId: card.suiteId,
    finishedAt: card.finishedAt,
    passRate: card.summary.passRate,
    passed: card.summary.passed,
    total: card.summary.total,
  })
  return file
}

async function appendIndex(root, row) {
  const indexPath = join(root, 'index.json')
  let index = []
  if (existsSync(indexPath)) {
    try {
      const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
      if (Array.isArray(parsed)) index = parsed
    } catch {
      index = []
    }
  }
  const rest = index.filter((r) => !(r.runId === row.runId && r.suiteId === row.suiteId))
  rest.push(row)
  rest.sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)))
  await writeFile(indexPath, JSON.stringify(rest, null, 2), 'utf8')
}

/** List every stored scorecard entry (newest last). */
export async function readIndex(root) {
  const indexPath = join(root, 'index.json')
  if (!existsSync(indexPath)) return []
  try {
    const parsed = JSON.parse(await readFile(indexPath, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Load one scorecard by run + suite. */
export async function readScorecard(root, runId, suiteId) {
  const file = join(root, 'runs', runId, `${suiteId}.json`)
  if (!existsSync(file)) return null
  return JSON.parse(await readFile(file, 'utf8'))
}

/**
 * Compare a baseline scorecard with a candidate one.
 *
 * The verdict is driven by deterministic assertions only:
 *   - regression: a case passed before and fails now
 *   - fixed:      a case failed before and passes now
 *   - unchanged:  same verdict, plus a note when the deterministic verdict
 *                 held but the LLM review compared differently
 */
export function compareScorecards(baseline, candidate) {
  const before = new Map(baseline.cases.map((c) => [c.id, c]))
  const after = new Map(candidate.cases.map((c) => [c.id, c]))

  const regressions = []
  const fixed = []
  const unchanged = []
  const onlyInBaseline = []
  const onlyInCandidate = []

  for (const [id, b] of before) {
    const a = after.get(id)
    if (!a) {
      onlyInBaseline.push(id)
      continue
    }
    if (b.passed && !a.passed) regressions.push({ id, title: a.title, detail: failedReason(a) })
    else if (!b.passed && a.passed) fixed.push({ id, title: a.title })
    else {
      const note = noteLlmDrift(b, a)
      unchanged.push(note ? { id, title: a.title, note } : { id, title: a.title })
    }
  }
  for (const id of after.keys()) if (!before.has(id)) onlyInCandidate.push(id)

  const fromRate = baseline.summary.passRate
  const toRate = candidate.summary.passRate
  let verdict
  if (regressions.length > 0) verdict = 'regressed'
  else if (fixed.length > 0) verdict = 'improved'
  else verdict = 'stable'

  return {
    suiteId: candidate.suiteId,
    baselineRunId: baseline.runId,
    candidateRunId: candidate.runId,
    verdict,
    fromRate,
    toRate,
    delta: round(toRate - fromRate),
    regressions,
    fixed,
    unchanged,
    onlyInBaseline,
    onlyInCandidate,
  }
}

function failedReason(c) {
  const failed = (c.assertions ?? []).filter((x) => !x.passed)
  if (failed.length === 0) return c.error ? String(c.error) : 'unknown'
  return failed.map((f) => `${f.kind}${f.path ? `(${f.path})` : ''}: ${f.detail}`).join('; ')
}

function noteLlmDrift(b, a) {
  if (!b.llm || !a.llm) return null
  if (b.llm.approved === a.llm.approved) return null
  return `deterministic verdict unchanged, but LLM review went ${b.llm.approved ? 'approve' : 'reject'} -> ${a.llm.approved ? 'approve' : 'reject'}`
}

/** Render a comparison as human-readable markdown. */
export function renderComparison(cmp, { language = 'zh' } = {}) {
  const zh = language !== 'en'
  const lines = []
  const D = zh
    ? { regressed: '🔴 回归', improved: '🟢 改善', stable: '⚪ 持平' }
    : { regressed: '🔴 regressed', improved: '🟢 improved', stable: '⚪ stable' }
  const icon = D[cmp.verdict] ?? cmp.verdict
  lines.push(zh ? `# 基准对比：${cmp.suiteId}` : `# Benchmark comparison — ${cmp.suiteId}`)
  lines.push('')
  lines.push(zh ? `**结论：${icon}**` : `**Verdict: ${icon}**`)
  lines.push('')
  lines.push(zh ? `| | 基线 | 候选 | 变化 |` : `| | baseline | candidate | change |`)
  lines.push(`|---|---|---|---|`)
  lines.push(
    zh
      ? `| 通过率 | ${(cmp.fromRate * 100).toFixed(1)}% | ${(cmp.toRate * 100).toFixed(1)}% | ${cmp.delta >= 0 ? '+' : ''}${(cmp.delta * 100).toFixed(1)}% |`
      : `| pass rate | ${(cmp.fromRate * 100).toFixed(1)}% | ${(cmp.toRate * 100).toFixed(1)}% | ${cmp.delta >= 0 ? '+' : ''}${(cmp.delta * 100).toFixed(1)}% |`,
  )
  lines.push(`| run | ${cmp.baselineRunId} | ${cmp.candidateRunId} | |`)
  if (cmp.regressions.length) {
    lines.push('')
    lines.push(zh ? '## 回归用例' : '## Regressed cases')
    for (const r of cmp.regressions) lines.push(`- **${r.id}** ${r.title} — ${r.detail}`)
  }
  if (cmp.fixed.length) {
    lines.push('')
    lines.push(zh ? '## 已修复用例' : '## Fixed cases')
    for (const r of cmp.fixed) lines.push(`- **${r.id}** ${r.title}`)
  }
  const drift = cmp.unchanged.filter((u) => u.note)
  if (drift.length) {
    lines.push('')
    lines.push(zh ? '## 仅 LLM 评审漂移（确定性结论未变）' : '## LLM review drift only (deterministic verdict unchanged)')
    for (const u of drift) lines.push(`- **${u.id}** ${u.title} — ${u.note}`)
  }
  if (cmp.onlyInBaseline.length) {
    lines.push('')
    lines.push(zh
      ? `## 仅在基线中出现的用例：${cmp.onlyInBaseline.join(', ')}`
      : `## Only in baseline: ${cmp.onlyInBaseline.join(', ')}`)
  }
  if (cmp.onlyInCandidate.length) {
    lines.push('')
    lines.push(zh
      ? `## 仅在候选中出现的用例：${cmp.onlyInCandidate.join(', ')}`
      : `## Only in candidate: ${cmp.onlyInCandidate.join(', ')}`)
  }
  const compared = cmp.regressions.length + cmp.fixed.length + cmp.unchanged.length
  lines.push('')
  lines.push(zh
    ? `_${cmp.regressions.length} 回归 · ${cmp.fixed.length} 修复 · ${cmp.unchanged.length} 不变（共对比 ${compared} 条）_`
    : `_${cmp.regressions.length} regressed · ${cmp.fixed.length} fixed · ${cmp.unchanged.length} unchanged (${compared} compared)_`)
  lines.push('')
  lines.push(zh
    ? '> 判定只依据确定性断言；LLM 评审的变化只作为漂移列出，不计入回归。'
    : '> The verdict uses deterministic assertions only; LLM review changes are listed as drift and never counted as regressions.')
  return lines.join('\n')
}

/** Newest run id for a suite, excluding an optional one. */
export async function latestRunFor(root, suiteId, excludeRunId) {
  const index = await readIndex(root)
  const rows = index.filter((r) => r.suiteId === suiteId && r.runId !== excludeRunId)
  return rows.length ? rows[rows.length - 1].runId : null
}

/** List distinct stored run ids, newest last. */
export async function listRuns(root) {
  const dir = join(root, 'runs')
  if (!existsSync(dir)) return []
  const entries = await readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name).sort()
}
