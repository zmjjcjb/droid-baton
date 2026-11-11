import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const sessionsDir = () => process.env.DROID_SESSIONS_DIR || path.join(os.homedir(), '.factory/sessions')
const outcomeFiles = new Map()
export function savedOutcome(sessionId) {
  if (typeof sessionId !== 'string' || !/^[\w-]{1,150}$/.test(sessionId)) return null
  const root = sessionsDir(), key = root + ':' + sessionId
  let file = outcomeFiles.get(key)
  if (!file) {
    let scanned = 0
    function find(dir, depth = 0) {
      if (depth > 4 || scanned > 10000) return
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const e of entries) {
        scanned++
        if (e.isFile() && e.name === sessionId + '.jsonl') return path.join(dir, e.name)
        if (e.isDirectory()) { const result = find(path.join(dir, e.name), depth + 1); if (result) return result }
      }
    }
    file = find(root)
    if (!file) return null
    outcomeFiles.set(key, file); if (outcomeFiles.size > 256) outcomeFiles.delete(outcomeFiles.keys().next().value)
  }
  let fd
  try {
    const stat = fs.statSync(file), size = Math.min(stat.size, 1024 * 1024), buf = Buffer.alloc(size)
    fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, size, stat.size - size)
    let lastOutcome, afterOutcome = false
    for (const line of buf.toString().split('\n')) {
      let r; try { r = JSON.parse(line) } catch { continue }
      if (r.type === 'agent_turn_outcome') { lastOutcome = r; afterOutcome = false }
      else if (r.type === 'message') afterOutcome = true
    }
    return { modified_ms: stat.mtimeMs, size: stat.size, turn_id: lastOutcome?.turnId, reason: afterOutcome ? null : lastOutcome?.reason }
  } catch { return null } finally { if (fd !== undefined) fs.closeSync(fd) }
}
// Droid's persisted format is a read-only discovery fallback; never write these files.
export function discoverSessions({ cwd, query, limit = 50 } = {}) {
  const out = []
  function visit(dir) {
    let files
    try { files = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of files) {
      const file = path.join(dir, e.name)
      if (e.isDirectory()) { if (!['btw', 'subagents'].includes(e.name)) visit(file); continue }
      if (!e.name.endsWith('.jsonl')) continue
      let fd
      try {
        fd = fs.openSync(file, 'r'); const buf = Buffer.alloc(64 * 1024)
        const n = fs.readSync(fd, buf, 0, buf.length, 0)
        const header = JSON.parse(buf.subarray(0, n).toString().split('\n')[0])
        if (header.type !== 'session_start' || !header.id || header.parent || header.callingSessionId) continue
        if (cwd && header.cwd !== cwd) continue
        if (query && !`${header.title} ${header.cwd}`.toLowerCase().includes(query.toLowerCase())) continue
        out.push({ session_id: header.id, title: header.title, cwd: header.cwd, modified_at: fs.statSync(file).mtime.toISOString(), origin: 'droid', file })
      } catch {} finally { if (fd !== undefined) fs.closeSync(fd) }
    }
  }
  visit(sessionsDir())
  return out.sort((a, b) => b.modified_at.localeCompare(a.modified_at)).slice(0, Math.min(limit, 200))
}
export function savedMessages(sessionId, last = 20) {
  const info = discoverSessions({ limit: 200 }).find(s => s.session_id === sessionId)
  if (!info) return []
  const stat = fs.statSync(info.file)
  // Read only a bounded tail, never load a multi-GB transcript into the MCP process.
  const size = Math.min(stat.size, 2 * 1024 * 1024), buf = Buffer.alloc(size), fd = fs.openSync(info.file, 'r')
  try { fs.readSync(fd, buf, 0, size, stat.size - size) } finally { fs.closeSync(fd) }
  const out = []
  for (const line of buf.toString().split('\n')) {
    let r; try { r = JSON.parse(line) } catch { continue }
    const m = r.message || (r.type === 'message' ? r : null)
    if (!m || !['user', 'assistant'].includes(m.role)) continue
    const text = typeof m.content === 'string' ? m.content : (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
    if (text) out.push({ role: m.role, text, time: r.timestamp })
  }
  return out.slice(-last)
}
