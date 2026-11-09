/**
 * dsh-tuner — Host half.
 *
 * Reads your real DSH sessions (via ctx.sessionQuery), measures per-module usage,
 * and exposes a report over /api/dsh-tuner/report.
 *
 * v0.2 adds a write path for the compaction card: it edits the ACTIVE agent
 * preset's compaction-basic row through ctx.configEditor, which writes the
 * profile patch, validates the candidate, reconciles the Loader, and restores
 * the previous document by itself when reconciliation fails. We additionally
 * read the value back after the edit and roll back if it did not land.
 *
 * Only NEW sessions pick up a changed preset definition; sessions already
 * open keep the revision they started with.
 *
 * v0.3: the profile patch replaces a preset's config wholesale, so a stored
 * copy freezes the plugin list of the DSH version it was written under (DSH
 * 0.2.2-rc.1 dropped a row the 0.2.1 copy still named, and every session of
 * that preset failed to start). Every write is now rebuilt on the preset's
 * INHERITED config, carrying over only the compaction-basic row, and on
 * startup each preset override is rebased the same way.
 *
 * v0.5.1: that rebuild also threw away every other change the user had made
 * to the preset (a row disabled, a tool configured, the prompt edited). A
 * preset is now rebuilt only when it names rows the running DSH no longer
 * ships, and then the user's own rows are kept; otherwise writes edit the
 * stored preset in place and touch only compaction-basic.
 */
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-tuner'

const DAY = 86400_000
const CACHE_MS = 5 * 60_000
const PRESET_PLUGIN = '@deepseek-ai/dsh-agent-preset'
const COMPACTION_PLUGIN = '@deepseek-ai/dsh-compaction-basic'

// compaction-basic defaults (packages/compaction/compaction-basic): a missing
// key means the default is in force, not "zero".
const DEFAULTS = { thresholdRatio: 0.8, headroomTokens: 65536, retainRatio: 0.16 }
// maxTokens defaults to headroomTokens in compaction-basic; headroom 0 would
// therefore resolve to maxTokens 0 and fail validation, so an explicit
// positive maxTokens has to be written alongside headroom 0.
const FALLBACK_MAX_TOKENS = 65536

const sum = a => a.reduce((x, y) => x + y, 0)
const pct = (arr, p) => {
  if (!arr.length) return 0
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}
const jsonTokens = v => Math.ceil(JSON.stringify(v ?? {}).length / 4)
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d)

function readEvents(view) {
  const events = []
  for (const e of view.events ?? []) {
    if (e && typeof e.type === 'string' && typeof e.time === 'number') events.push(e)
  }
  if (events.length === 0 && Array.isArray(view.log)) return readEvents({ events: view.log })
  return events
}

function modelKey(provider, model) {
  return `${provider ?? ''}/${model}`
}

// One pass over a session's events. Requests carry the routed provider/model
// they were sent to (sessions switch models mid-way), and every compaction run
// keeps its start/end, failure, the prompt right before it and the first prompt
// after it — the "post" size is what the replay below calls the floor.
export function analyzeSession(view, header) {
  const events = readEvents(view)
  const s = {
    id: header?.id ?? view.header?.id,
    cwd: header?.cwd ?? view.header?.cwd,
    createdAt: header?.createdAt ?? view.header?.createdAt ?? 0,
    parent: header?.parentSession ?? null,
    requests: [],
    compactions: [],
    turns: [],
    toolsTokens: 0,
    ctx: 0,
    maxTokens: 0,
    model: '',
    provider: '',
    effort: '',
    toolCalls: {},
    retries: [],
    tools: [],
    hooks: [],
  }
  let cur = null
  const windows = {}
  const open = new Map()
  let waiting = []
  let lastPrompt = 0
  let turn = null
  let mark = 0                       // step start, or the last retry restart
  const callNames = new Map()
  for (const e of events) {
    const d = e.data ?? {}
    if (e.type === 'step/start' || e.type === 'llm/retry-started') {
      mark = e.time
    } else if (e.type === 'request/header') {
      const h = d.header
      if (!h) continue
      const c = h.config ?? {}
      if (c.model) cur = { key: modelKey(c.provider, c.model), provider: c.provider ?? '', model: c.model, reserved: Number(c.maxTokens) || 0, effort: c.reasoningEffort ?? '' }
      if (!s.model && c.model) { s.model = c.model; s.provider = c.provider ?? ''; s.effort = c.reasoningEffort ?? '' }
      const mt = Number(c.maxTokens)
      if (Number.isFinite(mt) && mt > s.maxTokens) s.maxTokens = mt
      const tok = sum((h.tools ?? []).map(jsonTokens))
      if (tok > s.toolsTokens) s.toolsTokens = tok
    } else if (e.type === 'request/context') {
      const w = d.contextWindow
      if (typeof w === 'number' && w > 0) {
        if (w > s.ctx) s.ctx = w
        if (d.model) windows[modelKey(d.provider ?? cur?.provider, d.model)] = w
        else if (cur) windows[cur.key] = w
      }
      if (!s.model && d.model) s.model = d.model
    } else if (e.type === 'assistant/message') {
      const u = d.usage
      if (!u) continue
      const uncached = Number(u.inputTokens) || 0
      const cacheRead = Number(u.cacheReadTokens) || 0
      const cacheWrite = Number(u.cacheWriteTokens) || 0
      const output = Number(u.outputTokens) || 0
      const prompt = uncached + cacheRead + cacheWrite
      if (prompt <= 0 && output <= 0) continue
      const src = d.message?.source
      const provider = src?.model ? (src.provider ?? '') : (cur?.provider ?? '')
      const model = src?.model ?? cur?.model ?? ''
      const key = model ? modelKey(provider, model) : ''
      s.requests.push({
        t: e.time, prompt, uncached, cacheRead, cacheWrite, output,
        key, provider, model, reserved: cur && cur.key === key ? cur.reserved : 0,
        effort: cur && cur.key === key ? cur.effort : '', ms: mark ? Math.max(0, e.time - mark) : 0,
      })
      for (const run of waiting) run.post = prompt
      waiting = []
      lastPrompt = prompt
      if (turn && key) turn.key = key
    } else if (e.type === 'compaction/start') {
      const run = {
        id: d.compactionId, start: e.time, end: null, error: false, errorText: '', key: cur?.key ?? '', turn: d.turn,
        pre: lastPrompt, post: null, shadowed: 0, summaryOut: 0, sumModel: '', manual: Boolean(d.sourceCommandId),
      }
      open.set(d.compactionId, run)
      s.compactions.push(run)
    } else if (e.type === 'compaction/end') {
      const run = open.get(d.compactionId)
      if (!run) continue
      open.delete(d.compactionId)
      run.end = e.time
      run.error = Boolean(d.error)
      run.errorText = d.error ? errorText(d.error) : ''
      waiting.push(run)
    } else if (e.type === 'compaction/summary') {
      const run = open.get(d.compactionId) ?? s.compactions.find(r => r.id === d.compactionId)
      if (!run) continue
      run.shadowed += Number(d.shadowedTokenCount) || 0
      run.summaryOut += Number(d.usage?.outputTokens) || 0
      if (d.model) run.sumModel = modelKey(d.provider, d.model)
    } else if (e.type === 'llm/retry') {
      s.retries.push({
        id: d.retryId ?? `${s.id}:${e.time}`, t: e.time, key: cur?.key ?? '', effort: cur?.effort ?? '',
        kind: retryKind(d.failure), waitedMs: mark ? Math.min(15 * 60_000, Math.max(0, e.time - mark)) : 0,
      })
    } else if (e.type === 'turn/start') {
      turn = { start: e.time, end: null, key: cur?.key ?? '' }
      s.turns.push(turn)
    } else if (e.type === 'turn/end') {
      if (turn) { turn.end = e.time; turn = null }
    } else if (e.type === 'tool/call') {
      const n = d.name
      if (typeof n === 'string') s.toolCalls[n] = (s.toolCalls[n] ?? 0) + 1
      if (d.callId) callNames.set(d.callId, n)
    } else if (e.type === 'tool/result') {
      const m = d.message ?? {}
      const id = m.toolCallId ?? m.source?.callId ?? ''
      const code = d.error?.code ?? ''
      s.tools.push({ id, name: callNames.get(id) ?? '?', chars: contentChars(m.content), code, kind: failKind(code, m.content) })
    } else if (e.type === 'tool/ptc-dispatch') {
      // Calls made from inside run_code: in PTC mode most of the real work.
      const code = d.isError ? (d.error?.code || 'ERROR') : ''
      s.tools.push({ id: d.subCallId ?? '', name: d.name ?? '?', chars: contentChars(d.content), code, kind: code, inner: true })
    } else if (e.type === 'hook/result') {
      s.hooks.push({ k: `${e.time}:${d.handlerId}`, ms: Number(d.durationMs) || 0, point: d.point ?? '' })
    }
  }
  for (const r of s.requests) r.window = windows[r.key] || s.ctx
  s.requests.sort((a, b) => a.t - b.t)
  return s
}

function errorText(err) {
  if (typeof err === 'string') return err
  if (Array.isArray(err)) return err.map(errorText).join(' ← ')
  if (err && typeof err === 'object') return String(err.message ?? err.code ?? JSON.stringify(err))
  return String(err)
}

function contentChars(content) {
  if (typeof content === 'string') return content.length
  if (Array.isArray(content)) return sum(content.map(c => (typeof c?.text === 'string' ? c.text.length : c?.type === 'text' ? 0 : 200)))
  return content == null ? 0 : JSON.stringify(content).length
}

function contentText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(c => (typeof c?.text === 'string' ? c.text : '')).join('\n')
  return ''
}

