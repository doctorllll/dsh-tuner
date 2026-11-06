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
 */
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

function analyzeSession(view, header) {
  const events = readEvents(view)
  const s = {
    id: header?.id ?? view.header?.id,
    cwd: header?.cwd ?? view.header?.cwd,
    createdAt: header?.createdAt ?? view.header?.createdAt ?? 0,
    parent: header?.parentSession ?? null,
    requests: [],
    compactions: [],
    toolsTokens: 0,
    ctx: 0,
    maxTokens: 0,
    model: '',
    provider: '',
    effort: '',
    toolCalls: {},
  }
  for (const e of events) {
    if (e.type === 'request/header') {
      const h = e.data?.header
      if (h) {
        if (!s.model && h.config?.model) { s.model = h.config.model; s.provider = h.config.provider ?? ''; s.effort = h.config?.reasoningEffort ?? '' }
        const mt = Number(h.config?.maxTokens)
        if (Number.isFinite(mt) && mt > s.maxTokens) s.maxTokens = mt
        const tok = sum((h.tools ?? []).map(jsonTokens))
        if (tok > s.toolsTokens) s.toolsTokens = tok
      }
    } else if (e.type === 'request/context') {
      const w = e.data?.contextWindow
      if (typeof w === 'number' && w > s.ctx) s.ctx = w
      if (!s.model && e.data?.model) s.model = e.data.model
    } else if (e.type === 'assistant/message') {
      const u = e.data?.usage
      if (!u) continue
      const uncached = Number(u.inputTokens) || 0
      const cacheRead = Number(u.cacheReadTokens) || 0
      const cacheWrite = Number(u.cacheWriteTokens) || 0
      const output = Number(u.outputTokens) || 0
      const prompt = uncached + cacheRead + cacheWrite
      if (prompt <= 0 && output <= 0) continue
      s.requests.push({ t: e.time, prompt, uncached, cacheRead, cacheWrite, output })
    } else if (e.type === 'compaction/summary' || e.type === 'compaction/prune') {
      s.compactions.push({ t: e.time, tok: Number(e.data?.shadowedTokenCount) || 0 })
    } else if (e.type === 'tool/call') {
      const n = e.data?.name
      if (typeof n === 'string') s.toolCalls[n] = (s.toolCalls[n] ?? 0) + 1
    }
  }
  s.requests.sort((a, b) => a.t - b.t)
  return s
}

// Counterfactual replay: fire compaction when the simulated context would exceed T.
// Assumptions, stated in the UI: growth between requests = observed prompt delta;
// after compaction context collapses to retain*T verbatim + 3k summary.
function simulate(reqs, T, retain = 0.12, summary = 3000) {
  if (!reqs.length) return null
  let size = reqs[0].prompt
  let cost = 0
  let peak = 0
  let comps = 0
  for (let i = 0; i < reqs.length; i++) {
    if (i > 0) size += Math.max(0, reqs[i].prompt - reqs[i - 1].prompt)
    if (size > T) { comps++; size = Math.min(size, retain * T + summary) }
    cost += size
    peak = Math.max(peak, size)
  }
  return { comps, cost, peak }
}

