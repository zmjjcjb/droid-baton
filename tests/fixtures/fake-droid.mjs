#!/usr/bin/env node
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
const sessions = process.env.DROID_FAKE_SESSIONS
let sid, cwd, activeId, pending, settings = { modelId: 'fake-default', autonomyLevel: 'off' }
let scenario, goalRound = 0
const send = x => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', type: x.method ? 'notification' : 'response', factoryApiVersion: '1.0.0', factoryProtocolVersion: '1.260.0', ...x }) + '\n')
const notify = n => send({ method: 'droid.session_notification', params: { sessionId: sid, notification: n } })
function complete(text = 'FAKE_DONE', reason = 'completed') {
  notify({ type: 'create_message', message: { id: crypto.randomUUID(), role: 'assistant', content: [{ type: 'text', text }] } })
  notify({ type: 'agent_turn_completed', turnId: activeId, reason, tokenUsage: { inputTokens: 5, outputTokens: 2 }, durationMs: 20 })
}
function run(text) {
  scenario ||= text.match(/MOCK:GOAL_(\w+)/)?.[1]
  if (scenario) {
    goalRound++
    const cp = (status, remaining = [], summary = '本轮完成') => `第 ${goalRound} 轮\n\`\`\`droid-baton\n${JSON.stringify({ status, summary, remaining })}\n\`\`\``
    if (scenario === 'WAIT') return
    if (scenario === 'PID' || scenario === 'PIDHANG' || scenario === 'NATIVEBUDGET') {
      notify({ type: 'tool_call', toolUse: { id: 'pid-launch', name: 'Execute', input: { fireAndForget: true, command: 'node background' } } })
      const program = scenario === 'PID' ? "setTimeout(()=>require('fs').writeFileSync('pid-result.txt','DONE'),180)" : 'setInterval(()=>{},1000)'
      const child = spawn(process.execPath, ['-e', program], { cwd, detached: true, stdio: 'ignore' }); child.unref()
      fs.writeFileSync(path.join(cwd, 'detached.pid'), String(child.pid))
      notify({ type: 'tool_result', toolUseId: 'pid-launch', content: `Background process started (PID: ${child.pid})\nStatus: Running in background` })
      if (scenario === 'NATIVEBUDGET') setTimeout(() => notify({ type: 'droid_working_state_changed', newState: 'thinking' }), 70)
      return setTimeout(() => complete(cp('complete')), 20)
    }
    if (scenario === 'STAGES') {
      fs.writeFileSync(path.join(cwd, goalRound === 1 ? 'a.txt' : 'b.txt'), goalRound === 1 ? 'PHASE1' : 'DONE')
      return setTimeout(() => complete(cp(goalRound === 1 ? 'continue' : 'complete', goalRound === 1 ? ['完成第二阶段'] : [])), 20)
    }
    if (scenario === 'REPAIR' || scenario === 'CHECKFAIL') {
      fs.writeFileSync(path.join(cwd, 'result.txt'), scenario === 'REPAIR' && goalRound > 1 ? 'GOOD' : 'BAD')
      return setTimeout(() => complete(cp('complete')), 20)
    }
    if (scenario === 'STUCK') return setTimeout(() => complete(cp('continue', ['同一事项'])), 20)
    if (scenario === 'MISSING') return setTimeout(() => complete('未按协议汇报'), 20)
    if (scenario === 'MISSION') {
      notify({ type: 'mission_state_changed', state: 'running' })
      notify({ type: 'mission_worker_started', workerSessionId: 'worker-mission-1' })
      setTimeout(() => complete(cp('complete')), 20)
      setTimeout(() => notify({ type: 'mission_worker_completed', workerSessionId: 'worker-mission-1', exitCode: 0 }), 130)
      setTimeout(() => { fs.writeFileSync(path.join(cwd, 'mission.txt'), 'DONE'); notify({ type: 'mission_state_changed', state: 'completed' }) }, 230)
      return
    }
    if (scenario === 'BACKGROUND') {
      if (goalRound === 1) {
        notify({ type: 'tool_call', toolUse: { id: 'bg-launch', name: 'Task', input: { run_in_background: true } } })
        notify({ type: 'child_session_available', childSessionId: 'worker-task-1', toolUseId: 'bg-launch' })
        notify({ type: 'tool_result', toolUseId: 'bg-launch', content: JSON.stringify({ task_id: 'task-1', status: 'running' }) })
      } else {
        notify({ type: 'tool_call', toolUse: { id: 'bg-output', name: 'TaskOutput', input: { task_id: 'task-1', block: true } } })
        fs.writeFileSync(path.join(cwd, 'background.txt'), 'DONE')
        notify({ type: 'tool_result', toolUseId: 'bg-output', content: JSON.stringify({ task_id: 'task-1', status: 'completed' }) })
      }
      return setTimeout(() => complete(cp('complete')), 20)
    }
    return setTimeout(() => complete(cp('complete')), 20)
  }
  if (text.includes('MOCK:WAIT')) return
  if (text.includes('MOCK:QUESTION')) {
    pending = { id: 'question-1', kind: 'question' }
    return send({ type: 'request', id: pending.id, method: 'droid.ask_user', params: { toolCallId: 't1', questions: [{ index: 1, topic: '颜色', question: '选什么颜色？', options: ['红色', '蓝色'] }] } })
  }
  if (text.includes('MOCK:PERMISSION')) {
    pending = { id: 'permission-1', kind: 'permission' }
    return send({ type: 'request', id: pending.id, method: 'droid.request_permission', params: { toolUses: [{ details: { type: 'execute', command: 'echo test' } }], options: [{ value: 'proceed_once', label: 'Allow once' }, { value: 'cancel', label: 'Cancel' }] } })
  }
  if (text.includes('MOCK:PICK')) {
    pending = { id: 'pick-1', kind: 'pick' }
    return send({ type: 'request', id: pending.id, method: 'droid.pick_options', params: { rows: [{ id: 'a', label: 'A' }], multi: false, preselectedIds: [] } })
  }
  if (text.includes('MOCK:TREE')) {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
    fs.writeFileSync(path.join(cwd, 'descendant.pid'), String(child.pid)); return
  }
  if (text.includes('MOCK:WRITE')) fs.writeFileSync(path.join(cwd, 'result.txt'), 'verified\n')
  if (text.includes('MOCK:FAIL')) { notify({ type: 'error', message: 'intentional failure' }); return setTimeout(() => complete('failed', 'error'), 20) }
  notify({ type: 'tool_call', toolUse: { name: 'Read', input: { path: 'README.md' } } })
  notify({ type: 'assistant_text_delta', messageId: 'm', blockIndex: 0, textDelta: 'streaming...' })
  setTimeout(() => complete(), text.includes('MOCK:SLOW') ? 250 : 30)
}
readline.createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (!m.method) {
    if (m.id !== pending?.id) return
    const p = pending; pending = null
    return complete(JSON.stringify(m.result), p.kind === 'permission' && m.result.selectedOption === 'cancel' ? 'permission_rejected' : 'completed')
  }
  if (m.type !== 'request') return
  let result = {}
  switch (m.method) {
    case 'droid.list_models': result = { models: [{ id: 'fake-default', displayName: 'Fake', disabled: false }] }; break
    case 'droid.initialize_session':
      sid = crypto.randomUUID(); cwd = m.params.cwd; settings = { ...settings, ...m.params, modelId: m.params.modelId || settings.modelId }
      fs.mkdirSync(sessions, { recursive: true }); fs.writeFileSync(path.join(sessions, sid + '.json'), JSON.stringify({ cwd, settings }))
      result = { sessionId: sid, settings }; break
    case 'droid.load_session':
      sid = m.params.sessionId
      try { ({ cwd, settings } = JSON.parse(fs.readFileSync(path.join(sessions, sid + '.json')))) } catch { return send({ id: m.id, error: { code: -1, message: 'Session not found' } }) }
      result = { sessionId: sid, cwd, settings }; break
    case 'droid.rename_session': result = { success: true }; break
    case 'droid.update_session_settings': settings = { ...settings, ...m.params }; result = { settings }; break
    case 'droid.add_user_message':
      send({ id: m.id, result: { success: true } })
      if (m.params.queuePlacement === 'end_of_loop') return setTimeout(() => complete('STEERED:' + m.params.text), 20)
      activeId = m.params.messageId; run(m.params.text); return
    case 'droid.interrupt_session': send({ id: m.id, result: {} }); return complete('interrupted', 'cancelled')
    default: return send({ id: m.id, error: { code: -32601, message: 'Unknown method' } })
  }
  send({ id: m.id, result })
})