// run_code reports every failure as CODE_RUN_FAILED; the text says which.
function failKind(code, content) {
  if (code !== 'CODE_RUN_FAILED') return code
  const t = contentText(content).slice(0, 4000)
  if (/deadline reached/i.test(t)) return 'deadline'
  if (/ToolCallError/.test(t)) return 'inner-tool'
  if (/SyntaxError|ReferenceError|TypeError/.test(t)) return 'code-bug'
  return 'other'
}

export function retryKind(f) {
  const msg = String(f?.message ?? '')
  const code = String(f?.code ?? '')
  if (/idle timeout/i.test(msg)) return 'idle'
  if (/response headers/i.test(msg)) return 'headers'
  if (code === 'TRANSPORT' || /ECONNRESET|socket|network/i.test(msg)) return 'reset'
  if (code === 'RATE_LIMIT' || /\b429\b|rate limit/i.test(msg)) return 'rate'
  if (code === 'SERVER' || /\b5\d\d\b|server_error/i.test(msg)) return 'server'
  if (code === 'EMPTY_RESPONSE') return 'empty'
  if (code === 'TIMEOUT') return 'timeout'
  return 'other'
}

// ---------------------------------------------------------------------------
// Compaction tuning, per routed model.
//
// compaction-basic (0.2.2) fires when the estimated context reaches
//   T = floor(min(W·ratio, W − R − headroom))       W window, R reserved output
// and keeps retain = floor((W − R)·retainRatio) verbatim. What it can NOT get
// rid of — system prompt, tools, the current turn's own tool results — sits on
// top of retain, so a compaction lands at "post = retain + D", D measured from
// the first request after every observed compaction. If post is close to T the
// next steps compact again (a 500k Grok route at 30% landed at ~150k against a
// 150k trigger: 44 runs, 17 failures, 18% of the session's time).
// ---------------------------------------------------------------------------

// Cached prompt tokens priced at about a tenth of a miss (DeepSeek-style).
// Only ranks thresholds against each other; it is not a bill.
const HIT_WEIGHT = 0.1
const RATIOS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
// What a tuned model gets besides its ratio: retain 12%, a small headroom that
// only covers the 4-chars-per-token estimate, and an explicit summary budget
// (maxTokens otherwise inherits headroom, and 8192 would cut long summaries).
const TUNED = { retainRatio: 0.12, headroomTokens: 8192, maxTokens: FALLBACK_MAX_TOKENS }
// The keys the strategy card owns inside a model policy; anything else a user
// adds there (a summarization model, retries) is carried over on write.
const TUNED_KEYS = ['provider', 'model', 'thresholdRatio', 'retainRatio', 'retainTokens', 'headroomTokens', 'maxTokens']
const tunedPart = p => Object.fromEntries(TUNED_KEYS.filter(k => p?.[k] !== undefined).map(k => [k, p[k]]))
const FAIL_TEXT = {
  deadline: '超时', 'inner-tool': '内部工具出错', 'code-bug': '代码错误', other: '其他',
  FS_NOT_OBSERVED: '没先读', FS_STALE_VERSION: '文件已变', FS_NOT_FOUND: '文件不存在',
  ABORTED: '被中止', ABORTED_BEFORE_DISPATCH: '被中止', ERROR: '出错', WEB_PROVIDER_ERROR: '网页源出错', TOOL_TIMEOUT: '超时',
}
const POST_CEILING = 0.7      // after compacting, context must sit at ≤70% of the trigger
const MAX_TIME_SHARE = 0.05   // compaction may take at most 5% of the model's working time
const NEAR_BEST = 1.03        // within 3% of the cheapest, prefer the higher (calmer) ratio
const DEFAULT_COMPACTION_MS = 45_000
const MIN_REQUESTS = 20

function policyFor(config, provider, model) {
  const c = config && typeof config === 'object' ? config : {}
  const o = Array.isArray(c.modelPolicies) ? c.modelPolicies.find(p => p?.provider === provider && p?.model === model) : null
  const pick = k => (o && o[k] !== undefined ? o[k] : c[k])
  const retainTokens = o ? (o.retainTokens ?? (o.retainRatio === undefined ? c.retainTokens : undefined)) : c.retainTokens
  return {
    explicit: Boolean(o),
    thresholdRatio: num(pick('thresholdRatio'), DEFAULTS.thresholdRatio),
    headroomTokens: num(pick('headroomTokens'), DEFAULTS.headroomTokens),
    retainRatio: num(pick('retainRatio'), DEFAULTS.retainRatio),
    retainTokens: typeof retainTokens === 'number' ? retainTokens : null,
  }
}

function spec(policy, W, R) {
  const budget = W - R
  const T = Math.floor(Math.min(W * policy.thresholdRatio, budget - policy.headroomTokens))
  const retain = policy.retainTokens ?? Math.floor(budget * policy.retainRatio)
  return { T, retain, valid: budget > 0 && T > 0 && retain < T }
}

// Replay one model's request runs against a trigger T and a post-compaction
// size. Growth between requests is the observed prompt delta; the first request
// after a compaction is a full miss, later ones hit the cached prefix.
function replay(segments, T, post) {
  let cost = 0, comps = 0, peak = 0
  for (const seg of segments) {
    const rs = seg.reqs
    if (!rs.length) continue
    let size = rs[0].prompt
    let fresh = true
    for (let i = 0; i < rs.length; i++) {
      const delta = i ? Math.max(0, rs[i].prompt - rs[i - 1].prompt) : 0
      size += delta
      if (size > T) {
        comps++
        cost += size * HIT_WEIGHT            // the summarization request reads the context once
        size = Math.min(size, post)
        fresh = true
      }
      cost += fresh ? size : (size - delta) * HIT_WEIGHT + delta
      fresh = false
      peak = Math.max(peak, size)
    }
  }
  return { cost, comps, peak }
}