function buildReport(sessions, days) {
  const requests = sessions.flatMap(s => s.requests)
  const dominant = sessions.slice().sort((a, b) => b.requests.length - a.requests.length)[0]
  const W = dominant?.ctx || sessions.map(s => s.ctx).sort((a, b) => b - a)[0] || 0
  const reserved = sessions.map(s => s.maxTokens).sort((a, b) => b - a)[0] || 0
  const promptP50 = pct(requests.map(r => r.prompt), 50)
  const promptP90 = pct(requests.map(r => r.prompt), 90)
  const promptMax = requests.length ? Math.max(...requests.map(r => r.prompt)) : 0
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
  const comps = sessions.flatMap(s => s.compactions)
  const toolsTokens = pct(sessions.map(s => s.toolsTokens), 50)
  const toolTotals = {}
  for (const s of sessions) for (const [k, v] of Object.entries(s.toolCalls)) toolTotals[k] = (toolTotals[k] ?? 0) + v
  const topTools = Object.entries(toolTotals).sort((a, b) => b[1] - a[1]).slice(0, 8)

  // ---- compaction sweep
  const baseline = sum(sessions.map(s => simulate(s.requests, 1e12)?.cost ?? 0))
  const sweep = []
  for (const ratio of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]) {
    let cost = 0, compsN = 0, peak = 0
    for (const s of sessions) {
      const r = simulate(s.requests, (s.ctx || W || 1_000_000) * ratio)
      if (!r) continue
      cost += r.cost; compsN += r.comps; peak = Math.max(peak, r.peak)
    }
    sweep.push({
      ratio,
      compactions: compsN,
      cost: Math.round(cost),
      costRatio: baseline ? Math.round((cost / baseline) * 1000) / 1000 : null,
      peak,
    })
  }
  const compsPerSession = sessions.length ? comps.length / sessions.length : 0
  // 触发点下限 30%：低于它省的是 token，丢的是上下文质量；上限 60% 之后基本不省。
  const viable = sweep.filter(
    r => r.ratio >= 0.3 && r.ratio <= 0.6 &&
      r.peak <= Math.max(promptP90 * 1.15, 0.6 * (W || 1e9)) &&
      r.compactions <= Math.max(2, sessions.length * 1.5),
  )
  const best = (viable.length ? viable : sweep.filter(r => r.ratio >= 0.4 && r.ratio <= 0.6))
    .sort((a, b) => (a.costRatio ?? 9) - (b.costRatio ?? 9))[0]
  const retainRatio = 0.12

  const modules = []

  // 1) compaction
  modules.push({
    id: 'compaction',
    title: '压缩策略',
    scope: dominant?.model ? `${dominant.provider}/${dominant.model}` : '当前路由',
    status: promptMax > 0.55 * (W || Infinity) ? 'warn' : 'ok',
    headline: best
      ? `建议触发点 ${Math.round(best.ratio * 100)}%（≈${fmt(best.ratio * W)}），估算成本 ${best.costRatio}×、峰值 ${fmt(best.peak)}、压缩 ${best.compactions} 次`
      : '样本不足，暂不建议',
    metrics: [
      { label: '窗口', value: W ? fmt(W) : '未知' },
      { label: 'prompt p50 / p90', value: `${fmt(promptP50)} / ${fmt(promptP90)}` },
      { label: '峰值', value: `${fmt(promptMax)}${W ? `（窗口 ${Math.round((promptMax / W) * 100)}%）` : ''}` },
      { label: '压缩次数', value: `${comps.length}（${compsPerSession.toFixed(1)}/会话）` },
      { label: '阈值现状', value: W ? `≈${fmt(Math.min(W * 0.8, W - reserved - 65536))}` : '未知', hint: 'min(0.8W, W − 输出预留 − 64k headroom)' },
    ],
    recommendation: best ? {
      title: `把触发比例设到 ${Math.round(best.ratio * 100)}%`,
      detail: `保留比例 ${Math.round(retainRatio * 100)}%（压缩后逐字保留 ${fmt(retainRatio * W)}），headroom 设 0 让比例真正生效；单请求峰值约 ${fmt(best.peak)}。`,
      apply: {
        target: 'agent preset · compaction-basic',
        changes: [
          { key: 'thresholdRatio', value: best.ratio },
          { key: 'headroomTokens', value: 0 },
          { key: 'retainRatio', value: retainRatio },
          { key: 'maxTokens', value: FALLBACK_MAX_TOKENS },
        ],
        effect: '新会话生效；已开会话需 /compact 或重开',
      },
    } : null,
    sweep,
    estimate: best ? {
      baselineTokens: baseline,
      projectedTokens: best.cost,
      savedTokens: Math.max(0, baseline - best.cost),
      savedPct: baseline ? Math.round(((baseline - best.cost) / baseline) * 1000) / 10 : 0,
      compactionsNow: comps.length,
      compactionsProjected: best.compactions,
      extraCompactions: Math.max(0, best.compactions - comps.length),
      peakTokens: best.peak,
    } : null,
    notes: [
      '回放假设：请求间增长取实测 delta；压缩后上下文收缩为 0.12·T + 3k 摘要。',
      '收益不含压缩后缓存重建（cacheWrite）成本，也不含摘要质量变化。',
      '当前路由压缩次数为 0 不代表没问题——基数越大，每条请求都在为上下文付费。',
    ],
  })

  // 2) cache
  const warmTtl = Math.max(300_000, Math.round((gapP90 * 1.5) / 60_000) * 60_000)
  modules.push({
    id: 'cache',
    title: '缓存策略',
    scope: '全模型',
    status: cacheShare !== null && cacheShare < 60 ? 'warn' : 'ok',
    headline: cacheShare === null
      ? '没有 usage 数据'
      : cacheShare >= 80 && over5 < 10
        ? `命中 ${cacheShare}%、>5min 间隔占 ${over5}%：不需要保温`
        : `命中 ${cacheShare}%、>5min 间隔占 ${over5}%：可考虑保温`,
    metrics: [
      { label: 'cacheRead 占比', value: cacheShare === null ? '—' : `${cacheShare}%` },
      { label: '请求间隔 p50 / p90', value: `${Math.round(gapP50 / 1000)}s / ${Math.round(gapP90 / 1000)}s` },
      { label: '>5min 间隔', value: `${over5}%` },
      { label: 'cacheWrite', value: fmt(cacheWrite) },
    ],
    recommendation: cacheShare !== null && (cacheShare < 60 || over5 >= 10) ? {
      title: `装保温并设 TTL ≥ ${Math.round(warmTtl / 60_000)} 分钟`,
      detail: '仅在长工具执行/长时间停顿的会话里值得；命中已很高时不装更省。',
      apply: null,
    } : {
      title: '不装保温（当前配置已最优）',
      detail: '缓存命中高、间隔短，保温只会增加无谓请求。',
      apply: null,
    },
    notes: ['缓存策略无法一键写入：保温需要 dsh-warm 之类的运行时插件，本插件的建议是“装/不装”。'],
  })

  // 3) tools
  modules.push({
    id: 'tools',
    title: '工具面',
    scope: 'system prompt 固定开销',
    status: 'ok',
    headline: toolsTokens
      ? `工具声明中位 ${fmt(toolsTokens)} tokens；PTC 模式下按需暴露，暂不建议动`
      : '未采集到工具声明',
    metrics: [
      { label: '工具声明 tokens（中位）', value: toolsTokens ? fmt(toolsTokens) : '—' },
      { label: '占 prompt p50', value: promptP50 && toolsTokens ? `${Math.round((toolsTokens / promptP50) * 100)}%` : '—' },
      { label: '调用最多的工具', value: topTools.length ? topTools.slice(0, 3).map(([k, v]) => `${k}×${v}`).join('、') : '—' },
    ],
    recommendation: {
      title: '保持现状',
      detail: 'PTC 已把工具目录折叠成一个执行器；再瘦身收益有限，且会改变可用能力面。',
      apply: null,
    },
    notes: ['若切回 standard 工具面，这项会重新变得重要。'],
  })

  // 4) model
  const efforts = {}
  for (const s of sessions) if (s.effort) efforts[s.effort] = (efforts[s.effort] ?? 0) + 1
  const outRatio = sum(requests.map(r => r.prompt)) ? output / sum(requests.map(r => r.prompt)) : 0
  modules.push({
    id: 'model',
    title: '模型侧',
    scope: dominant?.model ?? '当前路由',
    status: 'ok',
    headline: `输出/输入比 ${(outRatio * 100).toFixed(2)}%，effort 分布 ${Object.entries(efforts).map(([k, v]) => `${k}×${v}`).join('、') || '—'}`,
    metrics: [
      { label: '输出 tokens', value: fmt(output) },
      { label: '输出/总 prompt', value: `${(outRatio * 100).toFixed(2)}%` },
      { label: 'effort', value: Object.keys(efforts).join('、') || '—' },
      { label: '会话数', value: String(sessions.length) },
    ],
    recommendation: {
      title: '暂不建议改档',
      detail: '样本还不足以区分“任务难”与“档位过高”；跑够一周的后再给结论。',
      apply: null,
    },
    notes: ['思考档与任务难度强相关，单周数据下结论容易误伤。'],
  })

  return {
    ok: true,
    generatedAt: Date.now(),
    window: { days, sessions: sessions.length, requests: requests.length, gaps: gaps.length },
    totals: { prompt: sum(requests.map(r => r.prompt)), cacheRead, uncached, cacheWrite, output },
    context: { window: W, reserved, model: dominant?.model ?? '' },
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

// The inherited preset (bundle defaults of the running DSH) with our
// compaction-basic config carried over; null when there is nothing to rebuild on.
function rebuildOnInherited(current, inherited) {
  if (!Array.isArray(inherited?.plugins)) return null
  const next = structuredClone(inherited)
  const row = findCompactionRow(next.plugins)
  if (!row) return null
  const own = findCompactionRow(current?.plugins)
  if (own?.config === undefined) delete row.config
  else row.config = structuredClone(own.config)
  return next
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
    if (!findCompactionRow(current?.plugins) || !Array.isArray(conf.inherited?.plugins)) continue
    const id = current?.id ?? null
    const next = rebuildOnInherited(current, conf.inherited)
    if (!next) {
      results.push({ id, ok: false, reason: '默认 preset 里没有 compaction-basic 行，保持原样' })
      continue
    }
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
    ? `preset ${r.id} 已按当前 DSH 默认重建（只保留压缩参数）` +
      (r.dropped.length ? `，移除 ${r.dropped.join(', ')}` : '') +
      (r.added.length ? `，新增 ${r.added.join(', ')}` : '')
    : `preset ${r.id} 未能重建：${r.reason}`).join('；')
}

