/**
 * dsh-tuner — Client half (Web UI).
 *
 * Registers a sidebar entry ("调优") and its main panel. The panel reads the
 * Host report from /api/dsh-tuner/report.
 *
 * v0.5: an overview grid shows every module with its status and key numbers on
 * one screen; a module opens into a detail view (recommendations, tables,
 * replay, notes). Colours come from the client's design tokens
 * (--dsw-alias-*, redefined under body[data-ds-dark-theme]), so light and dark
 * both read. The compaction module keeps the two-step write to the active
 * agent preset through /api/dsh-tuner/apply.
 *
 * NOTE: React only accepts object style values; a CSS string in `style` throws
 * React error #62 and blanks the whole slot entry. All styling here is class
 * names plus one <style> element.
 */
window.__ModuleLoader__.load({
  id: 'dsh-tuner',
  factory: e => {
    var t = { exports: {} }
    t.exports

    const ReactMod = e('react')
    const pickReact = m => {
      const cands = [m, m && m.default, m && m.exports, m && m.exports && m.exports.default]
      for (const c of cands) if (c && typeof c.createElement === 'function') return c
      return m
    }
    const React = pickReact(ReactMod)
    const h = React.createElement
    const { useState, useEffect, useCallback } = React

    const CSS = `
.tn-root { --tn-fg: var(--dsw-alias-label-primary); --tn-mute: var(--dsw-alias-label-secondary, rgba(127,127,127,.95)); --tn-faint: var(--dsw-alias-label-tertiary, rgba(127,127,127,.7)); --tn-line: var(--dsw-alias-border-l1, rgba(127,127,127,.16)); --tn-line2: var(--dsw-alias-border-l2, rgba(127,127,127,.28)); --tn-card: var(--dsw-alias-bg-layer-1, transparent); --tn-fill: rgba(127,127,127,.07); --tn-hover: rgba(127,127,127,.1); --tn-ok: var(--dsw-alias-state-success-primary, #2f9e65); --tn-warn: var(--dsw-alias-state-warn-primary, #d08a1e); --tn-bad: var(--dsw-alias-state-error-primary, #d9503c); --tn-accent: var(--dsw-alias-state-business-primary, #3b82f6); --tn-mono: var(--dsw-font-family-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  container-type: inline-size; width: 100%; min-width: 0; flex: 1 1 auto; height: 100%; min-height: 320px; overflow: auto; box-sizing: border-box; padding: 22px 28px 48px; font-size: 13px; line-height: 1.55; color: var(--tn-fg); }
.tn-root *, .tn-root *::before { box-sizing: border-box; }
.tn-view { max-width: 1640px; }
.tn-detail { max-width: 1180px; }
.tn-top { display: flex; align-items: flex-start; gap: 16px; margin-bottom: 18px; }
.tn-top-main { flex: 1; min-width: 0; }
.tn-h1 { margin: 0; font-size: 20px; font-weight: 650; letter-spacing: .2px; }
.tn-sub { margin-top: 4px; font-size: 12px; color: var(--tn-mute); }
.tn-controls { display: flex; gap: 8px; align-items: center; flex-shrink: 0; }
.tn-select, .tn-btn { font: inherit; font-size: 12px; color: inherit; background: transparent; border: 1px solid var(--tn-line2); border-radius: 8px; padding: 5px 11px; cursor: pointer; }
.tn-btn:hover, .tn-select:hover { background: var(--tn-hover); }
.tn-btn[disabled] { opacity: .5; cursor: default; background: transparent; }
.tn-btn-primary { border-color: color-mix(in srgb, var(--tn-ok) 55%, transparent); background: color-mix(in srgb, var(--tn-ok) 12%, transparent); }
.tn-btn-primary:hover { background: color-mix(in srgb, var(--tn-ok) 20%, transparent); }
.tn-summary { display: flex; flex-wrap: wrap; gap: 8px; margin: 0 0 16px; }
.tn-chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--tn-mute); padding: 3px 10px; border-radius: 999px; background: var(--tn-fill); }
.tn-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c, var(--tn-faint)); flex-shrink: 0; }
.s-ok { --c: var(--tn-ok); } .s-warn { --c: var(--tn-warn); } .s-bad { --c: var(--tn-bad); } .s-pending { --c: var(--tn-accent); } .s-info { --c: var(--tn-faint); }
.tn-pill { display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; font-size: 11.5px; font-weight: 550; line-height: 20px; padding: 0 9px; border-radius: 999px; color: var(--c); background: color-mix(in srgb, var(--c) 13%, transparent); }
.tn-grid { display: grid; gap: 14px; grid-template-columns: repeat(6, minmax(0, 1fr)); }
.tn-tile { grid-column: span 2; position: relative; display: flex; flex-direction: column; gap: 10px; text-align: left; font: inherit; color: inherit; cursor: pointer; padding: 16px 18px 14px; border-radius: 14px; border: 1px solid var(--tn-line2); background: var(--tn-card); overflow: hidden; transition: border-color .15s, box-shadow .15s, transform .15s; }
.tn-tile.tn-wide { grid-column: span 3; }
.tn-tile::before { content: ""; position: absolute; left: 0; top: 0; right: 0; height: 3px; background: var(--c, transparent); opacity: .85; }
.tn-tile:hover { border-color: color-mix(in srgb, var(--c, var(--tn-line2)) 45%, var(--tn-line2)); box-shadow: 0 6px 20px rgba(0,0,0,.07); transform: translateY(-1px); }
.tn-tile:focus-visible { outline: 2px solid var(--tn-accent); outline-offset: 2px; }
.tn-tile-head { display: flex; align-items: center; gap: 9px; }
.tn-icon { width: 30px; height: 30px; border-radius: 9px; display: inline-flex; align-items: center; justify-content: center; color: var(--c, var(--tn-mute)); background: color-mix(in srgb, var(--c, var(--tn-faint)) 12%, transparent); flex-shrink: 0; }
.tn-tile-title { font-size: 15px; font-weight: 620; }
.tn-scope { font-size: 11px; color: var(--tn-faint); }
.tn-grow { flex: 1; }
.tn-headline { margin: 0; font-size: 13px; line-height: 1.55; color: var(--tn-fg); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; min-height: 3.1em; }
.tn-kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; padding: 4px 0 12px; border-bottom: 1px solid var(--tn-line); }
.tn-kpi { min-width: 0; }
.tn-kpi-label { font-size: 11px; color: var(--tn-mute); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tn-kpi-value { margin-top: 2px; font-size: 18px; font-weight: 640; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tn-kpi-value.t-warn { color: var(--tn-warn); } .tn-kpi-value.t-ok { color: var(--tn-ok); }
.tn-kpi-hint { margin-top: 1px; font-size: 11px; color: var(--tn-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tn-points { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.tn-points li { display: flex; align-items: baseline; gap: 8px; font-size: 12.5px; line-height: 1.5; min-width: 0; }
.tn-points li .tn-dot { transform: translateY(-1px); }
.tn-point-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tn-more { padding-left: 15px; font-size: 11.5px; }
.tn-tile-foot { display: flex; align-items: center; gap: 6px; margin-top: auto; padding-top: 6px; font-size: 12px; color: var(--tn-faint); }
.tn-tile:hover .tn-tile-foot { color: var(--tn-fg); }
.tn-count { color: var(--c, var(--tn-mute)); font-weight: 550; }
.tn-back { display: inline-flex; align-items: center; gap: 4px; font: inherit; font-size: 12.5px; color: var(--tn-mute); background: transparent; border: 0; padding: 4px 6px 4px 2px; border-radius: 6px; cursor: pointer; }
.tn-back:hover { color: var(--tn-fg); background: var(--tn-hover); }
.tn-tabs { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0 18px; }
.tn-tab { display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; color: var(--tn-mute); background: transparent; border: 1px solid var(--tn-line); border-radius: 999px; padding: 3px 11px; cursor: pointer; }
.tn-tab:hover { background: var(--tn-hover); }
.tn-tab.on { color: var(--tn-fg); border-color: var(--tn-line2); background: var(--tn-fill); font-weight: 550; }
.tn-detail-head { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
.tn-detail-head .tn-icon { width: 38px; height: 38px; border-radius: 11px; }
.tn-h2 { margin: 0; font-size: 19px; font-weight: 650; }
.tn-lead { margin: 4px 0 18px; font-size: 14px; line-height: 1.6; }
.tn-kpi-row { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 10px; margin-bottom: 22px; }
.tn-kpi-card { padding: 11px 14px; border-radius: 11px; background: var(--tn-fill); }
.tn-section { margin: 0 0 22px; }
.tn-section-title { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; font-size: 12px; font-weight: 600; letter-spacing: .4px; color: var(--tn-mute); }
.tn-section-title::after { content: ""; flex: 1; height: 1px; background: var(--tn-line); }
.tn-recs { display: flex; flex-direction: column; gap: 10px; }
.tn-rec { position: relative; padding: 12px 14px 12px 16px; border-radius: 11px; background: var(--tn-fill); border-left: 3px solid var(--c, var(--tn-faint)); }
.tn-rec-head { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.tn-rec-title { font-size: 13.5px; font-weight: 620; }
.tn-rec-detail { margin: 0; font-size: 12.5px; line-height: 1.65; color: var(--tn-mute); }
.tn-rec-how { margin: 8px 0 0; font-size: 12.5px; }
.tn-code { position: relative; margin: 8px 0 0; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--tn-line); background: var(--tn-card); font-family: var(--tn-mono); font-size: 11.5px; line-height: 1.6; white-space: pre-wrap; word-break: break-all; }
.tn-copy { position: absolute; top: 6px; right: 6px; font: inherit; font-size: 11px; color: var(--tn-mute); background: var(--tn-fill); border: 1px solid var(--tn-line); border-radius: 6px; padding: 1px 7px; cursor: pointer; }
.tn-copy:hover { color: var(--tn-fg); }
.tn-apply { margin-top: 12px; padding: 12px 14px; border-radius: 11px; border: 1px dashed var(--tn-line2); font-size: 12px; line-height: 1.65; }
.tn-apply-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.tn-muted { color: var(--tn-mute); } .tn-faint { color: var(--tn-faint); }
.tn-mono { font-family: var(--tn-mono); font-size: 11.5px; word-break: break-all; }
.tn-msg { margin-top: 8px; font-size: 12px; line-height: 1.6; color: var(--c); }
.tn-banner { margin: 0 0 14px; padding: 9px 12px; border-radius: 9px; font-size: 12.5px; color: var(--c); background: color-mix(in srgb, var(--c) 10%, transparent); }
.tn-table-wrap { overflow-x: auto; border: 1px solid var(--tn-line); border-radius: 11px; }
.tn-table-title { margin: 0 0 6px; font-size: 12px; color: var(--tn-mute); }
.tn-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.tn-table th { text-align: left; font-weight: 550; color: var(--tn-mute); background: var(--tn-fill); padding: 7px 10px; white-space: nowrap; }
.tn-table td { padding: 7px 10px; border-top: 1px solid var(--tn-line); vertical-align: top; font-variant-numeric: tabular-nums; }
.tn-table td:first-child { font-weight: 550; white-space: nowrap; }
.tn-table tr:hover td { background: var(--tn-hover); }
.tn-details { margin: 0 0 8px; border: 1px solid var(--tn-line); border-radius: 10px; padding: 0 12px; }
.tn-details > summary { cursor: pointer; padding: 8px 0; font-size: 12.5px; color: var(--tn-mute); }
.tn-details[open] > summary { color: var(--tn-fg); }
.tn-details .tn-table-wrap { margin-bottom: 12px; }
.tn-notes { margin: 0; padding-left: 18px; font-size: 11.5px; line-height: 1.7; color: var(--tn-faint); }
.tn-loading { display: flex; align-items: center; gap: 10px; padding: 30px 0; color: var(--tn-mute); }
.tn-spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--tn-line2); border-top-color: var(--tn-fg); animation: tn-spin .8s linear infinite; }
@keyframes tn-spin { to { transform: rotate(360deg); } }
@container (max-width: 1040px) { .tn-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .tn-tile, .tn-tile.tn-wide { grid-column: span 1; } }
@container (max-width: 640px) { .tn-grid { grid-template-columns: 1fr; } .tn-root { padding: 16px; } .tn-top { flex-direction: column; } }
`

    const STATUS = {
      ok: '正常', warn: '建议调整', bad: '有问题', pending: '待观察', info: '仅观测',
    }
    const SEVERITY = { bad: 0, warn: 1, pending: 2, ok: 3, info: 4 }
    const TONE = { do: { text: '建议', s: 'warn' }, info: { text: '提示', s: 'pending' }, ok: { text: '无需调', s: 'ok' } }
    const WIDE = { compaction: true, health: true }
    const ORDER = ['compaction', 'health', 'model', 'tools', 'cache']

    const GLYPH = {
      compaction: ['M4 14h6v6', 'M20 10h-6V4', 'M14 10l7-7', 'M3 21l7-7'],
      health: ['M3 12h4l3-8 4 16 3-8h4'],
      cache: ['M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z', 'M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6', 'M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'],
      model: ['M7 7h10v10H7z', 'M10 3v4', 'M14 3v4', 'M10 17v4', 'M14 17v4', 'M3 10h4', 'M3 14h4', 'M17 10h4', 'M17 14h4'],
      tools: ['M14.7 6.3a4 4 0 0 0-5.4 5.4L3.6 17.4a1.4 1.4 0 0 0 0 2l1 1a1.4 1.4 0 0 0 2 0l5.7-5.7a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.3-.6-.6-2.3z'],
    }

    function Glyph({ id, size }) {
      const s = size || 17
      return h('svg', { width: s, height: s, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' },
        ...(GLYPH[id] || GLYPH.health).map((d, i) => h('path', { key: i, d })))
    }

    function Chevron({ left }) {
      return h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
        h('path', { d: left ? 'M15 6l-6 6 6 6' : 'M9 6l6 6-6 6' }))
    }

    function Pill({ status, text }) {
      return h('span', { className: 'tn-pill s-' + (status || 'info') }, h('span', { className: 'tn-dot' }), text || STATUS[status] || status)
    }

    function Kpi({ k, card }) {
      return h('div', { className: card ? 'tn-kpi tn-kpi-card' : 'tn-kpi', title: k.hint ? k.label + '：' + k.value + '（' + k.hint + '）' : undefined },
        h('div', { className: 'tn-kpi-label' }, k.label),
        h('div', { className: 'tn-kpi-value' + (k.tone ? ' t-' + k.tone : '') }, k.value),
        k.hint ? h('div', { className: 'tn-kpi-hint' }, k.hint) : null)
    }

    const kpisOf = m => (m.kpis && m.kpis.length ? m.kpis : (m.metrics || []).slice(0, 3))
    const doCount = m => (m.recommendations || []).filter(r => r.tone === 'do').length

    function Tile({ m, onOpen }) {
      const n = doCount(m)
      const recs = m.recommendations || []
      return h('button', {
        className: 'tn-tile s-' + m.status + (WIDE[m.id] ? ' tn-wide' : ''),
        onClick: () => onOpen(m.id),
        title: '查看「' + m.title + '」详情',
      },
        h('div', { className: 'tn-tile-head' },
          h('span', { className: 'tn-icon' }, h(Glyph, { id: m.id })),
          h('div', null, h('div', { className: 'tn-tile-title' }, m.title), h('div', { className: 'tn-scope' }, m.scope)),
          h('span', { className: 'tn-grow' }),
          h(Pill, { status: m.status })),
        h('div', { className: 'tn-kpis' }, ...kpisOf(m).slice(0, 3).map((k, i) => h(Kpi, { key: i, k }))),
        recs.length
          ? h('ul', { className: 'tn-points' }, ...recs.slice(0, 3).map((r, i) => h('li', { key: i, className: 's-' + (TONE[r.tone] || TONE.info).s },
              h('span', { className: 'tn-dot' }), h('span', { className: 'tn-point-text' }, r.title))),
            recs.length > 3 ? h('li', { key: 'more', className: 'tn-faint tn-more' }, '还有 ' + (recs.length - 3) + ' 条') : null)
          : h('p', { className: 'tn-headline' }, m.headline),
        h('div', { className: 'tn-tile-foot' },
          n ? h('span', { className: 'tn-count' }, n + ' 条建议') : h('span', null, (m.recommendations || []).length ? '查看结论' : '查看数据'),
          h('span', { className: 'tn-grow' }),
          '详情', h(Chevron)))
    }

    function Copy({ text }) {
      const [done, setDone] = useState(false)
      const onClick = async () => {
        try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500) } catch {}
      }
      return h('button', { className: 'tn-copy', onClick }, done ? '已复制' : '复制')
    }

    function Rec({ r }) {
      const tone = TONE[r.tone] || TONE.info
      return h('div', { className: 'tn-rec s-' + tone.s },
        h('div', { className: 'tn-rec-head' }, h(Pill, { status: tone.s, text: tone.text }), h('span', { className: 'tn-rec-title' }, r.title)),
        r.detail ? h('p', { className: 'tn-rec-detail' }, r.detail) : null,
        r.how ? h('p', { className: 'tn-rec-how' }, r.how) : null,
        r.config ? h('div', { className: 'tn-code' }, r.config, h(Copy, { text: r.config })) : null)
    }

    function Table({ t }) {
      return h('div', null,
        t.title ? h('div', { className: 'tn-table-title' }, t.title) : null,
        h('div', { className: 'tn-table-wrap' },
          h('table', { className: 'tn-table' },
            h('thead', null, h('tr', null, ...t.columns.map((c, i) => h('th', { key: i }, c)))),
            h('tbody', null, ...t.rows.map((r, i) => h('tr', { key: i }, ...r.map((c, j) => h('td', { key: j }, String(c)))))))))
    }

    function Section({ title, children }) {
      return h('div', { className: 'tn-section' }, h('div', { className: 'tn-section-title' }, title), children)
    }

    function ApplyBox({ m, act, confirm, onAsk, onCancel, onConfirm, onRevert }) {
      const preset = m.preset
      if (!preset) return null
      const rec = (m.recommendations || []).find(r => r.apply)
      const busy = act && act.status === 'working'
      const rows = []
      if (preset.rebaseText) rows.push(h('div', { key: 'rb', className: 'tn-msg s-warn' }, preset.rebaseText))
      if (preset.available) {
        rows.push(h('div', { key: 'cur' }, 'preset ', h('b', null, preset.id), '：顶层 ' + preset.currentText, h('span', { className: 'tn-faint' }, '（默认 ' + preset.inheritedText + '）')))
        rows.push(h('div', { key: 'per', className: 'tn-muted' }, (preset.currentPolicies || []).length ? '按模型：' + preset.currentPolicies.join('、') : '按模型：无（所有模型用顶层）'))
        if (rec && rec.apply) {
          rows.push(h('div', { key: 'ch', className: 'tn-muted' }, '写入 ' + rec.apply.target + ' · ' + rec.apply.effect))
          rows.push(h('div', { key: 'chv', className: 'tn-mono' }, rec.apply.changes.length ? rec.apply.changes.map(c => c.key + ': ' + c.value).join('；') : '不写按模型策略（全部模型用官方默认）'))
        }
        if (preset.writeTarget) rows.push(h('div', { key: 'path', className: 'tn-mono tn-faint' }, preset.writeTarget))
        if (preset.broken) rows.push(h('div', { key: 'br', className: 'tn-msg s-bad' }, 'preset 当前激活异常：' + preset.broken))
        const btns = []
        if (busy) btns.push(h('button', { key: 'b', className: 'tn-btn', disabled: true }, act.message || '写入中…'))
        else if (confirm) {
          btns.push(h('button', { key: 'ok', className: 'tn-btn tn-btn-primary', onClick: onConfirm }, '确认写入'))
          btns.push(h('button', { key: 'no', className: 'tn-btn', onClick: onCancel }, '取消'))
          btns.push(h('span', { key: 'hint', className: 'tn-faint' }, '会改当前 preset 的压缩配置，只影响新会话'))
        } else if (m.applied) {
          btns.push(h('button', { key: 'done', className: 'tn-btn', disabled: true }, '已是建议值'))
          btns.push(h('button', { key: 'rv', className: 'tn-btn', onClick: onRevert }, '恢复 preset 默认'))
        } else {
          btns.push(h('button', { key: 'ap', className: 'tn-btn tn-btn-primary', onClick: onAsk, disabled: !rec }, '应用按模型建议'))
          if (preset.hasOverride) btns.push(h('button', { key: 'rv2', className: 'tn-btn', onClick: onRevert }, '恢复 preset 默认'))
        }
        rows.push(h('div', { key: 'btns', className: 'tn-apply-row' }, ...btns))
      } else {
        rows.push(h('div', { key: 'na', className: 'tn-msg s-warn' }, '无法定位可写的 preset：' + (preset.reason || '未知原因')))
      }
      if (act && act.status !== 'working') rows.push(h('div', { key: 'act', className: 'tn-msg s-' + (act.status === 'error' ? 'bad' : 'ok') }, act.message))
      return h('div', { className: 'tn-apply' }, ...rows)
    }

    function Detail({ m, modules, onOpen, onBack, apply }) {
      const kpis = [...(m.kpis || []), ...(m.metrics || []).filter(x => !(m.kpis || []).some(k => k.label === x.label))]
      return h('div', { className: 'tn-detail' },
        h('button', { className: 'tn-back', onClick: onBack }, h(Chevron, { left: true }), '全部模块'),
        h('div', { className: 'tn-tabs' }, ...modules.map(x => h('button', {
          key: x.id, className: 'tn-tab s-' + x.status + (x.id === m.id ? ' on' : ''), onClick: () => onOpen(x.id),
        }, h('span', { className: 'tn-dot' }), x.title))),
        h('div', { className: 'tn-detail-head s-' + m.status },
          h('span', { className: 'tn-icon' }, h(Glyph, { id: m.id, size: 20 })),
          h('div', null, h('h2', { className: 'tn-h2' }, m.title), h('div', { className: 'tn-scope' }, m.scope)),
          h('span', { className: 'tn-grow' }),
          h(Pill, { status: m.status })),
        h('p', { className: 'tn-lead' }, m.headline),
        kpis.length ? h('div', { className: 'tn-kpi-row' }, ...kpis.map((k, i) => h(Kpi, { key: i, k, card: true }))) : null,
        (m.recommendations || []).length || m.preset ? h(Section, { title: '结论与建议' },
          h('div', { className: 'tn-recs' }, ...(m.recommendations || []).map((r, i) => h(Rec, { key: i, r }))),
          m.id === 'compaction' ? h(ApplyBox, { m, ...apply }) : null) : null,
        (m.tables || []).length ? h(Section, { title: '数据' }, ...m.tables.map((tb, i) => h(Table, { key: i, t: tb }))) : null,
        (m.details || []).length ? h(Section, { title: '明细' }, ...m.details.map((tb, i) => h('details', { key: i, className: 'tn-details' },
          h('summary', null, tb.title), h(Table, { t: { ...tb, title: '' } })))) : null,
        (m.notes || []).length ? h(Section, { title: '口径' }, h('ul', { className: 'tn-notes' }, ...m.notes.map((n, i) => h('li', { key: i }, n)))) : null)
    }

    function Overview({ d, onOpen }) {
      const counts = {}
      for (const m of d.modules) counts[m.status] = (counts[m.status] || 0) + 1
      const order = Object.keys(counts).sort((a, b) => SEVERITY[a] - SEVERITY[b])
      return h('div', { className: 'tn-view' },
        h('div', { className: 'tn-summary' }, ...order.map(s => h('span', { key: s, className: 'tn-chip s-' + s }, h('span', { className: 'tn-dot' }), counts[s] + ' 项' + STATUS[s]))),
        h('div', { className: 'tn-grid' }, ...d.modules.map(m => h(Tile, { key: m.id, m, onOpen }))))
    }

    async function post(path, body) {
      const payload = JSON.stringify(body || {})
      let lastErr = null
      for (const p of ['api' + path, '/api' + path]) {
        try {
          const res = await fetch(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: payload })
          if (!res.ok) {
            if (res.status === 401 || res.status === 403) throw new Error('路由拒绝访问（HTTP ' + res.status + '）')
            lastErr = new Error('HTTP ' + res.status)
            continue
          }
          return await res.json()
        } catch (err) {
          lastErr = err
        }
      }
      throw lastErr || new Error('路由不可达')
    }

    const side = x => '顶层 ' + ((x && x.top) || '默认') + (x && x.per && x.per.length ? '；按模型 ' + x.per.join('、') : '')

    function Panel() {
      const [days, setDays] = useState(14)
      const [loading, setLoading] = useState(true)
      const [data, setData] = useState(null)
      const [view, setView] = useState(null)
      const [act, setAct] = useState(null)
      const [confirm, setConfirm] = useState(false)

      const load = useCallback(async (n, keepAct) => {
        setLoading(true)
        if (!keepAct) { setAct(null); setConfirm(false) }
        try {
          setData(await post('/dsh-tuner/report', { days: n, maxSessions: 60 }))
        } catch (err) {
          setData({ ok: false, error: String((err && err.message) || err) })
        } finally {
          setLoading(false)
        }
      }, [])

      useEffect(() => { load(14) }, [load])

      const run = async action => {
        setConfirm(false)
        setAct({ status: 'working', message: action === 'revert' ? '正在恢复默认…' : '正在写入 preset…' })
        try {
          const r = await post('/dsh-tuner/apply', action === 'revert' ? { action: 'revert' } : { days })
          if (!r.ok) {
            setAct({ status: 'error', message: r.error ? '写入失败：' + r.error : '写入后回读不一致' + (r.rolledBack ? '，已回滚到原配置' : '，请检查 profile patch') })
          } else {
            setAct({ status: 'ok', message: (action === 'revert' ? '已恢复默认：' : '写入成功并回读校验通过：') + side(r.before) + ' → ' + side(r.after) + '。' + (r.effect || '') })
          }
          await load(days, true)
        } catch (err) {
          setAct({ status: 'error', message: '写入失败：' + String((err && err.message) || err) })
        }
      }

      const d = data
      const modules = d && d.ok ? ORDER.map(id => d.modules.find(m => m.id === id)).filter(Boolean).concat(d.modules.filter(m => !ORDER.includes(m.id))) : []
      const current = view ? modules.find(m => m.id === view) : null
      const open = id => { setView(id); setConfirm(false) }

      return h('div', { className: 'tn-root' },
        h('style', null, CSS),
        h('div', { className: 'tn-top' },
          h('div', { className: 'tn-top-main' },
            h('h1', { className: 'tn-h1' }, '调优'),
            h('div', { className: 'tn-sub' }, d && d.ok
              ? '近 ' + d.window.days + ' 天 · ' + d.window.sessions + ' 个会话 · ' + d.window.requests + ' 次请求 · ' + new Date(d.generatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' 统计'
              : '按本机真实会话给出各模块的结论与可执行建议')),
          h('div', { className: 'tn-controls' },
            h('select', { className: 'tn-select', value: days, onChange: ev => { const v = Number(ev.target.value); setDays(v); load(v) } },
              h('option', { value: 7 }, '近 7 天'), h('option', { value: 14 }, '近 14 天'), h('option', { value: 30 }, '近 30 天')),
            h('button', { className: 'tn-btn', onClick: () => load(days), disabled: loading }, loading ? '统计中…' : '刷新'))),
        loading && !(d && d.ok) ? h('div', { className: 'tn-loading' }, h('span', { className: 'tn-spin' }), '正在统计近 ' + days + ' 天的会话…') : null,
        d && d.ok === false ? h('div', { className: 'tn-banner s-bad' }, '无法生成报告：' + d.error) : null,
        d && d.ok
          ? current
            ? h(Detail, {
                m: current, modules, onOpen: open, onBack: () => setView(null),
                apply: { act, confirm, onAsk: () => { setConfirm(true); setAct(null) }, onCancel: () => setConfirm(false), onConfirm: () => run('apply'), onRevert: () => run('revert') },
              })
            : h(Overview, { d: { ...d, modules }, onOpen: open })
          : null)
    }

    function Icon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 20
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round',
      },
        h('path', { d: 'M4 7h10M18 7h2' }), h('circle', { cx: 16, cy: 7, r: 2 }),
        h('path', { d: 'M4 12h4M12 12h8' }), h('circle', { cx: 10, cy: 12, r: 2 }),
        h('path', { d: 'M4 17h8M16 17h4' }), h('circle', { cx: 14, cy: 17, r: 2 }),
      )
    }

    t.exports = {
      name: 'dsh-tuner',
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: 'dsh-tuner' }, Panel))
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register(
          { name: 'sidebar.panellist', id: 'dsh-tuner', order: 30, label: () => '调优 v0.5' },
          Icon,
        ))
      },
    }
    return t.exports
  },
})
