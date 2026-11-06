#!/usr/bin/env node
// dsh-tuner offline: the same report the panel shows, computed from session files.
// Read-only. No model calls. Usage:
//   node scripts/analyze.mjs [--days 14] [--limit 60] [--policy '<compaction-basic config JSON>'] [--json out.json]
// --policy is the compaction-basic config in force (default: upstream defaults);
// the panel reads it from the active preset itself.
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { analyzeSession, buildReport, formatText } from '../index.js'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt
}
const DAYS = Number(opt('days', 14))
const LIMIT = Number(opt('limit', 60))
const OUT = opt('json', '')
const POLICY = opt('policy', '') ? JSON.parse(opt('policy', '')) : undefined
const ROOT = opt('root', join(homedir(), '.dsh', 'sessions'))
const since = Date.now() - DAYS * 86400_000

function readEvents(file) {
  const raw = execFileSync('zstd', ['-dc', file], { maxBuffer: 512 * 1024 * 1024 })
  const events = []
  for (const line of raw.toString('utf8').split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch {}
  }
  return events
}

const sessions = []
for (const slug of readdirSync(ROOT)) {
  let ents
  try { ents = readdirSync(join(ROOT, slug)) } catch { continue }
  for (const sid of ents) {
    const file = join(ROOT, slug, sid, 'session.v4.jsonl.zstd')
    let st
    try { st = statSync(file) } catch { continue }
    if (st.mtimeMs < since) continue
    const events = readEvents(file)
    const head = events.find(e => e.type === 'session') ?? {}
    const createdAt = head.createdAt ?? events[0]?.time ?? st.mtimeMs
    // same filter as the panel: created inside the window, not a subagent run (forks count)
    if (createdAt < since || (head.delegationDepth ?? 0) > 0 || (head.parentSession && !head.isSeeded)) continue
    const s = analyzeSession({ events }, { id: sid, cwd: slug, createdAt, parentSession: null })
    if (s.requests.length >= 3) sessions.push({ s, createdAt })
  }
}
sessions.sort((a, b) => b.createdAt - a.createdAt)
const picked = sessions.slice(0, LIMIT).map(x => x.s)
const report = picked.length
  ? buildReport(picked, DAYS, { policy: POLICY })
  : { ok: false, error: `近 ${DAYS} 天没有可分析的会话` }
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2))
console.log(formatText(report))