function policyOf(config) {
  const c = config && typeof config === 'object' ? config : {}
  return {
    explicit: Object.keys(c),
    thresholdRatio: typeof c.thresholdRatio === 'number' ? c.thresholdRatio : null,
    headroomTokens: typeof c.headroomTokens === 'number' ? c.headroomTokens : null,
    retainRatio: typeof c.retainRatio === 'number' ? c.retainRatio : null,
    retainTokens: typeof c.retainTokens === 'number' ? c.retainTokens : null,
    maxTokens: typeof c.maxTokens === 'number' ? c.maxTokens : null,
    modelPolicies: Array.isArray(c.modelPolicies) ? c.modelPolicies.length : 0,
    auto: typeof c.auto === 'boolean' ? c.auto : null,
  }
}

function effectivePolicy(policy, window, reserved) {
  const W = num(window, 0)
  const R = Math.max(0, num(reserved, 0))
  if (!W) return null
  const ratio = num(policy.thresholdRatio, DEFAULTS.thresholdRatio)
  const headroom = num(policy.headroomTokens, DEFAULTS.headroomTokens)
  const retainRatio = num(policy.retainRatio, DEFAULTS.retainRatio)
  const messageBudget = W - R
  const pressureBudget = messageBudget - headroom
  const thresholdTokens = Math.floor(Math.min(W * ratio, pressureBudget))
  const retainTokens = typeof policy.retainTokens === 'number'
    ? policy.retainTokens
    : Math.floor(messageBudget * retainRatio)
  return { window: W, reserved: R, thresholdTokens, retainTokens, valid: pressureBudget > 0 && retainTokens < thresholdTokens }
}