function shortModel(m) {
  return m.model.replace(/^auto\//, '')
}

// A forked session ("… (1)") carries its parent's history verbatim, so the same
// requests, turns and compaction runs show up twice; count each one once.
function collectModels(sessions) {
  const by = new Map()
  const seenReq = new Set(), seenRun = new Set(), seenTurn = new Set()
  const get = (key, provider, model) => {
    let m = by.get(key)
    if (!m) {
      m = { key, provider, model, W: 0, R: 0, requests: 0, sessions: new Set(), prompts: [], segments: [], runs: [], turnMs: 0, turns: [], reqs: [], retries: [], bases: new Map() }
      by.set(key, m)
    }
    return m
  }
  for (const s of sessions) {
    let seg = null
    // The conversation's opening request (system + tools + first message),
    // whichever model sent it. A model switched in mid-way, or a fork, starts
    // its own run on a prompt that already holds the conversation so far.
    // Forks copy the parent's opening request, so it is keyed like one.
    const first = s.requests[0]
    const baseId = first ? `${first.t}:${first.prompt}:${first.key}` : ''
    for (const r of s.requests) {
      if (!r.key) continue
      const rk = `${r.t}:${r.prompt}:${r.key}`
      if (seenReq.has(rk)) continue
      seenReq.add(rk)
      const m = get(r.key, r.provider, r.model)
      if (first) m.bases.set(baseId, first.prompt)
      if (!seg || seg.key !== r.key) { seg = { key: r.key, reqs: [] }; m.segments.push(seg) }
      seg.reqs.push(r)
      m.reqs.push(r)
      m.requests++
      m.sessions.add(s.id)
      m.prompts.push(r.prompt)
      if (r.window > m.W) m.W = r.window
      if (r.reserved > m.R) m.R = r.reserved
    }
    for (const c of s.compactions) {
      const id = c.id ?? `${s.id}:${c.start}`
      if (seenRun.has(id)) continue
      seenRun.add(id)
      const m = c.key && by.get(c.key)
      if (m) m.runs.push({ ...c, session: s.id })
    }
    for (const t of s.turns) {
      const tk = `${t.start}:${t.key}`
      if (seenTurn.has(tk)) continue
      seenTurn.add(tk)
      const m = t.end && t.key && by.get(t.key)
      if (m) { m.turnMs += t.end - t.start; m.turns.push(t) }
    }
  }
  const seenRetry = new Set()
  for (const s of sessions) {
    for (const r of s.retries) {
      if (seenRetry.has(r.id)) continue
      seenRetry.add(r.id)
      const m = r.key && by.get(r.key)
      if (m) m.retries.push(r)
    }
  }
  return [...by.values()].sort((a, b) => b.requests - a.requests)
}

// Tool results and hook runs across sessions, each counted once (forks repeat
// their parent's events with the same ids).
function collectUsage(sessions) {
  const tools = new Map()
  const seenTool = new Set(), seenHook = new Set()
  let hookRuns = 0, hookMs = 0
  const hookMsList = []
  for (const s of sessions) {
    for (const t of s.tools) {
      if (t.id) {
        if (seenTool.has(t.id)) continue
        seenTool.add(t.id)
      }
      let x = tools.get(t.name)
      if (!x) { x = { name: t.name, calls: 0, inner: 0, errors: 0, kinds: {}, chars: [] }; tools.set(t.name, x) }
      x.calls++
      if (t.inner) x.inner++
      if (t.code) { x.errors++; x.kinds[t.kind || t.code] = (x.kinds[t.kind || t.code] ?? 0) + 1 }
      x.chars.push(t.chars)
    }
    for (const hk of s.hooks) {
      if (seenHook.has(hk.k)) continue
      seenHook.add(hk.k)
      hookRuns++
      hookMs += hk.ms
      hookMsList.push(hk.ms)
    }
  }
  return { tools: [...tools.values()].sort((a, b) => b.calls - a.calls), hookRuns, hookMs, hookP50: pct(hookMsList, 50) }
}

function healthOf(runs, turnMs) {
  const done = runs.filter(r => r.end)
  const errors = done.filter(r => r.error).length
  const durs = done.map(r => r.end - r.start)
  const compMs = sum(durs)
  const shadowed = sum(runs.map(r => r.shadowed))
  const summaryOut = sum(runs.map(r => r.summaryOut))
  const perTurn = {}
  for (const r of runs) { const k = `${r.session}:${r.turn}`; perTurn[k] = (perTurn[k] ?? 0) + 1 }
  const thrashTurns = Object.values(perTurn).filter(n => n >= 3).length
  const errRate = done.length ? errors / done.length : 0
  const timeShare = turnMs ? Math.min(1, compMs / turnMs) : 0
  const sumRatio = shadowed ? summaryOut / shadowed : 0
  const bad = (errors >= 3 && errRate >= 0.2) || timeShare >= 0.1 || thrashTurns >= 1 || (runs.length >= 3 && sumRatio >= 0.5)
  const warn = !bad && (timeShare >= 0.05 || errors > 0)
  return {
    runs: runs.length, errors, errRate, durP50: durs.length ? pct(durs, 50) : 0, compMs, timeShare,
    shadowed, summaryOut, sumRatio, thrashTurns, status: bad ? 'bad' : warn ? 'warn' : 'ok',
  }
}

function tuneModel(m, config) {
  const label = shortModel(m)
  const out = { key: m.key, provider: m.provider, model: m.model, label, W: m.W, R: m.R, requests: m.requests, sessions: m.sessions.size }
  out.peak = m.prompts.length ? Math.max(...m.prompts) : 0
  out.health = healthOf(m.runs, m.turnMs)
  out.runs = m.runs
  out.turns = m.turns
  out.reqs = m.reqs
  out.retries = m.retries
  const pol = policyFor(config, m.provider, m.model)
  out.current = { ...pol, ...(m.W ? spec(pol, m.W, m.R) : {}) }
  if (!m.W) return { ...out, verdict: 'unknown', why: '会话里没有这个模型的上下文窗口，没法算' }
  if (m.requests < MIN_REQUESTS) return { ...out, verdict: 'insufficient', why: `只有 ${m.requests} 次请求，样本不够` }

  // Floor above retain, from compactions that went through (a failed run
  // leaves the context where it was and says nothing about the floor); without
  // two of them, assume the opening request of the conversations the model ran
  // in (system + tools) plus an 8k summary — not the model's own first request,
  // which after a mid-session switch already carries the conversation (GLM
  // taken over at 179k was estimated at a 187k floor). Median: one compaction
  // forced late in a huge turn should not set the floor for every ordinary one.
  const samples = m.runs.filter(r => !r.error && typeof r.post === 'number').map(r => Math.max(0, r.post - out.current.retain))
  const D = samples.length >= 2
    ? pct(samples, 50)
    : pct([...m.bases.values()], 50) + 8000
  out.floor = { D, samples: samples.length, source: samples.length >= 2 ? 'observed' : 'estimated' }
  const durMs = out.health.durP50 || DEFAULT_COMPACTION_MS
  const workMs = Math.max(1, m.turnMs - out.health.compMs)

  const base = replay(m.segments, out.current.T, out.current.retain + D)
  out.sweep = RATIOS.map(ratio => {
    const sp = spec({ ...TUNED, thresholdRatio: ratio, retainTokens: null }, m.W, m.R)
    const post = sp.retain + D
    const r = replay(m.segments, sp.T, post)
    const compMs = r.comps * durMs
    const share = compMs / (workMs + compMs)
    const thrash = post > POST_CEILING * sp.T
    const reasons = []
    if (!sp.valid) reasons.push('配置无效')
    if (thrash) reasons.push(`压缩后约 ${fmt(post)}，超过阈值 70%，会反复压`)
    if (share > MAX_TIME_SHARE) reasons.push(`压缩耗时约占 ${Math.round(share * 100)}%`)
    return {
      ratio, T: sp.T, post, comps: r.comps, peak: r.peak, timeShare: share,
      costRatio: base.cost ? Math.round((r.cost / base.cost) * 1000) / 1000 : null,
      cost: r.cost, eligible: sp.valid && !thrash && share <= MAX_TIME_SHARE, reasons,
    }
  })
  const T30 = out.sweep[0]?.T ?? Infinity
  if (out.peak < T30) {
    return { ...out, verdict: 'irrelevant', why: `峰值 ${fmt(out.peak)} 没到过 30% 阈值 ${fmt(T30)}，阈值设多少都不触发，走默认即可` }
  }
  const ok = out.sweep.filter(r => r.eligible)
  if (!ok.length) {
    return { ...out, verdict: 'no-safe', why: '每档都会反复压或太费时间，不单独设，走官方默认（80%）' }
  }
  const best = Math.min(...ok.map(r => r.cost))
  const chosen = ok.filter(r => r.cost <= best * NEAR_BEST).sort((a, b) => b.ratio - a.ratio)[0]
  out.chosen = chosen
  out.policy = { provider: m.provider, model: m.model, thresholdRatio: chosen.ratio, ...TUNED }
  out.applied = pol.explicit && pol.thresholdRatio === chosen.ratio && pol.retainRatio === TUNED.retainRatio &&
    pol.headroomTokens === TUNED.headroomTokens && pol.retainTokens === null
  const cut = out.sweep.find(r => !r.eligible && r.ratio < chosen.ratio)
  out.why = `${Math.round(chosen.ratio * 100)}%：压缩后约 ${fmt(chosen.post)}（阈值 ${fmt(chosen.T)} 的 ${Math.round((chosen.post / chosen.T) * 100)}%），` +
    `回放 ${chosen.comps} 次压缩、成本 ${chosen.costRatio}× 现状` + (cut ? `；更低的档${cut.reasons.join('、')}` : '')
  return { ...out, verdict: 'tune' }
}

export function buildReport(sessions, days, opts = {}) {
  const config = opts.policy
  const requests = sessions.flatMap(s => s.requests)
  const dominant = sessions.slice().sort((a, b) => b.requests.length - a.requests.length)[0]
  const promptP50 = pct(requests.map(r => r.prompt), 50)
  const cacheRead = sum(requests.map(r => r.cacheRead))
  const uncached = sum(requests.map(r => r.uncached))
  const cacheWrite = sum(requests.map(r => r.cacheWrite))
  const output = sum(requests.map(r => r.output))
  const cacheShare = cacheRead + uncached + cacheWrite > 0
    ? Math.round((cacheRead / (cacheRead + uncached + cacheWrite)) * 100) : null

  const gaps = []
  for (const s of sessions) for (let i = 1; i < s.requests.length; i++) gaps.push(s.requests[i].t - s.requests[i - 1].t)
  const gapP50 = pct(gaps, 50), gapP90 = pct(gaps, 90)
  const over5 = gaps.length ? Math.round((gaps.filter(g => g > 300_000).length / gaps.length) * 100) : 0
  const toolsTokens = pct(sessions.map(s => s.toolsTokens), 50)
  const toolTotals = {}
  for (const s of sessions) for (const [k, v] of Object.entries(s.toolCalls)) toolTotals[k] = (toolTotals[k] ?? 0) + v
  const topTools = Object.entries(toolTotals).sort((a, b) => b[1] - a[1]).slice(0, 8)

  const models = collectModels(sessions).map(m => tuneModel(m, config))
  const tuned = models.filter(x => x.verdict === 'tune')
  const policies = tuned.map(x => x.policy)
  const topLevelOverride = config && ['thresholdRatio', 'headroomTokens', 'retainRatio', 'retainTokens'].some(k => config[k] !== undefined)
  const currentPolicies = Array.isArray(config?.modelPolicies) ? config.modelPolicies : []
  const byKey = (a, b) => modelKey(a.provider, a.model).localeCompare(modelKey(b.provider, b.model))
  const applied = !topLevelOverride && stable(currentPolicies.map(tunedPart).sort(byKey)) === stable(policies.map(tunedPart).sort(byKey))
  const pctTxt = r => `${Math.round(r * 100)}%`
  const verdictTxt = { tune: '单独设', irrelevant: '不触发', 'no-safe': '走默认', insufficient: '样本少', unknown: '未知' }

  const modules = []
  const pct1 = v => `${Math.round(v * 1000) / 10}%`
  const secs = ms => (ms >= 90_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`)
  const TONE_ORDER = { do: 0, info: 1, ok: 2 }
  const byTone = list => list.slice().sort((a, b) => TONE_ORDER[a.tone] - TONE_ORDER[b.tone])

  // 1) compaction
  modules.push({
    id: 'compaction',
    title: '压缩策略',
    scope: '按模型',
    status: applied ? 'ok' : 'warn',
    headline: tuned.length
      ? tuned.map(x => `${x.label} ${pctTxt(x.chosen.ratio)}${x.applied ? '（已是）' : `（现 ${pctTxt(x.current.thresholdRatio)}）`}`).join('；') +
        (applied ? '' : '；其余模型走官方默认')
      : '没有需要单独设阈值的模型，全部走官方默认',
    kpis: [
      { label: '单独设阈值', value: `${tuned.length} 个模型`, hint: tuned.map(x => `${x.label} ${pctTxt(x.chosen.ratio)}`).join(' · ') },
      { label: '当前', value: applied ? '已是建议值' : '待应用', tone: applied ? 'ok' : 'warn' },
      { label: '压缩（实测）', value: `${sum(models.map(x => x.health.runs))} 次` },
    ],
    metrics: [
      { label: '模型', value: String(models.length) },
      { label: '要单独设', value: String(tuned.length) },
      { label: '压缩（实测）', value: String(sum(models.map(x => x.health.runs))) },
      { label: '当前写法', value: currentPolicies.length ? `按模型 ${currentPolicies.length} 条` : topLevelOverride ? '一个比例套所有模型' : '官方默认' },
    ],
    tables: [{
      title: '按模型',
      columns: ['模型', '窗口', '峰值', '现状', '压缩后保底', '建议', '说明'],
      rows: models.map(x => [
        x.label,
        x.W ? fmt(x.W) : '—',
        fmt(x.peak),
        x.current?.T ? `${pctTxt(x.current.thresholdRatio)} ≈${fmt(x.current.T)}` : pctTxt(x.current?.thresholdRatio ?? DEFAULTS.thresholdRatio),
        x.floor ? `${fmt((x.current?.retain ?? 0) + x.floor.D)}${x.floor.source === 'observed' ? '' : '（估）'}` : '—',
        x.verdict === 'tune' ? pctTxt(x.chosen.ratio) : verdictTxt[x.verdict],
        x.why,
      ]),
    }],
    details: models.filter(x => x.sweep).map(x => ({
      title: `回放：${x.label}`,
      columns: ['触发比例', '阈值', '压缩后', '压缩次数', '耗时占比', '成本/现状', '可用'],
      rows: x.sweep.map(r => [
        pctTxt(r.ratio), fmt(r.T), fmt(r.post), String(r.comps), pct1(r.timeShare),
        r.costRatio == null ? '—' : `${r.costRatio}×`, r.eligible ? '✓' : r.reasons.join('；'),
      ]),
    })),
    recommendations: [{
      tone: applied ? 'ok' : 'do',
      title: tuned.length ? `按模型写入 ${tuned.length} 条阈值，其余模型回到官方默认` : '回到官方默认',
      detail: '每个模型只在"压缩后还能留出 30% 余量、压缩耗时不超过 5%"的档里挑最省的一档，省得不到 3% 时取更高、更少压缩的那档。' +
        '没有数据、或阈值根本不会触发的模型不单独设，避免新换的小窗口模型被一个比例压到空转。',
      apply: {
        target: 'agent preset · compaction-basic.modelPolicies',
        effect: '新会话生效；已开会话需 /compact 或重开',
        changes: policies.map(p => ({ key: shortModel(p), value: `${pctTxt(p.thresholdRatio)} / retain 12% / headroom 8192` })),
        policies,
      },
    }],
    applied,
    notes: [
      '回放：请求间增长取实测 delta；压缩后 = retain + 保底（保底取实测成功压缩后首个请求减 retain 的中位数，没有实测就用开场请求 + 8k 摘要估）。',
      `成本按缓存命中价 = 未命中的 ${HIT_WEIGHT} 计，只用来比较各档，不是账单。`,
      '不单独设的模型用官方默认（80% / headroom 64k / retain 16%）。按模型策略里你另加的键（如摘要模型）写入时保留。',
    ],
  })

  // 2) compaction health. Every run is judged against the threshold that was
  // in force when it fired: compaction events do not record it, but the
  // trigger point does (context ÷ window ≈ ratio). Runs that fired well off
  // today's threshold belong to an older setting and are reported apart, so a
  // treadmill that the strategy card already fixed does not stay red.
  const ERR_CLASS = t => (/not smaller than the shadowed/i.test(t) ? 'tight'
    : /no text summary/i.test(t) ? 'empty'
      : /token cap|max[-_ ]?tokens/i.test(t) ? 'cap'
        : /time(d)? ?out|deadline/i.test(t) ? 'timeout' : 'other')
  const ERR_TEXT = { tight: '摘要不比原文小', empty: '摘要为空', cap: '摘要超出上限', timeout: '摘要超时', other: '其他错误' }
  const sumDur = new Map()
  for (const x of models) for (const r of x.runs) {
    if (!r.end || r.error || !r.sumModel) continue
    const a = sumDur.get(r.sumModel) ?? []
    a.push(r.end - r.start)
    sumDur.set(r.sumModel, a)
  }
  const classify = runs => {
    const c = {}
    for (const r of runs) if (r.error) { const k = ERR_CLASS(r.errorText); c[k] = (c[k] ?? 0) + 1 }
    return c
  }
  const topClass = c => Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0]
  const hx = models.filter(x => x.runs.length).map(x => {
    const auto = x.runs.filter(r => !r.manual)
    const curR = x.W && x.current?.T ? x.current.T / x.W : null
    // Evidence of an older setting: runs that fired clearly below today's
    // trigger, or a cluster (≥3) clearly above it. A lone run far above is an
    // overflow (one huge tool result) under today's setting, not a setting.
    const ratio = r => (x.W ? r.pre / x.W : 0)
    const bucket = r => `${Math.round(ratio(r) * 20) * 5}%`
    const highCount = {}
    if (curR != null) for (const r of auto) if (ratio(r) > curR + 0.12) highCount[bucket(r)] = (highCount[bucket(r)] ?? 0) + 1
    const evidence = new Set(curR == null ? auto : auto.filter(r => ratio(r) < curR - 0.03 || (ratio(r) > curR + 0.12 && highCount[bucket(r)] >= 3)))
    // The setting changed after the last run that fired off the old one: runs
    // before that, and time before that, do not count toward today's setting.
    const since = evidence.size ? Math.max(...[...evidence].map(r => r.end ?? r.start)) : -Infinity
    const cur = auto.filter(r => !evidence.has(r) && r.start > since)
    const old = auto.filter(r => evidence.has(r) || r.start <= since)
    const curTurnMs = sum(x.turns.filter(t => t.start >= since).map(t => t.end - t.start))
    const buckets = {}
    for (const r of old) buckets[bucket(r)] = (buckets[bucket(r)] ?? 0) + 1
    return {
      x, curR, cur, old, since, buckets,
      hc: healthOf(cur, curTurnMs), ho: healthOf(old, 0),
      classes: classify(cur), oldClasses: classify(old),
      reqsAfter: x.reqs.filter(r => r.t > since).length,
      manual: x.runs.length - auto.length,
    }
  })
  const hrecs = []
  for (const h of hx) {
    const L = h.x.label
    const curTxt = h.curR != null ? `${Math.round(h.curR * 100)}%` : '当前'
    const pick = tuned.find(t => t.key === h.x.key)
    const before = hrecs.length
    if (h.cur.length) {
      if ((h.classes.tight ?? 0) >= 2) {
        hrecs.push({
          tone: 'do', model: L,
          title: `${L}：可压缩的区间太小`,
          detail: `当前 ${curTxt} 档下 ${h.classes.tight} 次失败都是"摘要不比原文小"：压缩后保底离触发点太近，每次只能压掉几千 token。` +
            (pick && !pick.applied ? `应用「压缩策略」给它的 ${pctTxt(pick.chosen.ratio)}。` : '把它的阈值再提高一档，或把 retainRatio 降到 8%。'),
        })
      }
      if ((h.classes.empty ?? 0) >= 2) {
        hrecs.push({
          tone: 'do', model: L,
          title: `${L}：摘要多次返回空文本`,
          detail: `${h.classes.empty} 次摘要为空导致压缩失败。把压缩失败重试从默认 1 次加到 2 次。`,
          config: `# agent preset · compaction-basic 的 config\ncompactionRetries: 2`,
        })
      }
      if ((h.classes.cap ?? 0) >= 1) {
        hrecs.push({
          tone: 'do', model: L,
          title: `${L}：摘要超出输出上限`,
          detail: `${h.classes.cap} 次摘要写到一半被上限截断。把这个模型策略的 maxTokens（摘要上限）从 65536 提到 98304。`,
          config: `modelPolicies:\n  - provider: ${h.x.provider}\n    model: ${h.x.model}\n    maxTokens: 98304`,
        })
      }
      const done = h.cur.filter(r => r.end && !r.error).length
      if (h.hc.timeShare > MAX_TIME_SHARE && done >= 3) {
        const mine = pct(h.cur.filter(r => r.end && !r.error).map(r => r.end - r.start), 50)
        const alt = [...sumDur.entries()]
          .filter(([k, a]) => k !== h.x.key && a.length >= 3)
          .map(([k, a]) => ({ k, p50: pct(a, 50) }))
          .filter(a => a.p50 <= mine * 0.6)
          .sort((a, b) => a.p50 - b.p50)[0]
        const [ap, ...am] = alt ? alt.k.split('/') : []
        hrecs.push({
          tone: 'do', model: L,
          title: alt ? `${L}：压缩改用 ${am.join('/').replace(/^auto\//, '')} 写摘要` : `${L}：压缩太费时间`,
          detail: `当前档下压缩占这个模型工作时间的 ${pct1(h.hc.timeShare)}，单次约 ${Math.round(mine / 1000)} 秒。` +
            (alt ? `${am.join('/')} 实测单次约 ${Math.round(alt.p50 / 1000)} 秒。代价：摘要不再复用本模型的缓存前缀，摘要质量随摘要模型走。` : '没有更快的摘要模型可比，先看「压缩策略」能否把阈值提高。'),
          config: alt ? `modelPolicies:\n  - provider: ${h.x.provider}\n    model: ${h.x.model}\n    summarizationProvider: ${ap}\n    summarizationModel: ${am.join('/')}` : undefined,
        })
      }
      if (h.hc.thrashTurns >= 1 && !((h.classes.tight ?? 0) >= 2)) {
        hrecs.push({
          tone: 'do', model: L,
          title: `${L}：同一轮里反复压缩`,
          detail: `${h.hc.thrashTurns} 轮里压缩了 3 次以上：单轮工具输出太大，压完很快又满。` +
            (pick && !pick.applied ? `应用「压缩策略」给它的 ${pctTxt(pick.chosen.ratio)}。` : '提高阈值，或让这类任务分轮做。'),
        })
      }
    }
    const oldBad = h.ho.errors >= 3 || h.ho.thrashTurns >= 1
    if (oldBad) {
      const cls = topClass(h.oldClasses)
      hrecs.push({
        tone: 'ok', model: L,
        title: pick?.applied ? `${L}：旧设置下的空转已修正` : `${L}：旧设置下空转，现已换档`,
        detail: `旧 ${Object.keys(h.buckets).join(' / ')} 档 ${h.old.length} 次压缩、${h.ho.errors} 次失败` +
          (cls ? `（主要是"${ERR_TEXT[cls]}"）` : '') + `；现在是 ${curTxt}。` +
          (h.cur.length
            ? `改后 ${h.cur.length} 次压缩、${h.hc.errors} 次失败。`
            : `改后还没触发过压缩（之后 ${h.reqsAfter} 次请求），有记录后这里会更新。`),
      })
    }
    if (hrecs.length === before + (oldBad ? 1 : 0) && h.cur.length && h.hc.errors >= 1) {
      const cls = topClass(h.classes)
      hrecs.push({
        tone: 'info', model: L,
        title: `${L}：偶发 ${h.hc.errors} 次${ERR_TEXT[cls] ?? '失败'}`,
        detail: `当前 ${curTxt} 档下 ${h.cur.length} 次压缩只失败 ${h.hc.errors} 次，其余正常，不用改。` +
          (cls === 'empty' ? '连续出现再把 compactionRetries 调到 2。' : ''),
      })
    }
  }
  const curRuns = sum(hx.map(h => h.cur.length)), curErr = sum(hx.map(h => h.hc.errors))
  const oldRuns = sum(hx.map(h => h.old.length)), oldErr = sum(hx.map(h => h.ho.errors))
  if (!hrecs.length) {
    hrecs.push({ tone: 'ok', title: hx.length ? '压缩都正常' : '窗口内没有发生压缩', detail: hx.length ? `${curRuns} 次压缩，失败 ${curErr} 次。` : '对话还没长到需要压缩。' })
  }
  const hDo = hrecs.filter(r => r.tone === 'do')
  const pendingH = hx.filter(h => (h.ho.errors >= 3 || h.ho.thrashTurns >= 1) && !h.cur.length)
  const hStatus = hDo.length
    ? (hx.some(h => h.cur.length >= 3 && h.hc.status === 'bad') ? 'bad' : 'warn')
    : pendingH.length ? 'pending' : 'ok'
  const modelState = h => (hrecs.some(r => r.model === h.x.label && r.tone === 'do') ? '要处理'
    : (h.ho.errors >= 3 || h.ho.thrashTurns >= 1) && !h.cur.length ? '待观察' : '正常')
  const curShare = (() => {
    const ms = sum(hx.map(h => sum(h.cur.filter(r => r.end).map(r => r.end - r.start))))
    const tm = sum(hx.map(h => sum(h.x.turns.filter(t => t.start >= h.since).map(t => t.end - t.start))))
    return tm ? ms / tm : 0
  })()
  modules.push({
    id: 'health',
    title: '压缩健康',
    scope: '实测',
    status: hStatus,
    headline: hDo.length
      ? hDo.map(r => r.title).join('；')
      : pendingH.length
        ? pendingH.map(h => `${h.x.label}：旧设置下 ${h.ho.errors} 次失败，现为 ${Math.round((h.curR ?? 0) * 100)}%，等新的压缩记录验证`).join('；')
        : hx.length ? `当前设置下 ${curRuns} 次压缩、失败 ${curErr} 次，无需调` : '窗口内没有发生压缩',
    kpis: [
      { label: '当前设置下', value: `${curRuns} 次 · 失败 ${curErr}`, tone: hDo.length ? 'warn' : 'ok' },
      { label: '旧设置下', value: oldRuns ? `${oldRuns} 次 · 失败 ${oldErr}` : '—', hint: oldRuns ? '已不按这些档压缩' : undefined },
      { label: '压缩耗时占比', value: curRuns ? pct1(curShare) : '—', hint: '当前设置下' },
    ],
    metrics: [],
    tables: hx.length ? [{
      title: '按模型（按触发点归到当时生效的阈值）',
      columns: ['模型', '当前档', '压缩', '失败', '单次耗时', '耗时占比', '反复压的轮', '旧档 压缩/失败', '状态'],
      rows: hx.map(h => [
        h.x.label,
        h.curR != null ? `${Math.round(h.curR * 100)}%` : '—',
        String(h.cur.length), String(h.hc.errors),
        h.cur.length ? `${Math.round(h.hc.durP50 / 1000)}s` : '—',
        h.cur.length ? pct1(h.hc.timeShare) : '—',
        String(h.hc.thrashTurns),
        h.old.length ? `${h.old.length} / ${h.ho.errors}（${Object.keys(h.buckets).join('、')}）` : '—',
        modelState(h),
      ]),
    }] : [],
    recommendations: byTone(hrecs),
    notes: [
      '按触发点（压缩前上下文 ÷ 窗口）判断当时生效的阈值：明显低于今天阈值、或成批明显高于它的压缩属于旧设置，最后一次旧设置压缩之前的都归旧档。手动 /compact 不计' + (sum(hx.map(h => h.manual)) ? `（${sum(hx.map(h => h.manual))} 次）` : '') + '。',
      '失败 = compaction/end 带 error；反复压 = 同一轮里压缩 ≥3 次；耗时占比 = 压缩时间 ÷ 该模型的工作时间。',
    ],
  })

  // 3) cache
  const warmTtl = Math.max(300_000, Math.round((gapP90 * 1.5) / 60_000) * 60_000)
  const cacheRec = cacheShare === null
    ? null
    : cacheShare >= 80
      ? { tone: 'ok', title: '不装保温', detail: '缓存命中已高；保温只会多发请求。' }
      : over5 >= 10
        ? { tone: 'do', title: `可以试保温（TTL ≥ ${Math.round(warmTtl / 60_000)} 分钟）`, detail: '命中偏低且长停顿多，未命中多半是缓存过期，保温才有用。保温需要 dsh-warm 之类的运行时插件。' }
        : { tone: 'do', title: '保温没用，查前缀变化', detail: '命中偏低但几乎没有长停顿：未命中不是过期造成的，多半是每轮变化的系统提示（时间、计划注入）或路由组换了上游。' }
  modules.push({
    id: 'cache',
    title: '缓存策略',
    scope: '全模型',
    status: cacheShare !== null && cacheShare < 60 ? 'warn' : 'ok',
    headline: cacheShare === null ? '没有 usage 数据' : `命中 ${cacheShare}%、>5min 间隔占 ${over5}%：${cacheRec.title}`,
    kpis: [
      { label: '缓存命中', value: cacheShare === null ? '—' : `${cacheShare}%`, tone: cacheShare !== null && cacheShare < 60 ? 'warn' : 'ok' },
      { label: '请求间隔 p50 / p90', value: `${Math.round(gapP50 / 1000)}s / ${Math.round(gapP90 / 1000)}s` },
      { label: '>5min 间隔', value: `${over5}%` },
    ],
    metrics: [
      { label: 'cacheRead 占比', value: cacheShare === null ? '—' : `${cacheShare}%` },
      { label: '请求间隔 p50 / p90', value: `${Math.round(gapP50 / 1000)}s / ${Math.round(gapP90 / 1000)}s` },
      { label: '>5min 间隔', value: `${over5}%` },
      { label: 'cacheWrite', value: fmt(cacheWrite) },
    ],
    recommendations: cacheRec ? [cacheRec] : [],
    notes: ['保温需要 dsh-warm 之类的运行时插件，本插件只回答"装 / 不装 / 查哪里"。'],
  })

  // 4) model side: what the routes cost in waiting, per model
  const RETRY_TEXT = { idle: '长时间无输出', headers: '等响应头超时', reset: '连接断开', rate: '限流', server: '上游 5xx', empty: '空响应', timeout: '超时', other: '其他' }
  const kindsTxt = k => Object.entries(k).sort((a, b) => b[1] - a[1]).map(([n, v]) => `${RETRY_TEXT[n] ?? n} ${v}`).join('、')
  const mx = models.filter(x => x.requests).map(x => {
    const efforts = {}
    for (const r of x.reqs) if (r.effort) efforts[r.effort] = (efforts[r.effort] ?? 0) + 1
    const speeds = x.reqs.filter(r => r.output >= 200 && r.ms > 0).map(r => r.output / (r.ms / 1000))
    const lat = x.reqs.filter(r => r.ms > 0).map(r => r.ms)
    const prompt = sum(x.reqs.map(r => r.prompt)), read = sum(x.reqs.map(r => r.cacheRead))
    const kinds = {}
    for (const r of x.retries) kinds[r.kind] = (kinds[r.kind] ?? 0) + 1
    return {
      x, efforts, effort: Object.entries(efforts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '',
      speed: speeds.length ? pct(speeds, 50) : 0, lat50: lat.length ? pct(lat, 50) : 0,
      hit: prompt ? read / prompt : null, kinds, waited: sum(x.retries.map(r => r.waitedMs)),
      idle: x.retries.filter(r => r.kind === 'idle'),
    }
  })
  const mrecs = []
  for (const y of mx) {
    const L = y.x.label
    if (y.idle.length >= 2) {
      const waste = sum(y.idle.map(r => r.waitedMs))
      const hi = y.idle.filter(r => /^(xhigh|max)$/i.test(r.effort)).length
      mrecs.push(hi * 2 >= y.idle.length
        ? {
            tone: 'do', title: `${L}：推理档 ${y.idle.find(r => /^(xhigh|max)$/i.test(r.effort)).effort} → high`,
            detail: `${y.idle.length} 次"长时间无输出"后超时重试，共白等约 ${secs(waste)}，其中 ${hi} 次在最高推理档。推断：最高档思考期间不出流，撞上 10 分钟空闲超时。`,
            how: '在输入框下方的模型选择里，把这个模型的推理等级改成 High；只影响之后的请求。',
          }
        : {
            tone: 'info', title: `${L}：上游流式偶发卡住 ${y.idle.length} 次`,
            detail: `共白等约 ${secs(waste)}；不在最高推理档，多半是上游波动，持续出现再换路由组。`,
          })
    }
    const net = ['headers', 'reset', 'timeout', 'server', 'empty'].reduce((a, k) => a + (y.kinds[k] ?? 0), 0)
    if (net >= 3) {
      mrecs.push({
        tone: 'info', title: `${L}：路由偶发超时 / 断连 ${net} 次`,
        detail: `${kindsTxt(Object.fromEntries(Object.entries(y.kinds).filter(([k]) => k !== 'idle' && k !== 'rate')))}。DSH 已自动重试（最多 5 次），多为上游波动，不用改配置；同一路由持续出现再换路由组。`,
      })
    }
    if ((y.kinds.rate ?? 0) >= 3) {
      mrecs.push({ tone: 'do', title: `${L}：被限流 ${y.kinds.rate} 次`, detail: '同时开的会话 / 子代理太多，或额度到顶；错开并发或换路由。' })
    }
  }
  const totalRetries = sum(mx.map(y => y.x.retries.length)), totalWaited = sum(mx.map(y => y.waited))
  const allKinds = {}
  for (const y of mx) for (const [k, v] of Object.entries(y.kinds)) allKinds[k] = (allKinds[k] ?? 0) + v
  const mainM = mx[0]
  if (!mrecs.some(r => r.tone === 'do')) {
    mrecs.push({ tone: 'ok', title: '推理档与路由无需调', detail: `${requests.length} 次请求，重试 ${totalRetries} 次${totalWaited ? `，白等约 ${secs(totalWaited)}` : ''}。` })
  }
  const mDo = mrecs.filter(r => r.tone === 'do')
  modules.push({
    id: 'model',
    title: '模型侧',
    scope: '按模型',
    status: mDo.length ? 'warn' : 'ok',
    headline: mDo.length
      ? mDo.map(r => r.title).join('；')
      : `重试 ${totalRetries} 次${mainM?.speed ? `，${mainM.x.label} 生成约 ${Math.round(mainM.speed)} tok/s` : ''}，无需调`,
    kpis: [
      { label: '重试', value: `${totalRetries} 次`, hint: kindsTxt(allKinds), tone: mDo.length ? 'warn' : undefined },
      { label: '重试前白等', value: totalWaited ? secs(totalWaited) : '0' },
      { label: '生成速度', value: mainM?.speed ? `${Math.round(mainM.speed)} tok/s` : '—', hint: mainM?.x.label },
    ],
    metrics: [],
    tables: [{
      title: '按模型',
      columns: ['模型', '请求', '推理档', '生成速度', '单步耗时 p50', '缓存命中', '重试', '白等'],
      rows: mx.map(y => [
        y.x.label, String(y.x.requests),
        Object.entries(y.efforts).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(' ') || '—',
        y.speed ? `${Math.round(y.speed)} tok/s` : '—',
        y.lat50 ? `${Math.round(y.lat50 / 1000)}s` : '—',
        y.hit == null ? '—' : `${Math.round(y.hit * 100)}%`,
        y.x.retries.length ? `${y.x.retries.length}（${kindsTxt(y.kinds)}）` : '0',
        y.waited ? secs(y.waited) : '—',
      ]),
    }],
    recommendations: byTone(mrecs),
    notes: [
      '白等 = 重试前这一步已经等掉的时间（同一步里从上次重试重新计）。',
      '生成速度 = 输出 token ÷ 该步耗时（含首字延迟），只取输出 ≥200 token 的步。',
      '输出是否被截断无法判断：0.2.2 的会话事件不记录结束原因。推理档只按超时下结论，不评价思考质量。',
    ],
  })

  // 5) tool side: failures that cost a step, and what fills the context
  const usage = collectUsage(sessions)
  const agentsMd = opts.agentsMd ?? '~/.dsh/AGENTS.md'
  const hookFiles = opts.hookFiles?.length ? `（${opts.hookFiles.join('、')}）` : ''
  const allCalls = sum(usage.tools.map(t => t.calls)), allErr = sum(usage.tools.map(t => t.errors))
  const rc = usage.tools.find(t => t.name === 'run_code')
  const deadline = rc?.kinds.deadline ?? 0
  const fsNot = sum(usage.tools.map(t => t.kinds.FS_NOT_OBSERVED ?? 0))
  const workMs = sum(models.map(x => sum(x.turns.map(t => t.end - t.start))))
  const hookShare = workMs ? usage.hookMs / workMs : 0
  const kchars = n => (n >= 1000 ? `${(n / 1000).toFixed(1)}k 字符` : `${n} 字符`)
  const big = usage.tools.filter(t => t.calls >= 10 && pct(t.chars, 90) >= 16_000)
  const trecs = []
  if (deadline >= 5) {
    trecs.push({
      tone: 'do', title: `run_code 超时 ${deadline} 次`,
      detail: 'run_code 默认 120 秒就被掐断（模型可传 timeoutMs，最多 600 秒）。长命令（安装、编译、批量转换）超时后模型只能重跑。',
      how: `在 ${agentsMd} 里加一句：`,
      config: 'run_code 默认 120 秒超时：预计超过 1 分钟的命令传 timeoutMs（最多 600000），或用后台 job 跑再轮询结果。',
    })
  }
  if (fsNot >= 5) {
    trecs.push({
      tone: 'do', title: `改文件前没先读 ${fsNot} 次`,
      detail: 'edit / write 改本会话没读过的文件会报 FS_NOT_OBSERVED，模型读一遍再重试，白费一步。',
      how: `在 ${agentsMd} 里加一句：`,
      config: '用 edit / write 改已有文件前，先用 read 读一遍（否则报 FS_NOT_OBSERVED）。',
    })
  }
  for (const t of big) {
    trecs.push({
      tone: 'info', title: `${t.name} 单次输出大（p90 ${kchars(pct(t.chars, 90))}）`,
      detail: `${t.calls} 次调用合计约 ${kchars(sum(t.chars))} 进上下文，会抬高压缩后保底。工具结果修剪只在压缩时把超过 8k 字符的结果裁成头 4k + 尾 1k，平时不裁；能缩小查询范围就缩小。`,
    })
  }
  if (usage.hookRuns) {
    trecs.push(hookShare >= 0.05
      ? {
          tone: 'do', title: `工具钩子占工作时间 ${pct1(hookShare)}`,
          detail: `${usage.hookRuns} 次 PostToolUse 钩子，每次约 ${Math.round(usage.hookP50)}ms，合计 ${secs(usage.hookMs)}。钩子 matcher 是 .*（每个工具都跑），可收窄到真正需要的工具。`,
          how: `改钩子配置${hookFiles}里的 matcher（同一份钩子配置可能还给别的工具用，改前先确认）。`,
        }
      : {
          tone: 'ok', title: '工具钩子开销小',
          detail: `${usage.hookRuns} 次 PostToolUse 钩子，每次约 ${Math.round(usage.hookP50)}ms，合计 ${secs(usage.hookMs)}，占工作时间 ${pct1(hookShare)}。`,
        })
  }
  trecs.push({
    tone: 'ok', title: '工具声明无需精简',
    detail: toolsTokens ? `工具声明约 ${fmt(toolsTokens)} token，占 prompt 中位数的 ${promptP50 ? Math.round((toolsTokens / promptP50) * 100) : 0}%。` : '未采集到工具声明。',
  })
  const tDo = trecs.filter(r => r.tone === 'do')
  modules.push({
    id: 'tools',
    title: '工具面',
    scope: '实测',
    status: tDo.length ? 'warn' : 'ok',
    headline: tDo.length ? tDo.map(r => r.title).join('；') : `${allCalls} 次工具调用，失败 ${pct1(allCalls ? allErr / allCalls : 0)}，无需调`,
    kpis: [
      { label: '工具调用', value: String(allCalls), hint: `失败 ${pct1(allCalls ? allErr / allCalls : 0)}` },
      { label: 'run_code 超时', value: `${deadline} 次`, tone: deadline >= 5 ? 'warn' : undefined },
      { label: '先读后改漏读', value: `${fsNot} 次`, tone: fsNot >= 5 ? 'warn' : undefined },
    ],
    metrics: [],
    tables: [{
      title: '按工具（含 run_code 里调用的）',
      columns: ['工具', '调用', '经 run_code', '失败', '主要失败', '输出 p50', '输出 p90'],
      rows: usage.tools.slice(0, 14).map(t => [
        t.name, String(t.calls), t.inner ? String(t.inner) : '—', t.errors ? `${t.errors}（${pct1(t.errors / t.calls)}）` : '0',
        Object.entries(t.kinds).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `${FAIL_TEXT[k] ?? k} ${v}`).join('、') || '—',
        kchars(pct(t.chars, 50)), kchars(pct(t.chars, 90)),
      ]),
    }],
    recommendations: byTone(trecs),
    notes: [
      'run_code 的失败按报错文本细分：超时、内部工具出错、代码错误。模型写代码试错本身正常，只对超时和漏读给建议。',
      '输出按字符计，中文约 1–2 字符一个 token、英文约 4 字符一个 token。',
    ],
  })

  return {
    ok: true,
    generatedAt: Date.now(),
    window: { days, sessions: sessions.length, requests: requests.length, gaps: gaps.length },
    totals: { prompt: sum(requests.map(r => r.prompt)), cacheRead, uncached, cacheWrite, output },
    context: { model: dominant?.model ?? '' },
    models: models.map(({ sweep, runs, turns, reqs, retries, ...x }) => x),
    modules,
  }
}

