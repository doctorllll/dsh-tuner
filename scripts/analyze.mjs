#!/usr/bin/env node
// dsh-tuner P0: measure recent DSH sessions and emit per-module tuning signals.
// Read-only. No model calls. Usage:
//   node scripts/analyze.mjs [--days 14] [--limit 80] [--json out.json]
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const DAYS = Number(opt('days', 14))
const LIMIT = Number(opt('limit', 80))
const OUT = opt('json', '')

const ROOT = join(homedir(), '.dsh', 'sessions')
const since = Date.now() - DAYS * 86400_000

function walkSessions() {
  const out = []
  for (const slug of readdirSync(ROOT)) {
    const slugDir = join(ROOT, slug)
    let ents
    try { ents = readdirSync(slugDir) } catch { continue }
    for (const sid of ents) {
      const file = join(slugDir, sid, 'session.v4.jsonl.zstd')
      try {
        const st = statSync(file)
        if (st.mtimeMs >= since) out.push({ file, mtime: st.mtimeMs })
      } catch {}
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, LIMIT)
}

const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const sum = a => a.reduce((x, y) => x + y, 0)
const fmt = n => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n)))

function readEvents(file) {
  const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 256 * 1024 * 1024 })
  const events = []
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch {}
  }
  return events
}

const jsonTokens = v => Math.ceil(JSON.stringify(v ?? {}).length / 4)

function analyzeSession(events) {
  const meta = { requests: [], compactions: [], toolsTokens: 0, model: '', ctx: 0, effort: '' }
  const firstHeader = events.find(e => e.type === 'request/header')
  if (firstHeader?.data?.header) {
    const h = firstHeader.data.header
    meta.model = h.config?.model ?? ''
    meta.effort = h.config?.reasoningEffort ?? ''
    meta.toolsTokens = sum((h.tools ?? []).map(jsonTokens))
  }
  const ctxEvent = events.find(e => e.type === 'request/context')
  meta.ctx = ctxEvent?.data?.contextWindow ?? 0

  for (const e of events) {
    if (e.type === 'assistant/message') {
      const u = e.data?.usage ?? e.data?.message?.usage
      if (!u) continue
      const uncached = u.inputTokens ?? 0
      const cacheRead = u.cacheReadTokens ?? 0
      const cacheWrite = u.cacheWriteTokens ?? 0
      const output = u.outputTokens ?? 0
      const prompt = uncached + cacheRead + cacheWrite
      if (prompt <= 0 && output <= 0) continue
      meta.requests.push({ t: e.time, prompt, uncached, cacheRead, cacheWrite, output })
    } else if (e.type === 'compaction/summary' || e.type === 'compaction/prune') {
      meta.compactions.push({ t: e.time, tok: e.data?.shadowedTokenCount ?? 0, kind: e.type })
    }
  }
  meta.requests.sort((a, b) => a.t - b.t)
  return meta
}

// Counterfactual: fire compaction whenever the simulated context would exceed T.
// Assumptions (labelled in output): growth between requests = observed prompt delta;
// after compaction the context collapses to retain*T verbatim + 3k summary.
function simulate(reqs, T, retain = 0.16, summary = 3000) {
  if (!reqs.length) return null
  let s = reqs[0].prompt
  let cost = 0, peak = 0, comps = 0
  for (let i = 0; i < reqs.length; i++) {
    if (i > 0) s += Math.max(0, reqs[i].prompt - reqs[i - 1].prompt)
    if (s > T) { comps++; s = Math.min(s, retain * T + summary) }
    cost += s
    peak = Math.max(peak, s)
  }
  return { comps, cost, peak }
}

const sessions = walkSessions()
const all = []
for (const s of sessions) {
  try {
    const ev = readEvents(s.file)
    const a = analyzeSession(ev)
    if (a.requests.length) all.push({ ...a, file: s.file })
  } catch (err) {
    // unreadable/corrupt logs are skipped, never fatal
  }
}

const reqs = all.flatMap(s => s.requests)
const models = {}
for (const s of all) {
  const k = s.model || 'unknown'
  models[k] ??= { requests: 0, ctx: s.ctx, effort: s.effort, prompt: [], cacheRead: 0, uncached: 0, write: 0, output: 0 }
  const m = models[k]
  m.requests += s.requests.length
  for (const r of s.requests) {
    m.prompt.push(r.prompt); m.cacheRead += r.cacheRead; m.uncached += r.uncached
    m.write += r.cacheWrite; m.output += r.output
  }
  if (!m.ctx && s.ctx) m.ctx = s.ctx
}

const gaps = []
for (const s of all) for (let i = 1; i < s.requests.length; i++) gaps.push(s.requests[i].t - s.requests[i - 1].t)
const gapP = p => pct(gaps, p) / 1000
const gapShare = ms => gaps.length ? Math.round((gaps.filter(g => g > ms).length / gaps.length) * 100) : 0

const totalPrompt = sum(reqs.map(r => r.prompt))
const totalCacheRead = sum(reqs.map(r => r.cacheRead))
const totalUncached = sum(reqs.map(r => r.uncached))
const totalWrite = sum(reqs.map(r => r.cacheWrite))
const totalOutput = sum(reqs.map(r => r.output))
const comps = all.flatMap(s => s.compactions)