function describePolicy(policy) {
  return [
    `${Math.round(num(policy.thresholdRatio, DEFAULTS.thresholdRatio) * 100)}%`,
    `headroom ${fmt(num(policy.headroomTokens, DEFAULTS.headroomTokens))}`,
    `retain ${Math.round(num(policy.retainRatio, DEFAULTS.retainRatio) * 100)}%`,
  ].join(' / ')
}

async function readPreset(ctx, window, reserved) {
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
  const base = {
    id,
    name: meta.name ?? null,
    order: meta.order ?? null,
    isDefault: true,
    broken: meta.broken ?? null,
    window,
    reserved,
  }
  if (!target) {
    return {
      ...base,
      available: false,
      reason: '当前 preset 的配置行不可编辑（可能由 home patch / 命令行覆盖提供）',
    }
  }
  const conf = editor.configuration().find(r => r.entry === target)
  const currentRow = findCompactionRow(target.options.config?.plugins)
  const inheritedRow = conf ? findCompactionRow(conf.inherited?.plugins) : null
  const current = policyOf(currentRow?.config)
  const inherited = policyOf(inheritedRow?.config)
  return {
    ...base,
    available: true,
    writeTarget: editor.documentPath,
    current,
    inherited,
    effective: effectivePolicy(current, window, reserved),
    inheritedEffective: effectivePolicy(inherited, window, reserved),
    currentText: describePolicy(current),
    inheritedText: describePolicy(inherited),
    hasOverride: Object.keys(conf?.override ?? {}).length > 0,
    addressable: true,
  }
}