function fmt(n) {
  if (!Number.isFinite(n)) return '—'
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(Math.round(n))
}

// ---------------------------------------------------------------------------
// preset (compaction-basic) read + write
// ---------------------------------------------------------------------------

function findCompactionRow(plugins) {
  if (!Array.isArray(plugins)) return null
  for (const row of plugins) {
    if (!row || typeof row !== 'object') continue
    if (row.name === COMPACTION_PLUGIN) return row
    if (row.group === true && Array.isArray(row.config)) {
      const hit = findCompactionRow(row.config)
      if (hit) return hit
    }
  }
  return null
}

// Key-order-insensitive comparison; `!!js` values are plain marker objects.
const stable = v => JSON.stringify(v ?? null, (_, x) =>
  x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]]))
    : x)

function rowIds(plugins, out = []) {
  for (const row of Array.isArray(plugins) ? plugins : []) {
    if (!row || typeof row !== 'object') continue
    if (row.id) out.push(row.id)
    if (row.group === true && Array.isArray(row.config)) rowIds(row.config, out)
  }
  return out
}

// Row ids the stored preset names that the running DSH's default no longer has.
export function staleRows(current, inherited) {
  if (!Array.isArray(inherited?.plugins)) return []
  const known = new Set(rowIds(inherited.plugins))
  return rowIds(current?.plugins).filter(id => !known.has(id))
}

