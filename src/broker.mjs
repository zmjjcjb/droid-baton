import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { Droid } from './droid.mjs'
import { ROOT, HOME, VERSION, now, privateDir, readJson, writeJson, realDir, killTree } from './config.mjs'
import { discoverSessions, savedMessages } from './discovery.mjs'
import * as evidence from './evidence.mjs'
import { Supervisor, supervisionOptions, observeWork, liveWork } from './supervision.mjs'
import { projectRun, projectPending } from './views.mjs'

export const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'interrupted'])
const active = r => r && !TERMINAL.has(r.state)
const contains = (a, b) => { const relative = path.relative(a, b); return !relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) }
const sameTree = (a, b) => contains(a, b) || contains(b, a)
const textOf = m => typeof m?.content === 'string' ? m.content : (m?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n')
const clean = o => JSON.parse(JSON.stringify(o))

export class Broker extends EventEmitter {
  constructor({ home = HOME, DroidClass = Droid } = {}) {
    super(); this.setMaxListeners(128); this.home = home; this.DroidClass = DroidClass
    privateDir(home); privateDir(path.join(home, 'events')); privateDir(path.join(home, 'host-runs'))
    this.file = path.join(home, 'state.json')
    this.state = readJson(this.file, { workspaces: {}, sessions: {}, runs: {} })
    this.connections = new Map(); this.opening = new Set(); this.checkers = new Map(); this.timers = new Map(); this.idleTimers = new Map(); this.closing = false
    for (const run of Object.values(this.state.runs)) if (active(run)) {
      run.state = 'interrupted'; run.ended_at = now(); run.pending = null
      run.turn_open = false; run.attention = null
      run.error = '本地任务服务重启；未自动重试。可由用户决定是否续聊。'
      writeJson(path.join(home, 'host-runs', `${run.run_id}.json`), { state: 'interrupted', endedAt: run.ended_at })
    }
    for (const s of Object.values(this.state.sessions)) { s.active_run = null; s.queue = [] }
    this.supervisor = new Supervisor(this)
    this.flush()
  }
  flush() { writeJson(this.file, this.state) }
  changed(immediate = true) {
    if (immediate) { clearTimeout(this.saveTimer); this.saveTimer = null; this.flush() }
    else if (!this.saveTimer) this.saveTimer = setTimeout(() => { this.saveTimer = null; this.flush() }, 250)
    this.emit('change')
  }
  event(run, type, data = {}) {
    run.revision = (run.revision || 0) + 1
    const ev = { seq: run.event_seq = (run.event_seq || 0) + 1, time: now(), type, ...data }
    run.recent_events = [...(run.recent_events || []), ev].slice(-30)
    const file = path.join(this.home, 'events', `${run.run_id}.jsonl`)
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 10 * 1024 * 1024) fs.renameSync(file, file + '.1')
      fs.appendFileSync(file, JSON.stringify(ev) + '\n', { mode: 0o600 })
    } catch (error) { run.log_error = error.message }
    this.changed(false)
  }
  getRun(id) { const r = this.state.runs[id]; if (!r) throw new Error(`未知 run_id：${id}`); return r }
  getSession(id) {
    let s = this.state.sessions[id]
    if (!s) {
      const found = discoverSessions({ limit: 200 }).find(x => x.session_id === id)
      if (!found) throw new Error(`未知 session_id：${id}`)
      s = this.state.sessions[id] = { session_id: id, cwd: realDir(found.cwd), title: found.title, messages: savedMessages(id), queue: [] }
    }
    return s
  }
  async connection(s) {
    clearTimeout(this.idleTimers.get(s.session_id)); this.idleTimers.delete(s.session_id)
    if (this.connections.has(s.session_id)) return this.connections.get(s.session_id)
    const task = this.openConnection(s)
    this.connections.set(s.session_id, task)
    try { return await task } catch (error) { this.connections.delete(s.session_id); throw error }
  }
  bind(conn, getSession) {
    conn.on('notification', (n, sid) => {
      const s = getSession()
      if (s && (!sid || sid === s.session_id)) void this.notification(s, n).catch(error => {
        const r = this.state.runs[s.active_run]; if (active(r)) void this.finish(s, r, 'failed', error.message)
      })
    })
    conn.on('request', msg => {
      const s = getSession(), r = this.state.runs[s?.active_run]
      if (!active(r)) {
        try { conn.answer(msg.id, msg.method === 'droid.request_permission' ? { selectedOption: 'cancel' } : { cancelled: true, answers: [], selectedIds: [] }) } catch {}
        return
      }
      if (!['droid.ask_user', 'droid.request_permission', 'droid.pick_options'].includes(msg.method)) {
        conn.write({ id: msg.id, error: { code: -32601, message: 'Unsupported client request' } }); return
      }
      if (r.pending) { void this.finish(s, r, 'failed', 'Droid 同时发出了多个输入请求；为避免错答已停止。'); conn.close(); return }
      r.pending = { request_id: msg.id, kind: msg.method.split('.').at(-1), ...msg.params }
      r.state = 'waiting'; this.event(r, 'needs_input', { pending: r.pending }); this.changed()
    })
    conn.on('diagnostic', text => { const r = this.state.runs[getSession()?.active_run]; if (active(r)) this.event(r, 'diagnostic', { text }) })
    conn.on('disconnected', error => {
      const s = getSession(); if (!s) return
      this.connections.delete(s.session_id)
      const r = this.state.runs[s.active_run]
      if (active(r) && !['checking', 'paused'].includes(r.state)) void this.finish(s, r, this.closing ? 'interrupted' : 'failed', error.message)
    })
  }
  async openConnection(s) {
    const conn = new this.DroidClass({ cwd: s.cwd })
    this.bind(conn, () => s)
    try {
      const res = await conn.request('droid.load_session', { sessionId: s.session_id })
      // A persisted cwd is authoritative; never silently redirect a resumed session.
      if (realDir(res.cwd || s.cwd) !== s.cwd) throw new Error('恢复会话的工作目录与记录不一致。')
      s.model = res.settings?.modelId; s.settings = res.settings; s.protocol = conn.protocol
      return conn
    } catch (error) { conn.close(); throw error }
  }
  workspace({ path: dir, title, create_dir = false }) {
    if (create_dir) fs.mkdirSync(dir, { recursive: true })
    const cwd = realDir(dir)
    let w = Object.values(this.state.workspaces).find(x => x.path === cwd)
    if (!w) { w = { workspace_id: `ws-${crypto.randomUUID()}`, path: cwd, title: title || path.basename(cwd) }; this.state.workspaces[w.workspace_id] = w }
    this.changed(); return clean(w)
  }
  async models() {
    const conn = new this.DroidClass({ cwd: os.homedir() })
    conn.on('request', msg => conn.answer(msg.id, { selectedOption: 'cancel', cancelled: true, answers: [] }))
    try { return await conn.request('droid.list_models', {}) } finally { conn.close() }
  }
  async send(a) {
    const supervision = supervisionOptions(a.supervision)
    if (typeof a.message !== 'string' || !a.message.trim() || a.message.length > 1024 * 1024) throw new Error('message 不能为空，且不能超过 1 MiB。')
    if (a.mode !== undefined && !['followup', 'steer'].includes(a.mode)) throw new Error('mode 仅支持 followup 或 steer。')
    if (a.checks !== undefined && (!Array.isArray(a.checks) || a.checks.length > 10 || a.checks.some(x => typeof x !== 'string' || !x.trim() || x.length > 10000))) throw new Error('checks 必须是最多 10 条非空验收命令。')
    if (a.autonomy !== undefined && !['off', 'low', 'medium', 'high'].includes(a.autonomy)) throw new Error('autonomy 仅支持 off/low/medium/high。')
    if (a.timeout_s !== undefined && (!Number.isInteger(a.timeout_s) || a.timeout_s < 1 || a.timeout_s > 604800)) throw new Error('timeout_s 必须在 1–604800 秒之间。')
    if (Object.values(this.state.runs).filter(active).length >= 64) throw new Error('已有 64 个运行或排队任务，请等待或取消后再派发。')
    let s = a.session_id ? this.getSession(a.session_id) : null
    let cwd = s?.cwd || (a.cwd ? realDir(a.cwd) : this.state.workspaces[a.workspace_id]?.path)
    if (!cwd) throw new Error('新任务必须指定 cwd 或有效的 workspace_id。')
    if (s && a.cwd && realDir(a.cwd) !== s.cwd) throw new Error('续聊必须使用原会话目录。')
    const busy = s && this.state.runs[s.active_run]
    if (active(busy) && a.mode === 'steer') {
      if (!['running'].includes(busy.state)) throw new Error('当前处于提问/验收阶段；请先回答问题或排队 followup。')
      if (a.checks?.length || a.model || a.reasoning_effort || a.autonomy || supervision) throw new Error('steer 只发送补充指令；检查和模型设置请用 followup。')
      const conn = await this.connection(s), id = crypto.randomUUID()
      busy.steers = [...(busy.steers || []), { message_id: id, message: a.message, sender: a.sender || 'codex', time: now() }]
      this.event(busy, 'steer', busy.steers.at(-1)); this.changed()
      conn.request('droid.add_user_message', { messageId: id, text: `[由 ${a.sender || 'Codex'} 从另一聊天补充]\n${a.message}`, queuePlacement: 'end_of_loop' }, { timeout: 0 }).catch(error => { this.event(busy, 'steer_error', { text: error.message }) })
      return { ...this.status({ run_id: busy.run_id, detail: a.detail }), mode: 'steer', delivery: 'end_of_loop', note: '补充指令会在 Droid 当前工具循环结束时送达；不会强行打断正在运行的命令。' }
    }
    if (this.opening.has(cwd)) throw new Error('该目录的会话正在初始化，请稍后重试。')
    // Sessions sharing a tree can corrupt each other's edits and evidence. Queue the same
    // session; independent sessions use separate directories or explicit opt-in.
    const overlap = Object.values(this.state.runs).find(r => active(r) && r.session_id !== s?.session_id && sameTree(cwd, r.cwd))
    if (overlap && !a.allow_shared_cwd) throw new Error(`目录与 ${overlap.run_id} 的运行范围重叠。使用独立目录，或显式 allow_shared_cwd。`)
    if (!s) {
      this.opening.add(cwd)
      const conn = new this.DroidClass({ cwd })
      let created
      this.bind(conn, () => created)
      try {
        const res = await conn.request('droid.initialize_session', { machineId: os.hostname(), cwd, ...(a.model ? { modelId: a.model } : {}), ...(a.reasoning_effort ? { reasoningEffort: a.reasoning_effort } : {}), ...(a.autonomy ? { autonomyLevel: a.autonomy, interactionMode: 'auto' } : {}) })
        if (!res.sessionId) throw new Error('Droid 未返回 sessionId。')
        created = s = { session_id: res.sessionId, cwd, title: a.title || a.message.slice(0, 60), model: res.settings?.modelId, settings: res.settings, protocol: conn.protocol, queue: [], messages: [], created_at: now() }
        this.state.sessions[s.session_id] = s; this.connections.set(s.session_id, Promise.resolve(conn))
        await conn.request('droid.rename_session', { title: s.title })
        this.workspace({ path: cwd })
      } catch (error) { conn.close(); throw error } finally { this.opening.delete(cwd) }
    }
    const r = { run_id: `drun-${crypto.randomUUID()}`, session_id: s.session_id, cwd, message: a.message, checks: a.checks || [], sender: a.sender || 'codex', model: a.model, reasoning_effort: a.reasoning_effort, autonomy: a.autonomy, supervision, timeout_s: a.timeout_s || 21600, created_at: now(), state: active(busy) ? 'queued' : 'starting', recent_events: [] }
    this.state.runs[r.run_id] = r
    if (active(this.state.runs[s.active_run])) { r.state = 'queued'; s.queue.push(r.run_id) }
    else { s.active_run = r.run_id; void this.start(s, r) }
    this.changed()
    return this.status({ run_id: r.run_id, detail: a.detail })
  }
  async start(s, r) {
    try {
      const conn = await this.connection(s)
      if (!active(r) || s.active_run !== r.run_id || this.closing) return
      const settings = { ...(r.model ? { modelId: r.model } : {}), ...(r.reasoning_effort ? { reasoningEffort: r.reasoning_effort } : {}), ...(r.autonomy ? { autonomyLevel: r.autonomy, interactionMode: 'auto' } : {}) }
      if (Object.keys(settings).length) {
        const res = await conn.request('droid.update_session_settings', settings)
        s.settings = res.settings || { ...s.settings, ...settings }; s.model = s.settings.modelId
      }
      r.model = s.model; r.started_at = now(); r.state = 'running'; r.turn_id = crypto.randomUUID()
      r.deadline = new Date(Date.now() + r.timeout_s * 1000).toISOString()
      this.supervisor.initialize(r)
      writeJson(path.join(this.home, 'host-runs', `${r.run_id}.json`), { state: 'running', endedAt: null })
      evidence.prepare(this.home, { run_id: r.run_id, session_id: s.session_id, cwd: s.cwd, checks: r.checks })
      const file = path.join(this.home, 'evidence', `${r.run_id}.json`)
      if (!fs.existsSync(file)) throw new Error('文件快照创建失败；任务尚未发送。')
      s.messages.push({ role: 'user', text: r.message, sender: r.sender, time: now(), run_id: r.run_id }); s.messages = s.messages.slice(-100)
      this.event(r, 'started', { model: r.model }); this.changed()
      this.timers.set(r.run_id, setTimeout(() => { void this.cancel({ run_id: r.run_id, reason: '运行超过 timeout_s，已终止。', timeout: true }) }, r.timeout_s * 1000))
      await this.dispatchTurn(s, r, r.message, 'initial')
    } catch (error) { if (active(r)) await this.finish(s, r, 'failed', error.message) }
  }
  async dispatchTurn(s, r, message, kind) {
    const conn = await this.connection(s)
    if (!active(r) || ['paused', 'checking'].includes(r.state) || this.closing) return
    r.state = 'running'; r.turn_id = crypto.randomUUID(); r.final_text = ''; r.partial_text = ''; r.last_error = null; r.owner_pid = conn.child?.pid
    this.supervisor.beginTurn(r, kind)
    const turnId = r.turn_id
    if (kind !== 'initial') { s.messages.push({ role: 'user', text: message, sender: 'supervisor', time: now(), run_id: r.run_id }); s.messages = s.messages.slice(-100) }
    this.event(r, 'turn_started', { round: r.supervisor?.round || 1, kind }); this.changed()
    const prompt = this.supervisor.prompt(r, `[由 ${r.sender === 'codex' ? 'Codex' : r.sender} 从另一聊天委派；通过 Droid Baton]\n${message}\n\n请使用中文回复。完成后给出变更文件、执行过的验证及逐项需求完成表。未完成或不确定的项目必须明确说明。不要擅自扩大任务范围。`)
    conn.request('droid.add_user_message', { messageId: turnId, text: prompt, queuePlacement: 'end_of_turn' }, { timeout: 0 }).catch(error => {
      if (active(r) && r.turn_id === turnId && r.turn_open && !['checking', 'paused'].includes(r.state)) void this.finish(s, r, 'failed', error.message)
    })
  }
  async notification(s, n) {
    if (!n) return
    if (n.type === 'session_title_updated' && n.title) s.title = n.title
    const r = this.state.runs[s.active_run]
    if (!active(r) || ['checking', 'paused'].includes(r.state)) return
    observeWork(r, n)
    if (n.type === 'droid_working_state_changed') { r.native_state = n.newState; r.native_busy = n.newState !== 'idle' }
    if (!r.turn_open && ['background', 'review'].includes(r.state) && n.type === 'droid_working_state_changed' && ['thinking', 'streaming_assistant_message'].includes(n.newState)) {
      if (!await this.supervisor.nativeRound(s, r)) return
    }
    if (r.state === 'background' && ['create_message', 'tool_call', 'tool_result', 'mission_worker_completed', 'mission_state_changed'].includes(n.type)) r.work_quiet_since = Date.now()
    if (n.type === 'tool_result') {
      const handle = this.connections.get(s.session_id)
      if (handle) void handle.then(conn => { for (const job of Object.values(r.work?.jobs || {})) if (job.identity) conn.trackProcess?.(job.identity) }).catch(() => {})
    }
    r.revision = (r.revision || 0) + 1
    if (n.type === 'assistant_text_delta') {
      r.partial_text = ((r.partial_text || '') + n.textDelta).slice(-64000)
      this.changed(false)
    } else if (n.type === 'create_message') {
      const m = n.message, text = textOf(m)
      if (text && m.role === 'assistant') {
        r.final_text = text.slice(-128000); r.partial_text = ''
        s.messages.push({ role: m.role, text: r.final_text, time: now(), run_id: r.run_id }); s.messages = s.messages.slice(-100)
        this.event(r, 'assistant', { text: r.final_text })
      }
    } else if (n.type === 'tool_call') this.event(r, 'tool_call', { name: n.toolUse?.name, input: JSON.stringify(n.toolUse?.input || {}).slice(0, 4000) })
    else if (n.type === 'tool_result') this.event(r, 'tool_result', { result: JSON.stringify(n).slice(0, 4000) })
    else if (n.type === 'error') { r.last_error = n.message; this.event(r, 'error', { text: n.message }) }
    else if (n.type === 'agent_turn_completed') {
      if (n.turnId && n.turnId !== r.turn_id && !r.steers?.some(x => x.message_id === n.turnId)) {
        if (r.state !== 'background') return
        // Native completion delivery may start another parent-session turn.
        // Keep supervising it, rather than dropping a differently named turn.
        r.native_turns = [...(r.native_turns || []), n.turnId].slice(-50)
        if (!await this.supervisor.nativeRound(s, r)) return
      }
      r.usage = n.tokenUsage; r.turn_end = n.reason; r.duration_ms = n.durationMs
      await this.supervisor.ended(s, r, n)
    } else if (n.type === 'queued_messages_discarded') this.event(r, n.type, { text: n.text })
    else if (n.type.startsWith('mission_') || ['tool_progress_update', 'child_session_available', 'droid_working_state_changed'].includes(n.type)) {
      this.event(r, n.type, { detail: JSON.stringify(n).slice(0, 3000) })
      if (r.state === 'background') await this.supervisor.settle(s, r)
    } else this.changed(false)
  }
  async collect(r, { evidenceId = r.run_id } = {}) {
    return await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'src/evidence-worker.mjs'), this.home, evidenceId], { cwd: r.cwd, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
      let output = '', err = ''
      this.checkers.set(r.run_id, child)
      const timer = setTimeout(() => { killTree(child.pid, 'SIGKILL') }, 200000)
      child.stdout.on('data', b => { output += b; if (output.length > 8 * 1024 * 1024) killTree(child.pid, 'SIGKILL') })
      child.stderr.on('data', b => { err = (err + b).slice(-4000) })
      child.on('error', reject)
      child.on('close', code => {
        clearTimeout(timer); this.checkers.delete(r.run_id); killTree(child.pid, 'SIGKILL')
        if (code !== 0) return reject(new Error(err || `独立验收进程退出：${code}`))
        try { resolve(JSON.parse(output)) } catch { reject(new Error('验收结果不是有效 JSON。')) }
      })
    })
  }
  async finish(s, r, state, error, { evidenceReady = false } = {}) {
    if (TERMINAL.has(r.state) || (r.state === 'checking' && !evidenceReady)) return
    clearTimeout(this.timers.get(r.run_id)); this.timers.delete(r.run_id)
    r.pending = null; r.error = error
    if (state !== 'completed') this.supervisor.stopOwned(r)
    if (r.started_at && !evidenceReady && !['cancelled', 'interrupted'].includes(state)) {
      r.state = 'checking'; this.changed()
      try {
        r.evidence = await this.collect(r)
        if (r.evidence) r.evidence_record = path.join(this.home, 'evidence', `${r.run_id}.json`)
      } catch (err) { r.evidence_error = err.message; state = 'failed' }
    }
    // cancel() can win while the independent checks run.
    if (TERMINAL.has(r.state)) return
    r.state = state; r.ended_at = now(); r.turn_open = false; r.attention = null; this.event(r, state, { error: r.error }); this.changed()
    writeJson(path.join(this.home, 'host-runs', `${r.run_id}.json`), { state: r.state, endedAt: r.ended_at })
    if (s.active_run === r.run_id) s.active_run = null
    // A failed or stopped worker must not silently start queued changes.
    if (state !== 'completed') {
      for (const id of s.queue.splice(0)) { const q = this.getRun(id); q.state = 'cancelled'; q.error = '前序运行失败或停止，已取消排队任务。'; q.ended_at = now() }
    } else this.next(s)
    if (!s.active_run && !this.closing) {
      clearTimeout(this.idleTimers.get(s.session_id))
      this.idleTimers.set(s.session_id, setTimeout(async () => {
        this.idleTimers.delete(s.session_id)
        if (s.active_run) return
        const promise = this.connections.get(s.session_id)
        if (promise) { const conn = await promise.catch(() => null); if (!s.active_run) conn?.close() }
      }, 60000).unref())
    }
    this.changed()
  }
  next(s) {
    if (this.closing || s.active_run) return
    const id = s.queue.shift()
    if (id) { const r = this.getRun(id); r.state = 'starting'; s.active_run = id; void this.start(s, r) }
  }
  status({ run_id, session_id, detail = 'full', since_seq = -1 }) {
    if (!run_id && !session_id) throw new Error('必须指定 run_id 或 session_id。')
    const s = session_id ? this.getSession(session_id) : null
    const r = run_id ? this.getRun(run_id) : this.state.runs[s.active_run] || Object.values(this.state.runs).filter(r => r.session_id === session_id).at(-1)
    if (!r) return { session_id, state: 'idle', cwd: s.cwd }
    const flags = {
      needs_input: r.state === 'waiting',
      needs_attention: !!r.attention && !TERMINAL.has(r.state),
      ...(r.state === 'completed' && detail !== 'decision' ? { review_hint: '依据 evidence 中的真实检查结果验收；检查失败或缺少覆盖时继续同一会话修复。不要仅凭 Droid 的完成表判定通过；按风险审查 diff。' } : {}),
    }
    // `full` is the historical shape: every field, for the dashboard, the CLI and
    // internal callers. `summary` is the compact supervisor view — a poll costs a
    // fraction of it, which matters because a supervisor polls the same run dozens
    // of times and every byte is paid again on each poll.
    if (detail === 'full') {
      const { checks, ...out } = clean(r)
      return { ...out, ...flags, outstanding_work: liveWork(r), ...(r.state === 'waiting' ? { question: r.pending } : {}) }
    }
    if (detail === 'decision') return { ...projectRun(r, { detail }), ...flags }
    return { ...projectRun(r, { since_seq, detail }), ...flags, ...(r.state === 'waiting' ? { question: projectPending(r.pending) } : {}) }
  }
  async answer({ run_id, request_id, answers, selected_option, reason, cancelled = false, selected_ids, detail = 'full' }) {
    const r = this.getRun(run_id), p = r.pending
    if (r.state !== 'waiting' || !p) throw new Error('该运行当前没有待回答的问题。')
    if (request_id !== p.request_id) throw new Error('request_id 已过期或不匹配；请读取当前问题。')
    const s = this.getSession(r.session_id), conn = await this.connection(s)
    let result
    if (p.kind === 'request_permission') {
      if (!p.options.some(o => o.value === selected_option)) throw new Error('selected_option 必须是 Droid 本次提供的选项。')
      if (selected_option !== 'cancel' && !reason?.trim()) throw new Error('批准权限需要 reason，说明用户授权依据。')
      if (selected_option !== 'cancel' && selected_option !== 'proceed_once') throw new Error('桥接只支持单次批准 proceed_once 或拒绝 cancel；不通过一次任务写入永久权限规则。')
      result = { selectedOption: selected_option, comment: reason }
    } else if (p.kind === 'pick_options') {
      if (!cancelled && (!Array.isArray(selected_ids) || selected_ids.some(id => !p.rows.some(row => row.id === id)))) throw new Error('selected_ids 必须来自当前可选列表。')
      result = { selectedIds: selected_ids || [], cancelled }
    } else {
      if (!cancelled && (!Array.isArray(answers) || answers.length !== p.questions.length)) throw new Error('必须回答当前全部问题，或 cancelled=true。')
      result = { cancelled, answers: cancelled ? [] : p.questions.map(q => {
        const a = answers.find(a => (a.index ?? a.id) === q.index)
        const answer = a?.answer ?? a?.text
        if (typeof answer !== 'string' || !answer.trim()) throw new Error(`缺少问题 ${q.index} 的回答。`)
        return { index: q.index, question: q.question, answer }
      }) }
    }
    // Recheck after awaiting connection: another client may have answered first.
    if (r.pending !== p) throw new Error('该问题已被另一客户端回答。')
    conn.answer(p.request_id, result); r.pending = null; r.state = 'running'
    this.event(r, 'answered', { kind: p.kind, result, reason }); this.changed()
    return this.status({ run_id, detail })
  }
  async cancel({ run_id, session_id, reason = '用户取消。', timeout = false, detail = 'full' }) {
    const s = this.getSession(session_id || this.getRun(run_id).session_id)
    const r = this.state.runs[run_id || s.active_run]
    if (r && TERMINAL.has(r.state)) return this.status({ run_id: r.run_id, detail })
    if (r?.state === 'queued' && !session_id) {
      s.queue = s.queue.filter(id => id !== r.run_id); r.state = 'cancelled'; r.ended_at = now(); r.error = reason; this.changed(); return this.status({ run_id, detail })
    }
    for (const id of s.queue.splice(0)) { const q = this.getRun(id); q.state = 'cancelled'; q.ended_at = now(); q.error = reason }
    if (r) {
      this.supervisor.stopOwned(r)
      clearTimeout(this.timers.get(r.run_id)); this.timers.delete(r.run_id)
      r.state = timeout ? 'failed' : 'cancelled'; r.pending = null; r.ended_at = now(); r.error = reason; r.turn_open = false; r.attention = null
      writeJson(path.join(this.home, 'host-runs', `${r.run_id}.json`), { state: r.state, endedAt: r.ended_at })
      const checker = this.checkers.get(r.run_id); if (checker) killTree(checker.pid, 'SIGKILL')
    }
    s.active_run = null
    const handle = this.connections.get(s.session_id); this.connections.delete(s.session_id)
    if (handle) {
      const conn = await handle.catch(() => null)
      if (conn) {
        // Best effort graceful interrupt, bounded; close() kills the entire owned tree.
        await conn.request('droid.interrupt_session', {}, { timeout: 1500 }).catch(() => {})
        conn.close()
      }
    }
    this.changed(); return r ? this.status({ run_id: r.run_id, detail }) : { session_id: s.session_id, state: 'idle' }
  }
  async wait({ run_id, run_ids, session_id, timeout_s = 50, detail = 'full', since_seq = -1, after_attention = {} }, signal) {
    const ids = run_ids || [run_id || this.getSession(session_id).active_run]
    if (!Array.isArray(ids) || !ids.length || ids.length > 64 || ids.some(id => !this.state.runs[id])) throw new Error('请提供 1–64 个有效 run_id。')
    if (!after_attention || typeof after_attention !== 'object' || Array.isArray(after_attention) || Object.values(after_attention).some(id => typeof id !== 'string')) throw new Error('after_attention 必须是从 run_id 到通知 ID 的映射。')
    const runs = ids.map(id => this.getRun(id))
    const brief = ({ run_id, session_id, state }) => ({ run_id, session_id, state })
    const ready = r => {
      if (TERMINAL.has(r.state)) return true
      if (r.state === 'waiting' && r.pending) return after_attention[r.run_id] !== r.pending.request_id
      return !!r.attention && after_attention[r.run_id] !== r.attention.id
    }
    const seconds = Math.min(Math.max(Number(timeout_s) || 50, 1), 3540)
    return await new Promise(resolve => {
      let timer, settled = false
      const done = timed_out => {
        if (settled) return; settled = true
        clearTimeout(timer); this.off('change', check); signal?.removeEventListener('abort', abort)
        const ended = runs.filter(ready).map(r => this.status({ run_id: r.run_id, detail, since_seq }))
        if (run_ids) {
          resolve({ ended, still_running: runs.filter(r => !ready(r)).map(brief), timed_out })
        } else {
          const run = runs[0]
          const status = ended[0] ?? (detail === 'decision' ? brief(run) : this.status({ run_id: run.run_id, detail, since_seq }))
          resolve({ ...status, timed_out })
        }
      }
      const check = () => { if (runs.some(ready)) done(false) }
      const abort = () => done(true)
      this.on('change', check); signal?.addEventListener('abort', abort, { once: true })
      timer = setTimeout(() => done(true), seconds * 1000)
      if (signal?.aborted) abort(); else check()
    })
  }
  async observe({ run_id, after_revision = -1, timeout_s = 50 }, signal) {
    const r = this.getRun(run_id)
    if ((r.revision || 0) !== after_revision || TERMINAL.has(r.state)) return this.status({ run_id, detail: 'full' })
    return await new Promise(resolve => {
      let timer, settled = false
      const done = () => { if (settled) return; settled = true; clearTimeout(timer); this.off('change', check); signal?.removeEventListener('abort', done); resolve(this.status({ run_id, detail: 'full' })) }
      const check = () => { if ((r.revision || 0) !== after_revision || TERMINAL.has(r.state)) done() }
      this.on('change', check); signal?.addEventListener('abort', done, { once: true })
      timer = setTimeout(done, Math.min(Math.max(Number(timeout_s) || 50, 1), 50) * 1000)
      if (signal?.aborted) done(); else check()
    })
  }
  async call(method, a = {}, signal) {
    switch (method.replace(/^droid_/, '')) {
      case 'ping': return { version: VERSION, pid: process.pid, ...this.dashboardInfo }
      case 'list_workspaces': return Object.values(this.state.workspaces)
      case 'create_workspace': return this.workspace(a)
      case 'list_models': return await this.models()
      case 'list_sessions': {
        const all = new Map(discoverSessions(a).map(({ file, ...s }) => [s.session_id, s]))
        for (const s of Object.values(this.state.sessions)) all.set(s.session_id, { session_id: s.session_id, title: s.title, cwd: s.cwd, model: s.model, active_run: s.active_run, queue: s.queue, origin: 'droid-baton', modified_at: s.messages.at(-1)?.time || s.created_at })
        return [...all.values()].filter(s => (!a.cwd || s.cwd === realDir(a.cwd)) && (!a.query || `${s.title} ${s.cwd}`.toLowerCase().includes(a.query.toLowerCase()))).sort((a, b) => (b.modified_at || '').localeCompare(a.modified_at || '')).slice(0, Math.min(a.limit || 50, 200))
      }
      case 'read_session': { const s = this.getSession(a.session_id); return { session_id: s.session_id, cwd: s.cwd, title: s.title, messages: (s.messages.length ? s.messages : savedMessages(s.session_id)).slice(-Math.min(a.last || 20, 100)) } }
      case 'send': return await this.send(a)
      case 'status': case 'session_activity': return this.status(a)
      case 'wait': return await this.wait(a, signal)
      case 'observe': return await this.observe(a, signal)
      case 'supervise': return await this.supervisor.control(a)
      case 'open_terminal': { const { openTerminal } = await import('./terminal.mjs'); this.getRun(a.run_id); return await openTerminal(a.run_id, this.home) }
      case 'answer': return await this.answer(a)
      case 'cancel': return await this.cancel(a)
      case 'list_runs': return Object.values(this.state.runs).filter(r => !a.session_id || r.session_id === a.session_id).slice(-Math.min(a.limit || 30, 200)).reverse().map(r => ({ run_id: r.run_id, session_id: r.session_id, state: r.state, cwd: r.cwd, created_at: r.created_at, ended_at: r.ended_at }))
      case 'rename_session': { const s = this.getSession(a.session_id); if (!a.title?.trim()) throw new Error('title 不能为空。'); const c = await this.connection(s); await c.request('droid.rename_session', { title: a.title }); s.title = a.title; this.changed(); return { session_id: s.session_id, title: s.title } }
      case 'rename_workspace': { const w = this.state.workspaces[a.workspace_id]; if (!w || !a.title?.trim()) throw new Error('workspace_id/title 无效。'); w.title = a.title; this.changed(); return w }
      case 'update_queued': {
        const r = this.getRun(a.run_id), s = this.getSession(r.session_id)
        if (r.state !== 'queued') throw new Error('消息已开始执行，不能再编辑队列。')
        if (a.action === 'remove') return await this.cancel(a)
        if (a.action === 'edit' && a.message?.trim()) r.message = a.message
        else if (a.action === 'steer') { const res = await this.send({ session_id: s.session_id, message: r.message, mode: 'steer', sender: r.sender }); await this.cancel({ run_id: r.run_id, reason: `已作为补充指令送入 ${res.run_id}` }); return res }
        else throw new Error('action 支持 edit/remove/steer；edit 需要 message。')
        this.changed(); return this.status(a)
      }
      case 'dashboard': return this.dashboardInfo
      default: throw new Error(`未知方法 ${method}`)
    }
  }
  async close() {
    if (this.closing) return
    this.closing = true; clearTimeout(this.saveTimer)
    this.supervisor.close()
    // Commit the interrupted state before disconnect callbacks or checker exits
    // can race shutdown and misclassify an interrupted run as a normal failure.
    for (const r of Object.values(this.state.runs)) if (active(r)) { this.supervisor.stopOwned(r); r.state = 'interrupted'; r.ended_at = now(); r.pending = null; r.turn_open = false; r.attention = null; r.error = '任务服务停止；未自动恢复。'; writeJson(path.join(this.home, 'host-runs', `${r.run_id}.json`), { state: r.state, endedAt: r.ended_at }) }
    for (const s of Object.values(this.state.sessions)) { s.active_run = null; s.queue = [] }
    this.flush(); this.emit('change')
    for (const timer of this.timers.values()) clearTimeout(timer)
    for (const timer of this.idleTimers.values()) clearTimeout(timer)
    for (const child of this.checkers.values()) killTree(child.pid, 'SIGKILL')
    for (const p of this.connections.values()) { const c = await p.catch(() => null); c?.close() }
    this.flush()
  }
}
