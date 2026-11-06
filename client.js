/**
 * dsh-tuner — Client half (Web UI).
 *
 * Registers a sidebar entry ("调优") and its main panel. The panel reads the
 * Host report from /api/dsh-tuner/report and renders one independent module card
 * per tuning area.
 *
 * v0.2: the compaction card can write the active agent preset through
 * /api/dsh-tuner/apply. The write is two-step (confirm first), reads the preset
 * state before applying, and reports the verification/rollback result.
 *
 * v0.4: cards carry generic `tables` (shown) and `details` (collapsed); the
 * compaction card writes one policy per model, and a health card reports what
 * compaction actually did.
 *
 * NOTE: React only accepts object style values. Every style here is an object;
 * a CSS string throws React error #62 and blanks the whole slot entry.
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

    const MUTE = 'var(--text-secondary, rgba(120,120,120,.95))'
    const LINE = 'var(--border-color, rgba(127,127,127,.28))'

    const S = {
      muted: { color: MUTE },
      card: { border: '1px solid ' + LINE, borderRadius: 12, padding: 16, margin: '0 0 14px' },
      page: { height: '100%', minHeight: 320, overflow: 'auto', padding: '20px 24px 48px', fontSize: 13, boxSizing: 'border-box' },
      row: { display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 4 },
      head: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
      metrics: { display: 'flex', flexWrap: 'wrap', gap: 12, marginBottom: 12 },
      metric: { minWidth: 120, flex: '1 1 140px' },
      metricLabel: { fontSize: 11, color: MUTE },
      metricValue: { fontSize: 15, fontWeight: 600, marginTop: 2 },
      metricHint: { fontSize: 11, marginTop: 2, color: MUTE },
      rec: { background: 'rgba(127,127,127,.07)', borderRadius: 9, padding: '10px 12px' },
      recTitle: { fontSize: 13, fontWeight: 600, marginBottom: 4 },
      recDetail: { fontSize: 12, lineHeight: 1.55, color: MUTE },
      applyBox: { marginTop: 8, fontSize: 11, color: MUTE },
      code: { marginTop: 6, fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, wordBreak: 'break-all' },
      presetBox: { margin: '0 0 10px', padding: '8px 10px', border: '1px dashed ' + LINE, borderRadius: 8, fontSize: 11.5, lineHeight: 1.6 },
      estimate: { display: 'flex', flexWrap: 'wrap', gap: 10, margin: '0 0 12px' },
      estimateItem: { flex: '1 1 120px', background: 'rgba(60,180,120,.10)', borderRadius: 8, padding: '6px 10px' },
      estimateLabel: { fontSize: 10.5, color: MUTE },
      estimateValue: { fontSize: 13, fontWeight: 600, marginTop: 1 },
      button: {
        marginTop: 10, marginRight: 8, fontSize: 12, padding: '5px 12px', borderRadius: 8,
        border: '1px solid ' + LINE,
        background: 'transparent', color: 'inherit', cursor: 'pointer',
      },
      buttonPrimary: {
        marginTop: 10, marginRight: 8, fontSize: 12, padding: '5px 12px', borderRadius: 8,
        border: '1px solid rgba(60,180,120,.55)',
        background: 'rgba(60,180,120,.12)', color: 'inherit', cursor: 'pointer',
      },
      buttonDisabled: {
        marginTop: 10, marginRight: 8, fontSize: 12, padding: '5px 12px', borderRadius: 8,
        border: '1px solid ' + LINE,
        background: 'transparent', color: 'inherit', opacity: 0.55, cursor: 'not-allowed',
      },
      select: {
        fontSize: 12, padding: '3px 8px', borderRadius: 7,
        border: '1px solid ' + LINE,
        background: 'transparent', color: 'inherit',
      },
      banner: { margin: '0 0 14px', padding: '9px 12px', borderRadius: 8, fontSize: 12, lineHeight: 1.55 },
      ok: { background: 'rgba(60,180,120,.12)', border: '1px solid rgba(60,180,120,.4)' },
      err: { background: 'rgba(220,80,60,.10)', border: '1px solid rgba(220,80,60,.4)' },
      notes: { margin: '10px 0 0', paddingLeft: 18, fontSize: 11, lineHeight: 1.6, color: MUTE },
      table: { borderCollapse: 'collapse', fontSize: 12, marginTop: 8, width: '100%' },
      th: { textAlign: 'left', padding: '4px 8px', fontWeight: 500, color: MUTE },
      td: { padding: '4px 8px', borderTop: '1px solid rgba(127,127,127,.18)' },
    }

    const BADGE = {
      ok: { text: '无需调', bg: 'rgba(60,180,120,.14)', fg: '#2f8f5b' },
      warn: { text: '值得调', bg: 'rgba(240,160,40,.16)', fg: '#c07a10' },
      bad: { text: '有问题', bg: 'rgba(220,80,60,.14)', fg: '#c0392b' },
      info: { text: '仅观测', bg: 'rgba(127,127,127,.14)', fg: MUTE },
    }

    function Badge({ status }) {
      const b = BADGE[status] || BADGE.ok
      return h('span', {
        style: {
          fontSize: 11, lineHeight: '18px', padding: '0 8px', borderRadius: 9, whiteSpace: 'nowrap',
          background: b.bg, color: b.fg,
        },
      }, b.text)
    }

    function Table({ t }) {
      return h('table', { style: S.table },
        h('thead', null, h('tr', null, ...t.columns.map((c, i) => h('th', { key: i, style: S.th }, c)))),
        h('tbody', null, ...t.rows.map((r, i) => h('tr', { key: i },
          ...r.map((c, j) => h('td', { key: j, style: S.td }, String(c)))))),
      )
    }

    function Metric({ label, value, hint }) {
      return h('div', { style: S.metric },
        h('div', { style: S.metricLabel }, label),
        h('div', { style: S.metricValue }, value),
        hint ? h('div', { style: S.metricHint }, hint) : null,
      )
    }

    function fmtTok(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—'
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M'
      if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k'
      return String(Math.round(n))
    }


    function PresetBox({ preset }) {
      if (!preset) return null
      const rows = []
      if (preset.rebaseText) {
        rows.push(h('div', { key: 'rebase', style: { color: '#c07a10' } }, preset.rebaseText))
      }
      if (preset.available) {
        rows.push(h('div', { key: 'cur' },
          'preset ' + preset.id + '：顶层 ' + preset.currentText + '（默认 ' + preset.inheritedText + '）'))
        rows.push(h('div', { key: 'per', style: { color: MUTE } },
          (preset.currentPolicies || []).length ? '按模型：' + preset.currentPolicies.join('、') : '按模型：无（所有模型用顶层）'))
        if (preset.writeTarget) {
          rows.push(h('div', { key: 'path', style: S.code }, '写入 ' + preset.writeTarget))
        }
        if (preset.broken) {
          rows.push(h('div', { key: 'broken', style: { color: '#c0392b' } }, 'preset 当前激活异常：' + preset.broken))
        }
      } else {
        rows.push(h('div', { key: 'na', style: { color: '#c07a10' } },
          '无法定位可写的 preset：' + (preset.reason || '未知原因')))
      }
      return h('div', { style: S.presetBox }, ...rows)
    }

    function ModuleCard({ m, act, confirm, onAskApply, onCancelApply, onConfirmApply, onRevert }) {
      const children = [
        h('div', { key: 'head', style: S.head },
          h('strong', { style: { fontSize: 15 } }, m.title),
          h('span', { style: { fontSize: 11, color: MUTE } }, m.scope),
          h('span', { style: { flex: 1 } }),
          h(Badge, { key: 'badge', status: m.status }),
        ),
        h('p', { key: 'headline', style: { margin: '0 0 12px', fontSize: 13, lineHeight: 1.55 } }, m.headline),
        h('div', { key: 'metrics', style: S.metrics },
          ...(m.metrics ?? []).map((x, i) => h(Metric, { key: i, ...x }))),
      ]

      for (const [i, t] of (m.tables || []).entries()) {
        children.push(h('div', { key: 'tbl' + i, style: { margin: '0 0 12px', overflowX: 'auto' } },
          h('div', { style: { fontSize: 12, color: MUTE } }, t.title), h(Table, { t })))
      }
      for (const [i, t] of (m.details || []).entries()) {
        children.push(h('details', { key: 'det' + i, style: { margin: '0 0 10px' } },
          h('summary', { style: { cursor: 'pointer', fontSize: 12, color: MUTE } }, t.title),
          h('div', { style: { overflowX: 'auto' } }, h(Table, { t }))))
      }

      if (m.recommendation) {
        const rec = m.recommendation
        const box = [
          h('div', { key: 'title', style: S.recTitle }, rec.title),
          h('div', { key: 'detail', style: S.recDetail }, rec.detail),
        ]
        if (rec.apply) {
          box.push(h('div', { key: 'apply', style: S.applyBox },
            '写入：' + rec.apply.target + ' · ' + rec.apply.effect,
            h('div', { style: S.code }, rec.apply.changes.length
              ? rec.apply.changes.map(c => c.key + ': ' + c.value).join('；')
              : '不写按模型策略（全部模型用官方默认）'),
          ))
        }
        children.push(h('div', { key: 'rec', style: S.rec }, ...box))
      }

      if (m.id === 'compaction' && m.preset) {
        const preset = m.preset
        const canWrite = preset.available && m.recommendation && m.recommendation.apply
        const busy = act && act.status === 'working'
        const action = [
          h('div', { key: 'pb', style: { marginTop: 12 } }, h(PresetBox, { preset })),
        ]
        if (preset.available && m.recommendation) {
          if (busy) {
            action.push(h('button', { key: 'busy', disabled: true, style: S.buttonDisabled }, '写入中…'))
          } else if (confirm) {
            action.push(h('button', { key: 'ok', onClick: onConfirmApply, style: S.buttonPrimary }, '确认写入'))
            action.push(h('button', { key: 'cancel', onClick: onCancelApply, style: S.button }, '取消'))
            action.push(h('span', { key: 'hint', style: { fontSize: 11, color: MUTE } },
              '会改动当前 preset 的压缩配置，仅新会话生效'))
          } else if (m.applied) {
            action.push(h('button', { key: 'done', disabled: true, style: S.buttonDisabled }, '已是建议值'))
            action.push(h('button', { key: 'revert', onClick: onRevert, style: S.button }, '恢复 preset 默认'))
          } else {
            action.push(h('button', { key: 'apply', onClick: onAskApply, style: canWrite ? S.buttonPrimary : S.buttonDisabled, disabled: !canWrite }, '应用按模型建议'))
            if (preset.hasOverride) {
              action.push(h('button', { key: 'revert2', onClick: onRevert, style: S.button }, '恢复 preset 默认'))
            }
          }
        }
        if (act && act.status !== 'working') {
          action.push(h('div', {
            key: 'act',
            style: { marginTop: 8, fontSize: 11.5, lineHeight: 1.6, color: act.status === 'error' ? '#c0392b' : '#2f8f5b' },
          }, act.message))
        }
        children.push(h('div', { key: 'action' }, ...action))
      } else if (m.recommendation) {
        children.push(h('div', { key: 'noapply', style: { marginTop: 10, fontSize: 11, color: MUTE } },
          '本模块只给建议，不支持一键写入。'))
      }

      if ((m.notes ?? []).length) {
        children.push(h('ul', { key: 'notes', style: S.notes },
          ...m.notes.map((n, i) => h('li', { key: i }, n))))
      }

      return h('section', { style: S.card }, ...children)
    }

    class Panel extends React.Component {
      constructor(props) {
        super(props)
        this.state = { days: 14, loading: true, data: null, act: null, confirm: false }
        this.load = this.load.bind(this)
      }

      componentDidMount() {
        this.load(this.state.days)
      }

      async post(path, body) {
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

      async load(days, opts) {
        const keep = opts && opts.keepAct
        this.setState({ loading: true, ...(keep ? {} : { act: null, confirm: false }) })
        try {
          const data = await this.post('/dsh-tuner/report', { days, maxSessions: 60 })
          this.setState({ loading: false, data })
        } catch (err) {
          this.setState({ loading: false, data: { ok: false, error: String((err && err.message) || err) } })
        }
      }

      async run(action) {
        this.setState({ act: { status: 'working', message: action === 'revert' ? '正在恢复默认…' : '正在写入 preset…' }, confirm: false })
        try {
          const body = action === 'revert' ? { action: 'revert' } : { days: this.state.days }
          const r = await this.post('/dsh-tuner/apply', body)
          if (!r.ok) {
            const msg = r.error
              ? '写入失败：' + r.error
              : '写入后回读不一致' + (r.rolledBack ? '，已回滚到原配置' : '，请检查 profile patch')
            this.setState({ act: { status: 'error', message: msg } })
          } else {
            const side = x => '顶层 ' + ((x && x.top) || '默认') + (x && x.per && x.per.length ? '；按模型 ' + x.per.join('、') : '')
            const line = (action === 'revert' ? '已恢复默认：' : '写入成功并回读校验通过：') + side(r.before) + ' → ' + side(r.after)
            this.setState({ act: { status: 'ok', message: line + '。' + (r.effect || '') } })
          }
          await this.load(this.state.days, { keepAct: true })
        } catch (err) {
          this.setState({ act: { status: 'error', message: '写入失败：' + String((err && err.message) || err) } })
        }
      }

      render() {
        const { days, loading, data: d, act, confirm } = this.state
        const banner = act && act.status !== 'working'
          ? h('div', { style: { ...S.banner, ...(act.status === 'error' ? S.err : S.ok) } }, act.message)
          : null
        return h('div', { style: S.page },
          h('div', { style: S.row },
            h('h2', { style: { margin: 0, fontSize: 18 } }, '调优建议'),
            h('span', { style: { flex: 1 } }),
            h('select', {
              value: days,
              onChange: ev => { const v = Number(ev.target.value); this.setState({ days: v }); this.load(v) },
              style: S.select,
            },
              h('option', { value: 7 }, '近 7 天'),
              h('option', { value: 14 }, '近 14 天'),
              h('option', { value: 30 }, '近 30 天'),
            ),
            h('button', {
              onClick: () => this.load(days),
              style: { ...S.select, cursor: 'pointer' },
            }, '刷新'),
          ),
          h('p', { style: { margin: '2px 0 18px', fontSize: 12, color: MUTE } },
            '基于本机真实请求回放，按模型给压缩阈值，另附压缩实测健康。压缩卡可写入当前 agent preset；只影响新会话，已开会话需 /compact 或重开。'),

          loading ? h('p', { style: { fontSize: 12, color: MUTE } }, '统计中…') : null,
          banner,
          d && d.ok === false ? h('p', { style: { fontSize: 12, color: '#c0392b' } }, '无法生成报告：' + d.error) : null,
          d && d.ok ? h('div', null,
            h('p', { style: { margin: '0 0 14px', fontSize: 12, color: MUTE } },
              '窗口 ' + d.window.days + ' 天 · ' + d.window.sessions + ' 个会话 · ' + d.window.requests + ' 次请求 · 生成于 ' + new Date(d.generatedAt).toLocaleString()),
            ...d.modules.map(m => h(ModuleCard, {
              key: m.id,
              m,
              act: m.id === 'compaction' ? act : null,
              confirm,
              onAskApply: () => this.setState({ confirm: true, act: null }),
              onCancelApply: () => this.setState({ confirm: false }),
              onConfirmApply: () => this.run('apply'),
              onRevert: () => this.run('revert'),
            })),
          ) : null,
        )
      }
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
          { name: 'sidebar.panellist', id: 'dsh-tuner', order: 30, label: () => '调优 v0.4' },
          Icon,
        ))
      },
    }
    return t.exports
  },
})