// The stored preset laid over the running DSH's default rows: a row both have
// keeps the user's version, a row only the default has is added, a row the
// default no longer ships is dropped. Fields outside `plugins` stay as stored.
export function mergeOnInherited(current, inherited) {
  const next = structuredClone(current ?? {})
  next.plugins = mergeRows(current?.plugins, inherited.plugins)
  return next
}

function mergeRows(mine, theirs) {
  const byId = new Map((Array.isArray(mine) ? mine : []).filter(r => r?.id).map(r => [r.id, r]))
  return theirs.map(row => {
    const own = row?.id ? byId.get(row.id) : undefined
    if (!own) return structuredClone(row)
    const out = structuredClone(own)
    if (row.group === true && Array.isArray(row.config) && own.group === true && Array.isArray(own.config)) {
      out.config = mergeRows(own.config, row.config)
    }
    return out
  })
}

// What a write starts from: the stored preset as it is, or merged onto the
// default when it names rows this DSH no longer ships.
export function editBase(current, inherited) {
  return staleRows(current, inherited).length
    ? mergeOnInherited(current, inherited)
    : structuredClone(current ?? {})
}

async function rebasePresets(ctx) {
  const editor = ctx.get('configEditor')
  if (!editor || typeof editor.edit !== 'function' || typeof editor.configuration !== 'function') {
    return { ran: false, reason: 'configEditor 不可用' }
  }
  const results = []
  for (const conf of editor.configuration()) {
    const entry = conf.entry
    if (entry?.options?.name !== PRESET_PLUGIN || !Object.keys(conf.override ?? {}).length) continue
    const current = entry.options.config
    if (!staleRows(current, conf.inherited).length) continue
    const id = current?.id ?? null
    const next = mergeOnInherited(current, conf.inherited)
    if (stable(next) === stable(current)) continue
    const before = rowIds(current.plugins)
    const after = rowIds(next.plugins)
    try {
      await editor.edit(entry, () => next)
      results.push({
        id,
        ok: true,
        dropped: before.filter(x => !after.includes(x)),
        added: after.filter(x => !before.includes(x)),
      })
    } catch (err) {
      results.push({ id, ok: false, reason: String(err?.message ?? err) })
    }
  }
  return { ran: true, at: Date.now(), results }
}