async function writeCompaction(ctx, values) {
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
  const beforeRow = findCompactionRow(beforeRaw.plugins)
  const before = policyOf(beforeRow?.config)

  await editor.edit(target, (current, inherited) => {
    const next = rebuildOnInherited(current, inherited) ?? structuredClone(current ?? {})
    const row = findCompactionRow(next.plugins)
    if (!row) throw new Error(`preset ${id} 里没有 ${COMPACTION_PLUGIN} 行，拒绝写入`)
    const cfg = { ...(row.config && typeof row.config === 'object' ? row.config : {}) }
    delete cfg.retainTokens
    cfg.thresholdRatio = values.thresholdRatio
    cfg.headroomTokens = values.headroomTokens
    cfg.retainRatio = values.retainRatio
    if (typeof cfg.maxTokens !== 'number' || cfg.maxTokens < 1) cfg.maxTokens = FALLBACK_MAX_TOKENS
    row.config = cfg
    return next
  })

  const afterTarget = findTarget()
  const after = policyOf(findCompactionRow(afterTarget?.options.config?.plugins)?.config)
  const verified =
    after.thresholdRatio === values.thresholdRatio &&
    after.headroomTokens === values.headroomTokens &&
    after.retainRatio === values.retainRatio &&
    after.retainTokens === null

  if (!verified) {
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
  const target = editor.entries().find(
    e => e.options.name === PRESET_PLUGIN && e.options.config?.id === id,
  )
  if (!target) throw new Error('当前 preset 的配置行不可编辑')
  const before = policyOf(findCompactionRow(target.options.config?.plugins)?.config)
  await editor.edit(target, (current, inherited) => {
    // Equal to inherited, so configEditor drops the override row entirely.
    if (Array.isArray(inherited?.plugins)) return structuredClone(inherited)
    const next = structuredClone(current ?? {})
    const row = findCompactionRow(next.plugins)
    if (!row) throw new Error(`preset ${id} 里没有 ${COMPACTION_PLUGIN} 行`)
    const inhRow = findCompactionRow(inherited?.plugins)
    if (inhRow?.config === undefined) delete row.config
    else row.config = structuredClone(inhRow.config)
    return next
  })
  const afterTarget = editor.entries().find(
    e => e.options.name === PRESET_PLUGIN && e.options.config?.id === id,
  )
  const after = policyOf(findCompactionRow(afterTarget?.options.config?.plugins)?.config)
  return { ok: true, before, after }
}

function validateValues(v) {
  const thresholdRatio = Number(v.thresholdRatio)
  const headroomTokens = Number(v.headroomTokens)
  const retainRatio = Number(v.retainRatio)
  if (!Number.isFinite(thresholdRatio) || thresholdRatio <= 0.2 || thresholdRatio >= 0.9) {
    throw new Error('thresholdRatio 必须在 0.2–0.9 之间（建议 0.3–0.6）')
  }
  if (!Number.isInteger(headroomTokens) || headroomTokens < 0) throw new Error('headroomTokens 必须是非负整数')
  if (!Number.isFinite(retainRatio) || retainRatio <= 0 || retainRatio >= thresholdRatio) {
    throw new Error('retainRatio 必须大于 0 且小于 thresholdRatio')
  }
  return { thresholdRatio, headroomTokens, retainRatio }
}

function formatText(report) {
  if (!report?.ok) return `调优报告不可用：${report?.error ?? '未知错误'}`
  const out = []
  out.push(`调优报告 · 近 ${report.window.days} 天 · ${report.window.sessions} 会话 / ${report.window.requests} 请求`)
  for (const m of report.modules) {
    out.push('')
    out.push(`【${m.title}】${m.status === 'warn' ? '值得调' : '无需调'}`)
    out.push(m.headline)
    for (const x of m.metrics ?? []) out.push(`· ${x.label}: ${x.value}`)
    if (m.preset?.rebaseText) out.push(`· ${m.preset.rebaseText}`)
    if (m.preset?.available) {
      out.push(`· preset ${m.preset.id}: ${m.preset.currentText}（默认 ${m.preset.inheritedText}）`)
      if (m.preset.effective) out.push(`  当前阈值 ≈${fmt(m.preset.effective.thresholdTokens)}，保留 ≈${fmt(m.preset.effective.retainTokens)}`)
    } else if (m.preset) {
      out.push(`· preset: ${m.preset.reason ?? '不可用'}`)
    }
    if (m.estimate) {
      out.push(`  收益预估：省 ${fmt(m.estimate.savedTokens)} prompt tokens（${m.estimate.savedPct}%），压缩 ${m.estimate.compactionsNow} → ${m.estimate.compactionsProjected} 次`)
    }
    if (m.recommendation) {
      out.push(`→ ${m.recommendation.title}`)
      out.push(`  ${m.recommendation.detail}`)
      if (m.recommendation.apply) {
        out.push(`  写入 ${m.recommendation.apply.target}（${m.recommendation.apply.effect}）`)
        out.push('  ' + m.recommendation.apply.changes.map(c => `${c.key}=${c.value}`).join('  '))
      }
    }
    if (m.sweep) {
      out.push('  阈值回放: ' + m.sweep.map(r => `${Math.round(r.ratio * 100)}%→${r.costRatio}×/${r.compactions}次/${fmt(r.peak)}`).join('  '))
    }
  }
  return out.join('\n')
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
    const records = (await query.listSessions()).filter(
      r => r?.header?.createdAt >= since && !r.header?.parentSession,
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
      value = buildReport(sessions, days)
      const compaction = value.modules.find(m => m.id === 'compaction')
      try {
        compaction.preset = await readPreset(ctx, value.context.window, value.context.reserved)
      } catch (err) {
        compaction.preset = { available: false, reason: String(err?.message ?? err) }
      }
      compaction.preset.rebaseText = describeRebase(lastRebase)
      if (compaction.preset?.available && compaction.recommendation) {
        const proposed = {
          thresholdRatio: compaction.recommendation.apply.changes.find(c => c.key === 'thresholdRatio')?.value,
          headroomTokens: compaction.recommendation.apply.changes.find(c => c.key === 'headroomTokens')?.value,
          retainRatio: compaction.recommendation.apply.changes.find(c => c.key === 'retainRatio')?.value,
        }
        compaction.proposed = {
          ...proposed,
          effective: effectivePolicy(proposed, value.context.window, value.context.reserved),
        }
        const cur = compaction.preset.current
        compaction.applied =
          cur.thresholdRatio === proposed.thresholdRatio &&
          cur.headroomTokens === proposed.headroomTokens &&
          cur.retainRatio === proposed.retainRatio &&
          cur.retainTokens === null
      }
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
      let values
      if (body && (body.thresholdRatio !== undefined || body.retainRatio !== undefined)) {
        values = validateValues(body)
      } else {
        const r = await report(14, 60)
        if (!r.ok) throw new Error(r.error ?? '没有可用的建议值')
        const m = r.modules.find(x => x.id === 'compaction')
        if (!m?.recommendation?.apply) throw new Error('当前没有可应用的压缩建议')
        values = validateValues(Object.fromEntries(
          m.recommendation.apply.changes.map(c => [c.key, c.value]),
        ))
      }
      const result = await writeCompaction(ctx, values)
      clearCache()
      return {
        ok: result.ok,
        action: 'apply',
        values,
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
          const preset = await readPreset(ctx, 0, 0)
          return Response.json({ ok: true, preset, rebase: lastRebase }, { headers: { 'cache-control': 'no-store' } })
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
