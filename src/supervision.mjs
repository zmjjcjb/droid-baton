import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import * as evidence from './evidence.mjs'
import { now, readJson, writeJson } from './config.mjs'
import { ownedProcess, processAlive, processIdentity, stopProcess } from './processes.mjs'
import { savedOutcome } from './discovery.mjs'

export function supervisionOptions(value) {
  if (value === undefined || value === false) return null
  if (value !== true && (!value || typeof value !== 'object' || Array.isArray(value))) throw new Error('supervision 必须是 true/false 或监督配置对象。')
  const v = value === true ? {} : value
  const defaults = { interval_s: 300, stall_s: 900, max_rounds: 12, max_repairs: 2, max_tokens: 0, auto_continue: true, require_review: true, notify_progress: false }
  if (Object.keys(v).some(k => !(k in defaults))) throw new Error('未知 supervision 配置项。')
  const result = { ...defaults, ...v }
  for (const [key, min, max] of [['interval_s', 10, 86400], ['stall_s', 10, 86400], ['max_rounds', 1, 50], ['max_repairs', 0, 10], ['max_tokens', 0, 100000000]]) {
    if (!Number.isInteger(result[key]) || result[key] < min || result[key] > max) throw new Error(`supervision.${key} 必须在 ${min}–${max} 之间。`)
  }
  for (const key of ['auto_continue', 'require_review', 'notify_progress']) if (typeof result[key] !== 'boolean') throw new Error(`supervision.${key} 必须是布尔值。`)
  return result
}

export const CONTRACT = `\n\n【长期任务监督协议】\n你正在同一个有预算上限的长期目标中执行一轮工作。原始目标和授权范围不变。可以分轮推进，不要把“本轮回复结束”当成整个目标完成。不要启动无人收集结果的后台工作：启动后必须记录任务 ID，并在结束前使用相应 TaskOutput/输出文件收集状态。不得把轮询服务进程等应当持续运行的进程当成已完成产物；如必须常驻，向监督者说明。\n每轮最终回复的最后必须追加以下代码块，内容为严格 JSON（不要省略 remaining）：\n\`\`\`droid-baton\n{"status":"continue","summary":"本轮实际完成了什么","remaining":["尚未完成的具体事项"]}\n\`\`\`\nstatus 只能为 continue、complete 或 blocked。只有原目标全部满足、remaining 为空、已收集全部本任务后台结果时才可使用 complete。确需新的授权/信息或无法推进时使用 blocked，不要自行扩大范围或重试账号/额度/认证错误。完成声明还会接受独立检查和主控审查。`

export function checkpoint(text) {
  const matches = [...String(text || '').matchAll(/```droid-baton\s*\n([\s\S]*?)```/g)]
  if (!matches.length) return null
  try {
    const p = JSON.parse(matches.at(-1)[1])
    if (!['continue', 'complete', 'blocked'].includes(p.status) || typeof p.summary !== 'string' || p.summary.length > 4000 || !Array.isArray(p.remaining) || p.remaining.length > 50 || p.remaining.some(x => typeof x !== 'string' || x.length > 4000)) return null
    if (p.status === 'complete' && p.remaining.length) return null
    return { status: p.status, summary: p.summary, remaining: p.remaining }
  } catch { return null }
}

const finished = state => ['completed', 'failed', 'cancelled', 'interrupted'].includes(state)
const settled = status => ['completed', 'failed', 'cancelled', 'done', 'success', 'error', 'stopped', 'exited'].includes(status)
const asText = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(x => x.type === 'text').map(x => x.text).join('\n') : ''
const safeId = value => typeof value === 'string' && value.length < 250 && /^[\w.:/-]+$/.test(value)
const isBackground = tool => !!(tool?.input?.fireAndForget || tool?.input?.run_in_background || tool?.input?.background || (tool?.name === 'Task' && tool.input.await !== true && tool.input.run_in_background !== false))