function describeRebase(rebase) {
  if (!rebase?.results?.length) return null
  return rebase.results.map(r => r.ok
    ? `preset ${r.id} 已按当前 DSH 默认重建（你改过的行保留）` +
      (r.dropped.length ? `，移除 ${r.dropped.join(', ')}` : '') +
      (r.added.length ? `，新增 ${r.added.join(', ')}` : '')
    : `preset ${r.id} 未能重建：${r.reason}`).join('；')
}

function describeConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  const top = [
    `${Math.round(num(c.thresholdRatio, DEFAULTS.thresholdRatio) * 100)}%`,
    `headroom ${fmt(num(c.headroomTokens, DEFAULTS.headroomTokens))}`,
    typeof c.retainTokens === 'number' ? `retain ${fmt(c.retainTokens)}` : `retain ${Math.round(num(c.retainRatio, DEFAULTS.retainRatio) * 100)}%`,
  ].join(' / ')
  const per = (Array.isArray(c.modelPolicies) ? c.modelPolicies : []).map(p =>
    `${String(p.model).replace(/^auto\//, '')} ${Math.round(num(p.thresholdRatio, num(c.thresholdRatio, DEFAULTS.thresholdRatio)) * 100)}%`)
  return { top, per }
}

async function readPreset(ctx) {
  const presets = ctx.get('agentPresets')
  if (!presets || typeof presets.list !== 'function') {
    return { available: false, reason: 'agentPresets 不可用（需要 DSH 0.2.1+）' }
  }
  const editor = ctx.get('configEditor')
  if (!editor || typeof editor.edit !== 'function' || typeof editor.entries !== 'function') {
    return { available: false, id: presets.defaultId, reason: 'configEditor 不可用（profile 热编辑未挂载）' }
  }
  const id = presets.defaultId
  const meta = (await presets.list()).find(r => r.id === id) ?? {}
  const target = editor.entries().find(
    e => e.options.name === PRESET_PLUGIN && e.options.config?.id === id,
  )
  const base = { id, name: meta.name ?? null, isDefault: true, broken: meta.broken ?? null }
  if (!target) {
    return { ...base, available: false, reason: '当前 preset 的配置行不可编辑（可能由 home patch / 命令行覆盖提供）' }
  }
  const conf = editor.configuration().find(r => r.entry === target)
  const rowConfig = findCompactionRow(target.options.config?.plugins)?.config ?? {}
  const inheritedConfig = (conf && findCompactionRow(conf.inherited?.plugins)?.config) ?? {}
  const cur = describeConfig(rowConfig)
  return {
    ...base,
    available: true,
    writeTarget: editor.documentPath,
    rowConfig,
    currentText: cur.top,
    currentPolicies: cur.per,
    inheritedText: describeConfig(inheritedConfig).top,
    hasOverride: Object.keys(conf?.override ?? {}).length > 0,
  }
}

