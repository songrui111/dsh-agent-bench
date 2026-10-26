// Stored run data turned into text a person can read: run summary, history
// list, duration/percentage formatting. Strings live in STRINGS so adding a
// language is one table. No DSH imports.

/** 12634 -> "12.6s", 92000 -> "1m32s" */
export function formatDuration(ms, lang = 'zh') {
  if (!Number.isFinite(ms) || ms < 0) return '?'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  const rest = Math.round(seconds % 60)
  return lang === 'zh' ? `${minutes}分${String(rest).padStart(2, '0')}秒` : `${minutes}m${String(rest).padStart(2, '0')}s`
}

/** 1 -> "100%", 0.8333 -> "83.3%" */
export function formatPercent(rate) {
  const pct = rate * 100
  return `${Number.isInteger(pct) ? pct : pct.toFixed(1)}%`
}

const STRINGS = {
  zh: {
    verdict: (p, t, pct) => `${p}/${t} 条用例通过（${pct}）`,
    suite: '套件',
    run: '运行',
    review: '评审',
    reviewUnavailable: '评审不可用',
    belowBar: '低于阈值',
    agentNotFinished: 'Agent 未跑完',
    failedNote: (n) => `${n} 条用例未通过 —— 成绩卡里记录了每条用例的全部断言。`,
    noReviewNote: (ids) =>
      `提示：${ids} 没有评审结论 —— 判定不受影响（通过与否只看确定性断言），具体错误在成绩卡里。`,
    next: '下一步：换模型 / 改提示词 / 升级 DSH 之后重跑同一套件，再对比两次运行。',
    scorecardLabel: '成绩卡',
    reportLabel: '可读报告',
    historyTitle: '历史运行',
    latest: '← 最新',
    showing: (n, m) => `（只显示最近 ${n} 条，共 ${m} 条）`,
    empty: '还没有任何基准运行记录。',
  },
  en: {
    verdict: (p, t, pct) => `${p} of ${t} cases passed (${pct})`,
    suite: 'suite',
    run: 'run',
    review: 'review',
    reviewUnavailable: 'review unavailable',
    belowBar: 'below bar',
    agentNotFinished: 'agent did not finish',
    failedNote: (n) => `${n} case(s) failed — the scorecard records every assertion for each one.`,
    noReviewNote: (ids) =>
      `note: no review verdict for ${ids} — marking is unaffected (pass/fail comes from assertions only); the error is in the scorecard.`,
    next: 'Next: change the model/prompt/DSH version, run this suite again, then compare the two runs.',
    scorecardLabel: 'Scorecard',
    reportLabel: 'Readable report',
    historyTitle: 'Stored runs',
    latest: '← latest',
    showing: (n, m) => `(showing the newest ${n} of ${m})`,
    empty: 'No benchmark runs recorded yet.',
  },
}

/** Resolve a language table, falling back to Chinese. */
export function strings(lang = 'zh') {
  return STRINGS[lang] ?? STRINGS.zh
}

function reviewCell(llm, s) {
  if (!llm) return ''
  if (typeof llm.score === 'number') {
    return `${s.review} ${llm.score.toFixed(1)}${llm.approved ? '' : ` (${s.belowBar})`}`
  }
  if (llm.error) return s.reviewUnavailable
  return ''
}

/** First failing assertion, formatted for a one-line explanation. */
function firstFailure(caseResult) {
  const failed = (caseResult.assertions ?? []).filter((a) => !a.passed)
  if (failed.length === 0) return null
  const a = failed[0]
  const target = a.path ? ` ${a.path}` : ''
  const more = failed.length > 1 ? ` (+${failed.length - 1})` : ''
  return `${a.kind}${target}: ${a.detail}${more}`
}

/**
 * Render the result of one suite run.
 *
 * @param {{suiteId:string, runId:string, cases:object[], passed:number, total:number,
 *          passRate:number, scorecardPath?:string, reportPath?:string, durationMs?:number,
 *          language?: 'zh'|'en'}} args
 */
export function renderRunSummary({
  suiteId,
  runId,
  cases,
  passed,
  total,
  passRate,
  scorecardPath,
  reportPath,
  durationMs,
  language = 'zh',
}) {
  const s = strings(language)
  const lines = []
  const icon = passed === total ? '✅' : passed === 0 ? '❌' : '⚠️'
  lines.push(`${icon} ${s.verdict(passed, total, formatPercent(passRate))}`)
  const meta = [`${s.suite} ${suiteId}`, `${s.run} ${runId}`]
  if (Number.isFinite(durationMs) && durationMs > 0) meta.push(formatDuration(durationMs, language))
  lines.push(`   ${meta.join('  ·  ')}`)
  lines.push('')

  const width = Math.max(...cases.map((c) => String(c.id).length), 4)
  for (const c of cases) {
    const mark = c.passed ? '✅' : '❌'
    const name = String(c.id).padEnd(width)
    const time = formatDuration(c.durationMs ?? 0, language).padStart(8)
    const review = reviewCell(c.llm, s)
    lines.push(`   ${mark} ${name} ${time}${review ? `   ${review}` : ''}`)
    if (!c.passed) {
      const why = firstFailure(c)
      if (why) lines.push(`      └ ${why}`)
      else if (c.error) lines.push(`      └ ${s.agentNotFinished}: ${String(c.error).slice(0, 160)}`)
      else if (c.agent && c.agent.ok === false) {
        lines.push(`      └ ${s.agentNotFinished}: ${c.agent.error ?? 'unknown'}`)
      }
    }
  }

  const failed = cases.filter((c) => !c.passed)
  const noReview = cases.filter((c) => c.llm && c.llm.error)
  if (failed.length > 0) {
    lines.push('')
    lines.push(`   ${s.failedNote(failed.length)}`)
  }
  if (noReview.length > 0) {
    lines.push('')
    lines.push(`   ${s.noReviewNote(noReview.map((c) => c.id).join('、'))}`)
  }
  lines.push('')
  lines.push(s.next)
  if (scorecardPath) lines.push(`${s.scorecardLabel}：${scorecardPath}`)
  if (reportPath) lines.push(`${s.reportLabel}：${reportPath}`)
  return lines.join('\n')
}

/** Render the stored-run list. */
export function renderHistoryRows(rows, { limit = 20, language = 'zh' } = {}) {
  const s = strings(language)
  if (!rows.length) return s.empty
  const shown = rows.slice(-limit)
  const lines = shown.map((r, i) => {
    const newest = i === shown.length - 1 ? `  ${s.latest}` : ''
    const when = String(r.finishedAt ?? '').replace('T', ' ').slice(0, 16)
    return `   ${String(r.suiteId).padEnd(10)} ${when}  ${r.passed}/${r.total} (${formatPercent(r.passRate)})  ${r.runId}${newest}`
  })
  if (rows.length > shown.length) lines.unshift(`   ${s.showing(shown.length, rows.length)}`)
  return `${s.historyTitle}：\n${lines.join('\n')}`
}