// A stable key for a tool's arguments, so two calls with the same shape count
// as the same call. Key order must not matter.
const stableArgs = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stableArgs).join(',')}]`
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableArgs(value[k])}`).join(',')}}`
}
// How many times the most recent call repeats the one before it. This is the
// "stuck right now" signal: a worker that repeats the same call three times in
// a row is spinning, while one that did so and then moved on is not.
const maxRepeat = list => {
  let current = 0, previous = null
  for (const item of list) {
    current = item === previous ? current + 1 : 1
    previous = item
  }
  return current
}

export function liveWork(r) {
  const work = r.work || {}
  const jobs = Object.values(work.jobs || {}).filter(j => !settled(j.status))
  const workers = Object.values(work.workers || {}).filter(w => !settled(w.status))
  const mission = work.mission && (work.mission.state !== 'completed' || work.mission.features?.some(f => !['completed', 'cancelled'].includes(f.status))) ? work.mission : null
  return { jobs, workers, mission, active: jobs.length > 0 || workers.length > 0 || !!mission }
}

// Pure event reducer. Heartbeats prove liveness, not semantic progress. Native
// Mission/workers and observed Task/Execute background receipts block completion.
export function observeWork(r, n, time = Date.now()) {
  r.activity ||= { last_progress_ms: time, last_event_ms: time, progress_events: 0, tool_calls: 0, tool_results: 0 }
  r.activity.last_event_ms = time
  r.work ||= { tools: {}, jobs: {}, workers: {} }
  const w = r.work
  const meaningful = ['assistant_text_delta', 'thinking_text_delta', 'create_message', 'tool_call', 'tool_result', 'tool_progress_update', 'mission_features_changed', 'mission_progress_entry', 'mission_worker_started', 'mission_worker_completed']
  if (meaningful.includes(n.type)) { r.activity.last_progress_ms = time; r.activity.progress_events++ }
  if (n.type === 'tool_call') {
    const u = n.toolUse || {}, id = u.id
    if (!w.tools[id]) r.activity.tool_calls++
    r.activity.last_tool = u.name
    // A worker that repeats the same call with the same arguments is stuck. The
    // count is what turns "no progress" into an actionable diagnosis.
    const signature = `${u.name}\u0000${stableArgs(u.input)}`
    const seen = r.activity.signatures || (r.activity.signatures = [])
    seen.push(signature)
    if (seen.length > 40) seen.splice(0, seen.length - 40)
    r.activity.repeated = maxRepeat(seen)
    if (safeId(id)) {
      const previous = w.tools[id]
      w.tools[id] = { ...previous, id, name: u.name, input: u.input || {}, started_at: previous?.started_at || now() }
      if (u.name === 'Task' && u.input?.resume && !('resume_baseline' in w.tools[id])) w.tools[id].resume_baseline = savedOutcome(u.input.resume)?.turn_id || null
      // Background admission blocks completion even before its result has an ID.
      if (isBackground(w.tools[id])) w.jobs[`tool:${id}`] = { id: `tool:${id}`, source: u.name, tool_id: id, status: 'pending', observed: true }
      else delete w.jobs[`tool:${id}`]
      const entries = Object.keys(w.tools); for (const key of entries.slice(0, Math.max(0, entries.length - 100))) delete w.tools[key]
    }
  } else if (n.type === 'tool_result') {
    r.activity.tool_results++
    const tool = w.tools[n.toolUseId], text = asText(n.content)
    if (tool) {
      tool.ended_at = now(); tool.is_error = !!n.isError
      if (tool.name === 'Execute' && tool.input.fireAndForget) {
        const pid = Number(text.match(/(?:PID|process id)\s*[:=]\s*(\d+)/i)?.[1])
        if (pid > 1) {
          const identity = ownedProcess(pid, r.owner_pid), exists = processIdentity(pid)
          delete w.jobs[`tool:${tool.id}`]
          w.jobs[`pid:${pid}`] = { id: `pid:${pid}`, source: 'Execute', tool_id: tool.id, pid, identity, observed: true, status: identity ? 'running' : exists ? 'unknown' : 'exited' }
        }
      }
      let payload
      try { payload = JSON.parse(text) } catch {}
      const taskId = payload?.task_id || payload?.taskId || payload?.background_task_id || payload?.backgroundTaskId
      if (safeId(taskId)) {
        delete w.jobs[`tool:${tool.id}`]
        w.jobs[taskId] = { id: taskId, source: w.jobs[taskId]?.source || tool.name, tool_id: w.jobs[taskId]?.tool_id || tool.id, status: payload.status || (n.isError ? 'failed' : 'running'), observed: true, updated_at: now() }
      } else if (w.jobs[`tool:${tool.id}`] && n.isError) w.jobs[`tool:${tool.id}`].status = 'failed'
      // Known Droid human-readable receipts are retained conservatively. A
      // generic word such as "done" in prose never settles an observed job.
      const reportedId = text.match(/(?:task[_ ]id|background[_ ]task[_ ]id)\s*[:=]\s*["']?([\w.-]+)/i)?.[1]
      if (safeId(reportedId) && !taskId) {
        delete w.jobs[`tool:${tool.id}`]
        w.jobs[reportedId] = { id: reportedId, source: tool.name, tool_id: tool.id, status: 'unknown', observed: true, updated_at: now() }
      }
      if (tool.name === 'TaskOutput' || tool.name === 'TaskStop') {
        const target = tool.input.task_id || tool.input.taskId
        if (w.jobs[target]) {
          const status = payload?.status
          if (settled(status)) w.jobs[target].status = status
          else if (tool.name === 'TaskStop' && !n.isError) w.jobs[target].status = 'cancelled'
          w.jobs[target].updated_at = now()
          if (settled(w.jobs[target].status)) for (const worker of Object.values(w.workers)) if (worker.tool_id === w.jobs[target].tool_id) worker.status = w.jobs[target].status
        }
      }
      if (!isBackground(tool) && !/still running|running in (?:the )?background|background task/i.test(text)) {
        for (const job of Object.values(w.jobs)) if (job.tool_id === tool.id && job.source === 'Execute') job.status = n.isError ? 'failed' : 'completed'
        if (tool.name === 'Task') for (const worker of Object.values(w.workers)) if (worker.tool_id === tool.id) worker.status = n.isError ? 'failed' : 'completed'
      }
    }
  } else if (n.type === 'tool_progress_update') {
    const update = n.update || {}, id = update.terminalId
    if (safeId(id)) {
      const done = update.exitCode !== undefined || update.signal
      w.jobs[`terminal:${id}`] = { id: `terminal:${id}`, source: 'Execute', tool_id: n.toolUseId, status: done ? (update.exitCode === 0 ? 'completed' : 'failed') : 'running', exit_code: update.exitCode, updated_at: now(), observed: true }
      if (done) delete w.jobs[`tool:${n.toolUseId}`]
    }
    if (safeId(update.subagentSessionId)) w.workers[update.subagentSessionId] ||= { id: update.subagentSessionId, tool_id: n.toolUseId, status: 'running', source: 'Task' }
  } else if (n.type === 'child_session_available') {
    if (safeId(n.childSessionId)) w.workers[n.childSessionId] = { id: n.childSessionId, status: 'running', source: 'Task', tool_id: n.toolUseId, baseline_turn_id: w.tools[n.toolUseId]?.resume_baseline }
  } else if (n.type === 'mission_state_changed') {
    w.mission = { ...w.mission, state: n.state, updated_at: n.updatedAt || now() }
  } else if (n.type === 'mission_features_changed') {
    w.mission = { ...w.mission, state: w.mission?.state || 'unknown', features: n.features.map(f => ({ id: f.id, status: f.status, description: f.description })).slice(0, 200) }
  } else if (n.type === 'mission_worker_started') {
    w.workers[n.workerSessionId] = { id: n.workerSessionId, status: 'running', source: 'Mission' }
  } else if (n.type === 'mission_worker_completed') {
    w.workers[n.workerSessionId] = { ...w.workers[n.workerSessionId], id: n.workerSessionId, status: n.exitCode === 0 ? 'completed' : 'failed', exit_code: n.exitCode }
  }
}

export class Supervisor {
  constructor(broker) {
    this.broker = broker; this.checking = new Set()
    this.timer = setInterval(() => { void this.tick().catch(error => {
      for (const r of Object.values(broker.state.runs)) if (r.supervision && !finished(r.state)) {
        try { this.attention(r, 'supervisor_error', `监督扫描异常：${error.message}`) } catch {}
      }
      process.stderr.write(`Droid Baton supervision: ${error.message}\n`)
    }) }, 1000).unref()
  }
  initialize(r) {
    if (!r.supervision) return
    const time = Date.now()
    r.supervisor = { round: 0, repairs: 0, total_tokens: 0, history: [], last_notice_ms: time, last_scan_ms: time, checks_serial: 0 }
  }
  beginTurn(r, kind) {
    r.turn_open = true; r.native_round_open = false; r.native_busy = false; r.turn_started_ms = Date.now(); r.attention = null; r.checkpoint = null
    r.activity ||= { last_progress_ms: Date.now(), last_event_ms: Date.now(), progress_events: 0, tool_calls: 0, tool_results: 0 }
    if (r.supervisor) { r.supervisor.round++; r.supervisor.current_kind = kind }
  }
  prompt(r, text) { return r.supervision ? text + CONTRACT : text }
  attention(r, kind, message, state) {
    if (finished(r.state)) return
    if (state) r.state = state
    if (r.attention?.kind === kind) return
    r.attention = { id: `notice-${crypto.randomUUID()}`, kind, message, created_at: now(), round: r.supervisor?.round }
    if (r.supervisor) r.supervisor.last_notice_ms = Date.now()
    this.broker.event(r, 'supervision_attention', { attention: r.attention }); this.broker.changed()
  }
  async tick(time = Date.now()) {
    const b = this.broker
    for (const r of Object.values(b.state.runs)) {
      if (finished(r.state) || !r.started_at || ['waiting', 'checking', 'paused', 'starting', 'queued'].includes(r.state)) continue
      let ended = false
      for (const job of Object.values(r.work?.jobs || {})) if (job.identity && !settled(job.status) && !processAlive(job.identity)) { job.status = 'exited'; job.exit_code = null; ended = true; b.event(r, 'background_process_exited', { pid: job.pid, note: '进程已退出，退出码未由此通道提供。' }) }
      for (const worker of Object.values(r.work?.workers || {})) if (worker.source === 'Task' && !settled(worker.status)) {
        const outcome = savedOutcome(worker.id)
        if (!outcome) continue
        if (outcome.modified_ms > (worker.log_modified_ms || 0)) { worker.log_modified_ms = outcome.modified_ms; if (r.activity) r.activity.last_progress_ms = Date.now() }
        if (!outcome.reason || outcome.turn_id === worker.baseline_turn_id) continue
        worker.status = outcome.reason === 'completed' ? 'completed' : 'failed'; worker.outcome = outcome.reason
        for (const job of Object.values(r.work.jobs)) if (job.id === worker.id || job.tool_id === worker.tool_id) job.status = worker.status
        ended = true; b.event(r, 'native_child_ended', { child_id: worker.id, reason: outcome.reason })
      }
      if (ended) {
        r.work_quiet_since = Date.now()
        if (r.activity) r.activity.last_progress_ms = time
      }
      if (r.state === 'background') await this.settle(b.getSession(r.session_id), r)
      if (!r.supervision || r.attention || finished(r.state) || ['review', 'checking'].includes(r.state)) continue
      const cfg = r.supervision, supervisor = r.supervisor, a = r.activity || {}
      const lastScan = supervisor.last_scan_ms ?? supervisor.last_notice_ms
      const lastProgress = Math.max(a.last_progress_ms || 0, r.turn_started_ms || 0)
      const stalled = time - lastProgress >= cfg.stall_s * 1000
      const newStall = stalled && lastProgress !== supervisor.acknowledged_stall_progress_ms
      const scanSince = cfg.notify_progress ? Math.max(lastScan, supervisor.last_notice_ms) : lastScan
      const due = time - scanSince >= cfg.interval_s * 1000
      if (!newStall && !due) continue
      // An overdue stall gets a file scan before it can wake a waiting client.
      supervisor.last_scan_ms = time
      r.file_progress = evidence.changedSince(r.cwd, lastScan, { max: 10 })
      if (r.file_progress?.count) { a.last_progress_ms = time; a.progress_events = (a.progress_events || 0) + 1 }
      // Repeated tool calls are a hint for review, not evidence of a stall.
      const diagnosis = []
      if ((a.repeated || 0) >= 3) diagnosis.push(`同一工具调用已连续重复 ${a.repeated} 次，可能原地打转`)
      if (a.last_tool) diagnosis.push(`最后工具：${a.last_tool}`)
      else diagnosis.push('尚未观察到任何工具调用')
      if (r.file_progress?.count) diagnosis.push(`最近有 ${r.file_progress.count} 个文件变化`)
      const suffix = diagnosis.length ? `（${diagnosis.join('；')}）` : ''
      if (newStall && !r.file_progress?.count) {
        supervisor.stalled_progress_ms = lastProgress
        this.attention(r, 'stalled', `一段时间没有内容、工具或文件进展；可能是慢任务，也可能卡住。请判断是否继续等待或纠偏。${suffix}`)
      } else {
        const text = `第 ${supervisor.round} 轮本地巡检${suffix}`
        b.event(r, 'supervision_checkpoint', { text, round: supervisor.round })
        if (cfg.notify_progress && time - supervisor.last_notice_ms >= cfg.interval_s * 1000) {
          this.attention(r, 'checkpoint', text)
        }
      }
    }
  }
  async ended(s, r, n) {
    if (finished(r.state) || r.state === 'paused') return
    r.turn_open = false; r.native_round_open = false; r.native_busy = false; r.last_completed_turn_id = n.turnId || r.turn_id
    if (r.supervisor) {
      r.supervisor.total_tokens += (n.tokenUsage?.inputTokens || 0) + (n.tokenUsage?.outputTokens || 0)
      r.supervisor.history.push({ round: r.supervisor.round, turn_id: n.turnId || r.turn_id, reason: n.reason, summary: r.final_text?.slice(-6000), usage: n.tokenUsage, ended_at: now() })
      r.supervisor.history = r.supervisor.history.slice(-50)
    }
    if (n.reason !== 'completed') return await this.broker.finish(s, r, n.reason === 'cancelled' ? 'cancelled' : 'failed', r.last_error || n.reason)
    r.checkpoint = r.supervision ? checkpoint(r.final_text) : null
    await this.settle(s, r)
  }
  async settle(s, r) {
    if (finished(r.state) || r.turn_open || this.checking.has(r.run_id) || ['paused', 'waiting'].includes(r.state)) return
    const pending = liveWork(r)
    if (pending.active) {
      if (r.state !== 'background') { r.state = 'background'; this.broker.changed() }
      if (pending.mission && ['paused', 'awaiting_input'].includes(pending.mission.state)) this.attention(r, 'mission_waiting', `原生 Mission 处于 ${pending.mission.state}，目标尚未完成。`)
      // No fabricated Task completion. Let Droid collect TaskOutput in a bounded
      // next round when no Mission/worker event can settle the result for us.
      if (r.supervision && !pending.mission && pending.workers.every(w => w.source === 'Task' && !savedOutcome(w.id)) && pending.jobs.length && !pending.jobs.every(j => j.identity)) {
        return await this.continue(s, r, `尚有未确认结束的后台工作：${JSON.stringify(pending.jobs.map(j => ({ id: j.id, source: j.source, status: j.status })))}。请使用原生 TaskOutput（block=true）或对应终端输出收集结果，等待本目标工作完成。不要重复启动相同任务。`, 'background')
      }
      if (!r.supervision) this.attention(r, 'background_pending', '本轮虽已结束，但观察到尚未收集的后台工作。请继续同一运行收集结果，或明确停止；不能直接宣布完成。')
      return
    }
    if (r.native_busy || r.native_round_open) return
    if (r.state === 'background') {
      r.work_quiet_since ||= Date.now()
      if (Date.now() - r.work_quiet_since < 1500) return
      r.attention = null
    }
    if (!r.supervision) return await this.broker.finish(s, r, 'completed')
    if (r.supervision.max_tokens && r.supervisor.total_tokens >= r.supervision.max_tokens) return this.attention(r, 'token_budget', '达到任务 Token 预算；已停止自动续做，等待主控处理。', 'review')
    const p = r.checkpoint
    if (!p) return this.attention(r, 'missing_checkpoint', '本轮缺少有效的结构化目标报告；不能据此认定长期目标完成。可要求补报或继续执行。', 'review')
    if (p.status === 'blocked') return this.attention(r, 'blocked', p.summary, 'review')
    if (p.status === 'continue') return await this.continue(s, r, `继续原始目标，推进这些尚未完成的事项：\n${p.remaining.join('\n')}\n上轮摘要：${p.summary}。不要扩大原授权范围。`, 'continuation')
    r.state = 'checking'; this.broker.changed(); this.checking.add(r.run_id)
    try {
      await this.verify(r)
      if (finished(r.state) || r.state === 'paused') return
      if (r.checks.length && !r.evidence?.all_checks_passed) {
        if (r.supervisor.repairs < r.supervision.max_repairs && r.supervision.auto_continue) {
          r.supervisor.repairs++
          return await this.continue(s, r, `目标尚未通过桥接程序独立验收。仅修复原目标相关问题，不要修改验收标准或放宽测试：\n${JSON.stringify(r.evidence?.checks).slice(0, 14000)}`, 'repair')
        }
        return this.attention(r, 'checks_failed', '独立验收失败；已达到自动修复上限或关闭自动续做，需要主控判断。', 'review')
      }
      if (!r.checks.length) return this.attention(r, 'unverified_complete', 'Droid 声明完成，但没有独立检查命令。需要主控审查产物并明确接收。', 'review')
      if (r.supervision.require_review) return this.attention(r, 'ready_for_review', 'Droid 声明目标完成、已观察后台工作结束且独立检查通过。请主控审查需求覆盖后 accept。', 'review')
      return await this.broker.finish(s, r, 'completed', undefined, { evidenceReady: true })
    } catch (error) {
      if (!finished(r.state) && r.state !== 'paused') this.attention(r, 'verification_error', error.message, 'review')
    } finally { this.checking.delete(r.run_id) }
  }
  async verify(r) {
    const b = this.broker, id = `${r.run_id}-check-${++r.supervisor.checks_serial}`
    const base = path.join(b.home, 'evidence', `${r.run_id}.json`), before = base.replace(/\.json$/, '.before.json')
    const rec = readJson(base)
    if (!rec || !fs.existsSync(before)) throw new Error('长期任务初始快照缺失，不能生成完整目标证据。')
    const copy = path.join(b.home, 'evidence', `${id}.json`)
    writeJson(copy, { ...rec, result: undefined, checks: r.checks })
    fs.copyFileSync(before, copy.replace(/\.json$/, '.before.json'))
    r.evidence = await b.collect(r, { evidenceId: id })
    if (r.evidence) r.evidence_record = copy
    r.evidence_at = now(); r.evidence_turn_id = r.last_completed_turn_id || r.turn_id
    return r.evidence
  }
  async continue(s, r, message, kind) {
    if (finished(r.state) || r.state === 'paused') return
    if (r.supervisor.round >= r.supervision.max_rounds) return this.attention(r, 'round_budget', '达到自动执行轮次上限；目标未被认定完成。', 'review')
    if (r.supervision.max_tokens && r.supervisor.total_tokens >= r.supervision.max_tokens) return this.attention(r, 'token_budget', '达到 Token 预算，已停止自动续做。', 'review')
    if (!r.supervision.auto_continue) return this.attention(r, 'continue_required', message, 'review')
    r.state = 'running'
    return await this.broker.dispatchTurn(s, r, message, kind)
  }
  async control(a) {
    const b = this.broker, r = b.getRun(a.run_id), s = b.getSession(r.session_id)
    const { detail = 'full' } = a
    if (!r.supervision) {
      if (r.state === 'background' && a.action === 'continue' && a.message?.trim() && a.reason?.trim()) {
        r.attention = null; await b.dispatchTurn(s, r, a.message, 'collect_background'); return b.status({ run_id: r.run_id, detail })
      }
      if (r.state === 'background' && a.action === 'watch') { r.attention = null; b.changed(); return b.status({ run_id: r.run_id, detail }) }
      throw new Error('该运行未启用长期监督；后台收集可用 continue+message+reason。')
    }
    if (a.attention_id && r.attention?.id !== a.attention_id) throw new Error('监督通知已过期；请读取当前状态。')
    if (finished(r.state) && !(a.action === 'resume' && r.state === 'interrupted')) throw new Error('该运行已经结束，不能重新执行。用户取消不会被自动续做。')
    if (!['watch', 'continue', 'accept', 'pause', 'resume'].includes(a.action)) throw new Error('action 支持 watch/continue/accept/pause/resume。')
    if ((this.checking.has(r.run_id) || r.state === 'checking') && a.action !== 'pause') throw new Error('独立验收正在运行，请等待或显式暂停/取消。')
    if (['accept', 'continue', 'resume'].includes(a.action) && !a.reason?.trim()) throw new Error('需要 reason 记录主控的判断依据。')
    if (a.action === 'watch') {
      if (['review', 'paused'].includes(r.state)) throw new Error('任务当前没有执行中的轮次；请明确 continue/accept/resume。')
      if (r.attention?.kind === 'stalled') r.supervisor.acknowledged_stall_progress_ms = r.supervisor.stalled_progress_ms
      r.attention = null; r.supervisor.last_notice_ms = Date.now(); this.broker.changed()
    } else if (a.action === 'pause') {
      r.state = 'paused'; r.turn_open = false; r.attention = null
      this.stopOwned(r)
      const checker = b.checkers.get(r.run_id)
      if (checker) { const { killTree } = await import('./config.mjs'); killTree(checker.pid, 'SIGKILL') }
      const handle = b.connections.get(s.session_id); b.connections.delete(s.session_id)
      if (handle) { const conn = await handle.catch(() => null); conn?.close() }
      for (const job of Object.values(r.work?.jobs || {})) if (!settled(job.status)) job.status = 'cancelled'
      for (const worker of Object.values(r.work?.workers || {})) if (!settled(worker.status)) worker.status = 'cancelled'
      b.changed()
    } else if (a.action === 'accept') {
      if (r.turn_open || r.native_busy || r.native_round_open || r.state !== 'review' || r.checkpoint?.status !== 'complete' || liveWork(r).active) throw new Error('目标尚未具备接收条件：需要完整报告、当前轮次结束及已观察后台工作结束。')
      if (!r.checks.length && !a.accept_without_checks) throw new Error('未配置独立检查；审查产物后需显式 accept_without_checks=true。')
      if (!r.evidence || r.evidence.workspace_stamp !== evidence.fingerprint(r.cwd)) {
        this.checking.add(r.run_id); r.state = 'checking'; b.changed()
        try { await this.verify(r) } finally { this.checking.delete(r.run_id); if (r.state === 'checking') r.state = 'review' }
      }
      if (finished(r.state) || r.state === 'paused') throw new Error('目标在复核期间已停止或暂停，未接收。')
      if (r.checks.length && !r.evidence?.all_checks_passed) { this.attention(r, 'checks_failed', '接收前复核发现独立检查未通过，不能接收。', 'review'); throw new Error('独立检查未通过。') }
      r.acceptance = { reason: a.reason, time: now(), without_checks: !r.checks.length }
      await b.finish(s, r, 'completed', undefined, { evidenceReady: true })
    } else {
      if (r.state === 'paused' && a.action !== 'resume') throw new Error('已暂停；需要显式 resume。')
      if (Date.now() >= Date.parse(r.deadline)) throw new Error('已超出原始总时限；请新建有明确预算的任务，不自动延长。')
      if (r.supervisor.round >= r.supervision.max_rounds) throw new Error('轮次预算已经耗尽，请明确新任务预算。')
      if (r.supervision.max_tokens && r.supervisor.total_tokens >= r.supervision.max_tokens) throw new Error('Token 预算已经耗尽。')
      if (a.action === 'resume' && !['paused', 'interrupted'].includes(r.state)) throw new Error('resume 仅用于暂停或中断的目标。')
      if (r.state === 'interrupted') {
        const other = Object.values(b.state.runs).find(x => !finished(x.state) && x.run_id !== r.run_id && (x.cwd === r.cwd || x.session_id === r.session_id))
        if (other) throw new Error('该目录/会话已有其他运行，不能恢复旧目标。')
        s.active_run = r.run_id; r.ended_at = null; r.error = null
        r.turn_open = false
        b.timers.set(r.run_id, setTimeout(() => { void b.cancel({ run_id: r.run_id, reason: '总时限已到。', timeout: true }) }, Math.max(1, Date.parse(r.deadline) - Date.now())))
      }
      const message = a.message || '根据原始目标和上次监督摘要继续未完成事项，严格保留原授权范围。'
      r.attention = null; r.supervisor.last_notice_ms = Date.now()
      if (r.turn_open) await b.send({ session_id: s.session_id, mode: 'steer', message })
      else { r.state = 'running'; await b.dispatchTurn(s, r, message, a.action) }
    }
    b.event(r, 'supervisor_decision', { action: a.action, reason: a.reason, message: a.message })
    b.changed(); return b.status({ run_id: r.run_id, detail })
  }
  stopOwned(r) {
    for (const job of Object.values(r.work?.jobs || {})) if (job.identity) { try { if (stopProcess(job.identity)) job.status = 'cancelled' } catch {} }
  }
  async nativeRound(s, r) {
    if (!r.supervision || r.native_round_open) return true
    const budget = r.supervisor.round >= r.supervision.max_rounds ? 'round_budget' : r.supervision.max_tokens && r.supervisor.total_tokens >= r.supervision.max_tokens ? 'token_budget' : null
    if (budget) {
      r.state = 'paused'; r.turn_open = false; this.stopOwned(r)
      this.attention(r, budget, '预算已到，已阻止原生后台完成通知继续启动模型轮次；目标未被认定完成。')
      const handle = this.broker.connections.get(s.session_id); this.broker.connections.delete(s.session_id)
      if (handle) (await handle.catch(() => null))?.close()
      return false
    }
    r.native_round_open = true; r.supervisor.round++; r.supervisor.current_kind = 'native_background'
    r.state = 'background'; r.attention = null
    this.broker.event(r, 'native_background_turn', { round: r.supervisor.round })
    return true
  }
  close() { clearInterval(this.timer) }
}