function validatePolicies(list) {
  if (!Array.isArray(list)) throw new Error('policies 必须是数组')
  const seen = new Set()
  return list.map((p, i) => {
    if (!p || typeof p.provider !== 'string' || typeof p.model !== 'string' || !p.model) {
      throw new Error(`policies[${i}] 缺 provider / model`)
    }
    const k = modelKey(p.provider, p.model)
    if (seen.has(k)) throw new Error(`policies 里 ${k} 重复`)
    seen.add(k)
    const r = Number(p.thresholdRatio)
    if (!Number.isFinite(r) || r < 0.2 || r > 0.9) throw new Error(`${k} 的 thresholdRatio 必须在 0.2–0.9 之间`)
    return { provider: p.provider, model: p.model, thresholdRatio: r, ...TUNED }
  })
}

async function writeCompaction(ctx, policies) {
  const presets = ctx.get('agentPresets')
  const editor = ctx.get('configEditor')
  if (!presets || !editor) throw new Error('agentPresets / configEditor 不可用')
  const id = presets.defaultId
  const findTarget = () => editor.entries().find(
    e => e.options.name === PRESET_PLUGIN && e.options.config?.id === id,
  )
  const target = findTarget()
  if (!target) throw new Error('当前 preset 的配置行不可编辑')
  const beforeRaw = structuredClone(target.options.config ?? {})
  const before = describeConfig(findCompactionRow(beforeRaw.plugins)?.config)
  const prev = findCompactionRow(beforeRaw.plugins)?.config?.modelPolicies ?? []
  const written = policies.map(p => {
    const o = Array.isArray(prev) ? prev.find(q => q?.provider === p.provider && q?.model === p.model) : null
    const extra = o ? Object.fromEntries(Object.entries(o).filter(([k]) => !TUNED_KEYS.includes(k))) : {}
    return { ...extra, ...p }
  })

  await editor.edit(target, (current, inherited) => {
    const next = editBase(current, inherited)
    const row = findCompactionRow(next.plugins)
    if (!row) throw new Error(`preset ${id} 里没有 ${COMPACTION_PLUGIN} 行，拒绝写入`)
    // Top level back to the upstream defaults: a model without its own policy —
    // say a small-window route picked tomorrow — never inherits a tuned ratio.
    const cfg = structuredClone(findCompactionRow(inherited?.plugins)?.config ?? {})
    delete cfg.modelPolicies
    if (written.length) cfg.modelPolicies = written
    if (Object.keys(cfg).length) row.config = cfg
    else delete row.config
    return next
  })

  const afterCfg = findCompactionRow(findTarget()?.options.config?.plugins)?.config ?? {}
  const after = describeConfig(afterCfg)
  if (stable(afterCfg.modelPolicies ?? []) !== stable(written)) {
    // The edit reported success but the live preset does not show our values.
    // configEditor already restores the file when reconciliation throws; this
    // covers the case where the write landed but the runtime kept the old
    // revision (for example a pending restart).
    let rolledBack = false
    try {
      await editor.edit(findTarget(), () => beforeRaw)
      rolledBack = true
    } catch {}
    return { ok: false, verified: false, rolledBack, before, after }
  }
  return { ok: true, verified: true, before, after }
}

async function revertCompaction(ctx) {
  const presets = ctx.get('agentPresets')
  const editor = ctx.get('configEditor')
  if (!presets || !editor) throw new Error('agentPresets / configEditor 不可用')
  const id = presets.defaultId
  const findTarget = () => editor.entries().find(
    e => e.options.name === PRESET_PLUGIN && e.options.config?.id === id,
  )
  const target = findTarget()
  if (!target) throw new Error('当前 preset 的配置行不可编辑')
  const before = describeConfig(findCompactionRow(target.options.config?.plugins)?.config)
  await editor.edit(target, (current, inherited) => {
    const next = editBase(current, inherited)
    const row = findCompactionRow(next.plugins)
    if (!row) throw new Error(`preset ${id} 里没有 ${COMPACTION_PLUGIN} 行`)
    const cfg = findCompactionRow(inherited?.plugins)?.config
    if (cfg === undefined) delete row.config
    else row.config = structuredClone(cfg)
    // Nothing else customised: equal to inherited, so configEditor drops the
    // override row entirely.
    return Array.isArray(inherited?.plugins) && stable(next) === stable(inherited)
      ? structuredClone(inherited)
      : next
  })
  const after = describeConfig(findCompactionRow(findTarget()?.options.config?.plugins)?.config)
  return { ok: true, before, after }
}