const report = {
  window: { days: DAYS, sessions: all.length, requests: reqs.length, gaps: gaps.length },
  tokens: { prompt: totalPrompt, cacheRead: totalCacheRead, uncached: totalUncached, cacheWrite: totalWrite, output: totalOutput },
  models: Object.fromEntries(Object.entries(models).map(([k, m]) => [k, {
    requests: m.requests, contextWindow: m.ctx, effort: m.effort,
    p50: pct(m.prompt, 50), p90: pct(m.prompt, 90), max: Math.max(0, ...m.prompt),
    p90PctOfWindow: m.ctx ? Math.round((pct(m.prompt, 90) / m.ctx) * 1000) / 10 : null,
    maxPctOfWindow: m.ctx ? Math.round((Math.max(...m.prompt) / m.ctx) * 1000) / 10 : null,
    cacheReadShare: m.requests ? Math.round((m.cacheRead / (m.cacheRead + m.uncached + m.write || 1)) * 100) : null,
  }])),
  cache: {
    cacheReadShare: Math.round((totalCacheRead / (totalCacheRead + totalUncached + totalWrite || 1)) * 100),
    gapP50s: Math.round(gapP(50)), gapP90s: Math.round(gapP(90)), gapMaxs: Math.round((gaps.length ? Math.max(...gaps) : 0) / 1000),
    shareGapOver5min: gapShare(300_000),
    shareGapOver1h: gapShare(3_600_000),
  },
  compaction: {
    events: comps.length,
    shadowedTokens: sum(comps.map(c => c.tok)),
    perSession: all.length ? Math.round((comps.length / all.length) * 10) / 10 : 0,
  },
  tools: {
    medianToolsTokens: pct(all.map(s => s.toolsTokens), 50),
    shareOfPrompt: totalPrompt ? Math.round((pct(all.map(s => s.toolsTokens), 50) / pct(reqs.map(r => r.prompt), 50)) * 100) : null,
  },
}

// Threshold sweep, aggregated across sessions of the dominant model envelope.
const sweeps = []
if (all.length) {
  const baseline = sum(all.map(s => simulate(s.requests, 1e12)?.cost ?? 0))
  for (const ratio of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    let cost = 0, compsN = 0, peak = 0
    for (const s of all) {
      const T = (s.ctx || 1_000_000) * ratio
      const r = simulate(s.requests, T)
      if (!r) continue
      cost += r.cost; compsN += r.comps; peak = Math.max(peak, r.peak)
    }
    sweeps.push({
      ratio, triggerTokens: Math.round(ratio * 1000) / 1000,
      compactions: compsN,
      promptCostRatio: baseline ? Math.round((cost / baseline) * 1000) / 1000 : null,
      peakPrompt: peak,
    })
  }
  report.sweep = sweeps
}

const lines = []
lines.push(`# dsh-tuner 观测（近 ${DAYS} 天，${report.window.sessions} 会话 / ${report.window.requests} 请求）`)
lines.push('')
lines.push(`总 prompt ${fmt(totalPrompt)}（cacheRead ${fmt(totalCacheRead)} / uncached ${fmt(totalUncached)} / write ${fmt(totalWrite)}），输出 ${fmt(totalOutput)}`)
lines.push(`缓存命中占比 ${report.cache.cacheReadShare}% · 请求间隔 p50 ${report.cache.gapP50s}s / p90 ${report.cache.gapP90s}s / 最大 ${report.cache.gapMaxs}s · >5min 占 ${report.cache.shareGapOver5min}%`)
lines.push(`压缩 ${report.compaction.events} 次（${report.compaction.perSession}/会话），被压缩 ${fmt(report.compaction.shadowedTokens)} tokens`)
lines.push(`工具 schema 中位 ${fmt(report.tools.medianToolsTokens)} tokens ≈ 单请求 p50 的 ${report.tools.shareOfPrompt}%`)
lines.push('')
lines.push('| 模型 | 请求 | 窗口 | effort | prompt p50 | p90 | max | p90/窗口 | 峰值/窗口 | cacheRead |')
lines.push('|---|---|---|---|---|---|---|---|---|---|')
for (const [k, v] of Object.entries(report.models)) {
  lines.push(`| ${k} | ${v.requests} | ${v.contextWindow ? fmt(v.contextWindow) : '?'} | ${v.effort || '-'} | ${fmt(v.p50)} | ${fmt(v.p90)} | ${fmt(v.max)} | ${v.p90PctOfWindow ?? '?'}% | ${v.maxPctOfWindow ?? '?'}% | ${v.cacheReadShare ?? '?'}% |`)
}
lines.push('')
lines.push('## 阈值回放（估算，增长=实测 delta；压缩后=0.16T+3k 摘要）')
lines.push('| 触发比例 | 压缩次数 | prompt 成本/现状 | 单请求峰值 |')
lines.push('|---|---|---|---|')
for (const s of sweeps) lines.push(`| ${Math.round(s.ratio * 100)}% | ${s.compactions} | ${s.promptCostRatio}× | ${fmt(s.peakPrompt)} |`)

console.log(lines.join('\n'))
if (OUT) { writeFileSync(OUT, JSON.stringify(report, null, 2)); console.error(`\njson -> ${OUT}`) }