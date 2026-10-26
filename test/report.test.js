import { test } from 'node:test'
import assert from 'node:assert/strict'

import { formatDuration, formatPercent, renderRunSummary, renderHistoryRows } from '../lib/report.js'
import { renderRunMarkdown } from '../lib/scorecard.js'

test('formatDuration picks a readable unit per language', () => {
  assert.equal(formatDuration(500), '500ms')
  assert.equal(formatDuration(12634), '12.6s')
  assert.equal(formatDuration(92_000), '1分32秒')
  assert.equal(formatDuration(92_000, 'en'), '1m32s')
  assert.equal(formatDuration(0), '0ms')
  assert.equal(formatDuration(-1), '?')
  assert.equal(formatDuration(Number.NaN), '?')
})

test('formatPercent drops a pointless .0', () => {
  assert.equal(formatPercent(1), '100%')
  assert.equal(formatPercent(0.5), '50%')
  assert.equal(formatPercent(0.8333), '83.3%')
})

const passCase = {
  id: 'fix-bug',
  title: 'Fix the bug',
  passed: true,
  durationMs: 12_600,
  assertions: [{ kind: 'command', passed: true, detail: 'exit 0 (want 0): OK' }],
  llm: { score: 1, approved: true },
}

const failCase = {
  id: 'write-fizzbuzz',
  title: 'Create fizzbuzz',
  passed: false,
  durationMs: 9_100,
  assertions: [
    { kind: 'file-exists', path: 'fizzbuzz.js', passed: false, detail: 'missing' },
    { kind: 'command', passed: false, detail: 'exit 1 (want 0)' },
  ],
  llm: null,
}

test('renderRunSummary defaults to Chinese and lists each case', () => {
  const text = renderRunSummary({
    suiteId: 'core',
    runId: '20260101-abcdef12',
    cases: [passCase, failCase],
    passed: 1,
    total: 2,
    passRate: 0.5,
    durationMs: 21_700,
    scorecardPath: 'C:/ws/.agent-bench/runs/x/core.json',
    reportPath: 'C:/ws/.agent-bench/runs/x/core.md',
  })
  assert.match(text, /1\/2 条用例通过（50%）/)
  assert.match(text, /套件 core/)
  assert.match(text, /21.7s/)
  assert.match(text, /✅ fix-bug/)
  assert.match(text, /❌ write-fizzbuzz/)
  // the failure reason must be visible, and say how many more failed
  assert.match(text, /└ file-exists fizzbuzz\.js: missing \(\+1\)/)
  assert.match(text, /评审 1\.0/)
  assert.match(text, /成绩卡：/)
  assert.match(text, /可读报告：/)
})

test('renderRunSummary can speak English', () => {
  const text = renderRunSummary({
    suiteId: 'core',
    runId: 'r',
    cases: [passCase, failCase],
    passed: 1,
    total: 2,
    passRate: 0.5,
    language: 'en',
  })
  assert.match(text, /1 of 2 cases passed \(50%\)/)
  assert.match(text, /suite core/)
  assert.match(text, /review 1\.0/)
})

test('renderRunSummary says what to do next', () => {
  const text = renderRunSummary({
    suiteId: 's',
    runId: 'r',
    cases: [passCase],
    passed: 1,
    total: 1,
    passRate: 1,
  })
  assert.match(text, /下一步：/)
  assert.match(text, /✅ 1\/1 条用例通过（100%）/)
})

test('renderRunSummary reports an agent that never finished', () => {
  const text = renderRunSummary({
    suiteId: 's',
    runId: 'r',
    cases: [{ id: 'c', title: 't', passed: false, durationMs: 100, assertions: [], agent: { ok: false, error: 'timeout after 1000ms' } }],
    passed: 0,
    total: 1,
    passRate: 0,
  })
  assert.match(text, /Agent 未跑完: timeout/)
})

test('renderRunSummary flags a case whose review never produced a verdict', () => {
  const text = renderRunSummary({
    suiteId: 's',
    runId: 'r',
    cases: [{ ...passCase, llm: { score: null, approved: null, error: 'produced no text after 3 attempts' } }],
    passed: 1,
    total: 1,
    passRate: 1,
  })
  assert.match(text, /评审不可用/)
  assert.match(text, /fix-bug 没有评审结论/)
  assert.match(text, /判定不受影响/)
})

test('renderHistoryRows marks the latest run and handles empty history', () => {
  assert.equal(renderHistoryRows([]), '还没有任何基准运行记录。')
  assert.equal(renderHistoryRows([], { language: 'en' }), 'No benchmark runs recorded yet.')
  const rows = [
    { runId: 'r1', suiteId: 'core', finishedAt: '2026-10-21T03:20:00.000Z', passed: 2, total: 2, passRate: 1 },
    { runId: 'r2', suiteId: 'core', finishedAt: '2026-10-26T01:08:00.000Z', passed: 3, total: 4, passRate: 0.75 },
  ]
  const text = renderHistoryRows(rows)
  assert.match(text, /历史运行：/)
  assert.match(text, /r1/)
  assert.match(text, /3\/4 \(75%\)/)
  assert.match(text, /r2.*← 最新/)
  assert.match(text, /2026-10-26 01:08/)
})

test('renderRunMarkdown is a readable Chinese report by default', () => {
  const card = {
    suiteId: 'core',
    suiteTitle: 'Core',
    runId: 'r1',
    finishedAt: '2026-10-26T01:08:00.000Z',
    environment: { node: 'v24.21.0', platform: 'win32' },
    summary: { total: 2, passed: 1, failed: 1, passRate: 0.5 },
    cases: [
      { ...passCase, llm: { score: 1, approved: true, reason: '循环覆盖到了最后一个元素' } },
      failCase,
    ],
  }
  const md = renderRunMarkdown(card)
  assert.match(md, /^# 基准运行 — core/)
  assert.match(md, /\*\*⚠️ 1 \/ 2 通过（50%）\*\*/)
  assert.match(md, /\| 1 \| fix-bug \| ✅ 通过 \| 12\.6s \| 1\.0 \|/)
  assert.match(md, /\| 2 \| write-fizzbuzz \| ❌ 失败 \|/)
  assert.match(md, /### ✅ fix-bug/)
  assert.match(md, /循环覆盖到了最后一个元素/)
  assert.match(md, /\*\*失败\*\* — file-exists `fizzbuzz\.js`: missing/)
  assert.match(md, /环境：node=v24\.21\.0/)
})

test('renderRunMarkdown can speak English', () => {
  const card = {
    suiteId: 'core',
    suiteTitle: 'Core',
    runId: 'r1',
    finishedAt: '2026-10-26T01:08:00.000Z',
    summary: { total: 1, passed: 1, failed: 0, passRate: 1 },
    cases: [passCase],
  }
  const md = renderRunMarkdown(card, { language: 'en' })
  assert.match(md, /^# Benchmark run — core/)
  assert.match(md, /\| 1 \| fix-bug \| ✅ pass \|/)
})