const STATUS_TEXT = { ok: '正常', warn: '建议调整', bad: '有问题', pending: '待观察', info: '仅观测' }

export function formatText(report) {
  if (!report?.ok) return `调优报告不可用：${report?.error ?? '未知错误'}`
  const out = [`调优报告 · 近 ${report.window.days} 天 · ${report.window.sessions} 会话 / ${report.window.requests} 请求`]
  for (const m of report.modules) {
    out.push('', `【${m.title}】${STATUS_TEXT[m.status] ?? ''}`, m.headline)
    for (const x of (m.kpis?.length ? m.kpis : m.metrics) ?? []) out.push(`· ${x.label}: ${x.value}${x.hint ? `（${x.hint}）` : ''}`)
    if (m.preset?.rebaseText) out.push(`· ${m.preset.rebaseText}`)
    if (m.preset?.available) {
      out.push(`· preset ${m.preset.id}: 顶层 ${m.preset.currentText}` +
        (m.preset.currentPolicies?.length ? `；按模型 ${m.preset.currentPolicies.join('、')}` : ''))
    } else if (m.preset) {
      out.push(`· preset: ${m.preset.reason ?? '不可用'}`)
    }
    for (const t of m.tables ?? []) {
      out.push(`  ${t.title}：`)
      for (const r of t.rows) out.push('  - ' + t.columns.map((c, i) => `${c} ${r[i]}`).join(' | '))
    }
    for (const rec of m.recommendations ?? []) {
      out.push(`${rec.tone === 'do' ? '→' : '·'} ${rec.title}`, `  ${rec.detail}`)
      if (rec.how) out.push(`  ${rec.how}`)
      if (rec.config) out.push(...rec.config.split('\n').map(l => `    ${l}`))
      const ch = rec.apply?.changes ?? []
      if (ch.length) out.push('  ' + ch.map(c => `${c.key}=${c.value}`).join('；'))
    }
  }
  return out.join('\n')
}

// Where this profile's AGENTS.md and Claude Code style hook files live, for the
// tool-side advice; `~` for the home directory.
function profilePaths(ctx) {
  const tilde = p => {
    const home = os.homedir()
    return p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p
  }
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  let hookFiles = []
  try {
    hookFiles = (ctx.get('configEditor')?.entries?.() ?? [])
      .filter(e => e.options?.name === '@deepseek-ai/dsh-hooks-claude-code' && typeof e.options.config?.configPath === 'string')
      .map(e => tilde(e.options.config.configPath))
  } catch {}
  return { agentsMd: tilde(path.join(dshHome, 'AGENTS.md')), hookFiles }
}

export function apply(ctx) {
  const cache = new Map()
  let writing = null
  let lastRebase = null

  async function report(days, maxSessions) {
    const key = `${days}:${maxSessions}`
    const hit = cache.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value

    const query = ctx.get('sessionQuery')
    if (!query || typeof query.listSessions !== 'function') {
      return { ok: false, error: 'sessionQuery 不可用（需要 DSH 0.2.1+）' }
    }
    const since = Date.now() - days * DAY
    // Subagent runs (delegationDepth > 0) are not the user's sessions; forks
    // ("… (1)", parentSession + isSeeded) are, and often the longest ones —
    // the 2026-11-06 Grok treadmill ran in a fork. Their shared history is
    // de-duplicated in collectModels.
    const isChild = h => (h?.delegationDepth ?? 0) > 0 || (Boolean(h?.parentSession) && !h?.isSeeded)
    const records = (await query.listSessions()).filter(
      r => r?.header?.createdAt >= since && !isChild(r.header),
    ).slice(0, maxSessions)

    const sessions = []
    for (const rec of records) {
      try {
        const view = await query.readSession(rec.header.id)
        const s = analyzeSession(view, rec.header)
        if (s.requests.length >= 3) sessions.push(s)
      } catch {
        // an unreadable session never fails the whole report
      }
    }
    let value
    if (!sessions.length) {
      value = { ok: false, error: `近 ${days} 天没有可分析的会话（需要 assistant/message 带 usage）` }
    } else {
      // The replay compares every model against what is in force now, so the
      // preset is read first.
      let preset
      try {
        preset = await readPreset(ctx)
      } catch (err) {
        preset = { available: false, reason: String(err?.message ?? err) }
      }
      value = buildReport(sessions, days, {
        policy: preset.available ? preset.rowConfig : undefined,
        ...profilePaths(ctx),
      })
      const { rowConfig, ...shown } = preset
      const compaction = value.modules.find(m => m.id === 'compaction')
      compaction.preset = { ...shown, rebaseText: describeRebase(lastRebase) }
    }
    cache.set(key, { at: Date.now(), value })
    return value
  }

  function clearCache() { cache.clear() }

  // After a DSH upgrade the stored preset copy may name rows the new version
  // no longer ships; rebuild it before anyone opens a session of that preset.
  ctx.inject(['configEditor'], c => {
    c.effect(() => {
      const timer = setTimeout(async () => {
        if (writing) return
        writing = rebasePresets(c)
        try {
          lastRebase = await writing
          if (lastRebase.results?.length) {
            clearCache()
            const log = typeof c.logger === 'function' ? c.logger('dsh-tuner') : null
            log?.info?.(describeRebase(lastRebase))
          }
        } catch (err) {
          lastRebase = { ran: false, reason: String(err?.message ?? err) }
        } finally {
          writing = null
        }
      }, 1500)
      return () => clearTimeout(timer)
    }, 'dsh-tuner: preset rebase')
  })

  ctx.inject(['commands'], c => {
    const commands = c.get('commands')
    if (!commands || typeof commands.register !== 'function') return
    c.effect(() => commands.register({
      name: 'tuner',
      description: '按本机真实用量给出分模块调优建议（只读；面板里可一键应用）',
      handler: async () => {
        try {
          const r = await report(14, 60)
          return { kind: r.ok ? 'success' : 'error', text: formatText(r) }
        } catch (err) {
          return { kind: 'error', text: `调优报告失败：${String(err?.message ?? err)}` }
        }
      },
    }), 'dsh-tuner: /tuner command')
  })

  async function handleApply(body) {
    if (writing) throw new Error('已有一次写入在进行，请稍后再试')
    writing = (async () => {
      const action = body?.action === 'revert' ? 'revert' : 'apply'
      if (action === 'revert') {
        const result = await revertCompaction(ctx)
        clearCache()
        return { ok: true, action, ...result, effect: '仅影响新会话；已开会话保留原压缩行为' }
      }
      let policies
      if (Array.isArray(body?.policies)) {
        policies = validatePolicies(body.policies)
      } else {
        // Same window as the card the user is looking at.
        const days = Math.min(90, Math.max(1, Number(body?.days) || 14))
        const r = await report(days, 60)
        if (!r.ok) throw new Error(r.error ?? '没有可用的建议值')
        const m = r.modules.find(x => x.id === 'compaction')
        const rec = (m?.recommendations ?? []).find(x => x.apply)
        if (!rec) throw new Error('当前没有可应用的压缩建议')
        policies = validatePolicies(rec.apply.policies)
      }
      const result = await writeCompaction(ctx, policies)
      clearCache()
      return {
        ok: result.ok,
        action: 'apply',
        policies,
        before: result.before,
        after: result.after,
        verified: result.verified,
        rolledBack: result.rolledBack ?? false,
        effect: '新会话生效；已开会话需 /compact 或重开',
      }
    })()
    try {
      return await writing
    } finally {
      writing = null
    }
  }

  ctx.inject(['connection'], c => {
    const connection = c.get('connection')
    const fetch = connection?.fetch
    if (!fetch || typeof fetch.register !== 'function') return

    c.effect(() => fetch.register({
      path: '/api/dsh-tuner/report',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try { body = await request.json() } catch {}
        const days = Math.min(90, Math.max(1, Number(body?.days) || 14))
        const maxSessions = Math.min(200, Math.max(1, Number(body?.maxSessions) || 40))
        try {
          return Response.json(await report(days, maxSessions), { headers: { 'cache-control': 'no-store' } })
        } catch (err) {
          return Response.json({ ok: false, error: String(err?.message ?? err) }, { headers: { 'cache-control': 'no-store' } })
        }
      },
    }), 'dsh-tuner: report route')

    c.effect(() => fetch.register({
      path: '/api/dsh-tuner/preset',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          const { rowConfig, ...preset } = await readPreset(ctx)
          return Response.json({ ok: true, preset, rowConfig, rebase: lastRebase }, { headers: { 'cache-control': 'no-store' } })
        } catch (err) {
          return Response.json({ ok: false, error: String(err?.message ?? err) }, { headers: { 'cache-control': 'no-store' } })
        }
      },
    }), 'dsh-tuner: preset state route')

    c.effect(() => fetch.register({
      path: '/api/dsh-tuner/apply',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        let body = {}
        try { body = await request.json() } catch {}
        try {
          return Response.json(await handleApply(body), { headers: { 'cache-control': 'no-store' } })
        } catch (err) {
          return Response.json({ ok: false, error: String(err?.message ?? err) }, { status: 200, headers: { 'cache-control': 'no-store' } })
        }
      },
    }), 'dsh-tuner: apply route')
  })
}
