import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import http from 'node:http'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const fixture = fileURLToPath(new URL('./fixtures/fake-droid.mjs', import.meta.url))
fs.chmodSync(fixture, 0o755)
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function context(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-baton-mcp-'))
  const home = path.join(dir, 'home'), cwd = path.join(dir, 'project'); fs.mkdirSync(cwd)
  const env = { ...process.env, DROID_BATON_HOME: home, DROID_BIN: fixture, DROID_FAKE_SESSIONS: path.join(dir, 'native') }
  const proc = spawn(process.execPath, [path.join(root, 'src/server.mjs')], { env, stdio: ['pipe', 'pipe', 'pipe'] })
  proc.stdin.on('error', () => {})
  let id = 0, stderr = ''; const calls = new Map()
  proc.stderr.on('data', b => { stderr += b })
  const reader = readline.createInterface({ input: proc.stdout })
  reader.on('line', line => {
    const msg = JSON.parse(line), own = calls.get(msg.id)
    if (own) { calls.delete(msg.id); clearTimeout(own.timer); msg.error ? own.reject(new Error(msg.error.message)) : own.resolve(msg.result) }
  })
  function request(method, params) {
    const requestId = ++id
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP request timeout: ${stderr}`)), 15000)
      calls.set(requestId, { resolve, reject, timer })
      proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n')
    })
    promise.requestId = requestId
    promise.cancelLocal = () => { const own = calls.get(requestId); if (own) { clearTimeout(own.timer); calls.delete(requestId); own.resolve({ cancelled: true }) } }
    return promise
  }
  const tool = async (name, args = {}) => {
    const res = await request('tools/call', { name, arguments: args })
    if (res.isError) throw new Error(res.content[0].text)
    return JSON.parse(res.content[0].text)
  }
  t.after(async () => {
    proc.stdin.end(); await sleep(50); proc.kill()
    for (const c of calls.values()) clearTimeout(c.timer)
    try { const info = JSON.parse(fs.readFileSync(path.join(home, 'broker.json'))); process.kill(info.pid, 'SIGTERM') } catch {}
    await sleep(100); fs.rmSync(dir, { recursive: true, force: true })
  })
  return { dir, home, cwd, env, proc, request, tool }
}
test('Baton stdio shell: initialize, tools, send, concurrent wait/status, question and answer', async t => {
  const { request, tool, cwd } = await context(t)
  const init = await request('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'codex-test', version: '1' } })
  assert.equal(init.serverInfo.name, 'droid-baton'); assert.equal(init.capabilities.tools.listChanged, true)
  const list = await request('tools/list', {}); assert.equal(list.tools.length, 11)
  assert.ok(list.tools.every(t => t.inputSchema.type === 'object'))
  const models = await tool('droid_list_models'); assert.equal(models.models[0].id, 'fake-default')
  await assert.rejects(tool('droid_call', { name: 'exec', arguments: { command: 'echo nope' } }), /未知工具/)
  const r = await tool('droid_send', { cwd, message: 'MOCK:WAIT' })
  assert.match(r.wait_command, /cli.mjs.*wait/); assert.match(r.dashboard, /^http:\/\/127\.0\.0\.1:/)
  const waiting = tool('droid_wait', { run_id: r.run_id, timeout_s: 5 })
  const status = await tool('droid_status', { run_id: r.run_id }); assert.equal(status.state, 'running')
  await tool('droid_send', { session_id: r.session_id, mode: 'steer', message: 'finish' })
  assert.equal((await waiting).state, 'completed')
  const ask = await tool('droid_send', { session_id: r.session_id, message: 'MOCK:QUESTION' })
  const q = await tool('droid_wait', { run_id: ask.run_id, timeout_s: 5 })
  assert.deepEqual(q.pending.questions[0].options, ['红色', '蓝色'])
  const answered = await tool('droid_answer', { run_id: ask.run_id, request_id: q.pending.request_id, answers: [{ index: 1, answer: '蓝色' }] })
  assert.equal(answered.recent_events, undefined)
  assert.match((await tool('droid_wait', { run_id: ask.run_id, timeout_s: 5 })).final_text, /蓝色/)
})
test('MCP wait cancellation only releases wait; task remains available', async t => {
  const { proc, request, tool, cwd } = await context(t)
  await request('initialize', { clientInfo: { name: 'Codex' } })
  const r = await tool('droid_send', { cwd, message: 'MOCK:WAIT' })
  const waiting = request('tools/call', { name: 'droid_wait', arguments: { run_id: r.run_id, timeout_s: 20 } })
  await sleep(50)
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: waiting.requestId } }) + '\n')
  // MCP permits a cancelled request to have no reply. Baton's shell suppresses it.
  waiting.cancelLocal()
  await sleep(50)
  assert.equal((await tool('droid_status', { run_id: r.run_id })).state, 'running')
  await tool('droid_cancel', { run_id: r.run_id })
})
test('MCP long-goal wait wakes for review and supervisor acceptance finishes the same run', async t => {
  const { request, tool, cwd } = await context(t)
  await request('initialize', { clientInfo: { name: 'codex-supervision-test' } })
  const r = await tool('droid_send', { cwd, message: 'MOCK:GOAL_STAGES', supervision: true, checks: ['node -e "if(!require(\'fs\').existsSync(\'b.txt\'))process.exit(1)"'] })
  const review = await tool('droid_wait', { run_id: r.run_id, timeout_s: 5 })
  assert.equal(review.state, 'review'); assert.equal(review.needs_attention, true); assert.equal(review.supervisor.round, 2)
  assert.equal(review.checkpoint.status, 'complete')
  assert.equal(review.evidence.checks[0].passed, true)
  assert.ok(fs.existsSync(review.evidence_record))
  assert.equal(review.events, undefined)
  const done = await tool('droid_supervise', { run_id: r.run_id, action: 'accept', attention_id: review.attention.id, reason: '完整目标产物及独立检查已核对。' })
  assert.equal(done.state, 'completed'); assert.equal(done.run_id, r.run_id)
})
test('MCP dispatch, steer and cancel keep the original prompt out of default replies', async t => {
  const { request, tool, cwd, env } = await context(t)
  await request('initialize', { clientInfo: { name: 'Codex' } })
  const task = 'MOCK:WAIT ' + 'LARGE_TASK '.repeat(4000)
  const r = await tool('droid_send', { cwd, message: task })
  assert.equal(r.message, undefined)
  assert.ok(JSON.stringify(r).length < 1500)
  const result = await tool('droid_wait', { run_id: r.run_id, timeout_s: 1 })
  assert.deepEqual(result, { run_id: r.run_id, session_id: r.session_id, state: 'running', timed_out: true })
  const full = await tool('droid_status', { run_id: r.run_id, detail: 'full' })
  assert.equal(full.message, task)
  const steered = await tool('droid_send', { session_id: r.session_id, mode: 'steer', message: task })
  assert.equal(steered.delivery, 'end_of_loop'); assert.equal(steered.message, undefined)
  assert.ok(JSON.stringify(steered).length < 1700)
  const cli = promisify(execFile)(r.wait_argv[0], r.wait_argv.slice(1), { env, timeout: 8000 }).catch(error => error)
  const cancelled = await tool('droid_cancel', { run_id: r.run_id })
  assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.message, undefined)
  const command = await cli
  assert.equal(command.code, 1)
  assert.equal(JSON.parse(command.stdout).state, 'cancelled')
  assert.ok(Array.isArray(JSON.parse(command.stdout).recent_events))
})
test('MCP wait includes the requested operation and scope for a permission decision', async t => {
  const { tool, cwd } = await context(t)
  const run = await tool('droid_send', { cwd, message: 'MOCK:PERMISSION' })
  const r = await tool('droid_wait', { run_id: run.run_id, timeout_s: 5 })
  assert.equal(r.pending.toolUses[0].details.command, 'echo test')
  await tool('droid_answer', { run_id: run.run_id, request_id: r.pending.request_id, selected_option: 'cancel' })
  assert.equal((await tool('droid_wait', { run_id: run.run_id })).state, 'failed')
})
test('broker crash cleans detached native background process through worker ownership ledger', { skip: process.platform !== 'linux' }, async t => {
  const { request, tool, cwd, home, env } = await context(t)
  await request('initialize', {})
  const r = await tool('droid_send', { cwd, message: 'MOCK:GOAL_PIDHANG', supervision: true })
  const file = path.join(cwd, 'detached.pid')
  for (let i = 0; !fs.existsSync(file) && i < 100; i++) await sleep(20)
  const pid = Number(fs.readFileSync(file, 'utf8')), info = JSON.parse(fs.readFileSync(path.join(home, 'broker.json')))
  await sleep(100) // allow the supervisor's ownership ledger to reach the worker
  process.kill(info.pid, 'SIGKILL')
  const alive = () => { try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ') } catch { return false } }
  for (let i = 0; alive() && i < 100; i++) await sleep(30)
  assert.equal(alive(), false)
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'src/cli.mjs'), 'status', r.run_id], { env, timeout: 15000 })
  assert.equal(JSON.parse(stdout).state, 'interrupted')
})
test('dashboard API requires token, rejects hostile Origin and exposes live results', async t => {
  const { request, tool, cwd } = await context(t)
  await request('initialize', {})
  const r = await tool('droid_send', { cwd, message: 'MOCK:OK' })
  await tool('droid_wait', { run_id: r.run_id, timeout_s: 5 })
  const url = new URL(r.dashboard), token = url.hash.slice(1), origin = url.origin
  assert.equal((await fetch(origin + '/')).status, 200)
  assert.equal((await fetch(origin + '/api/state')).status, 401)
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
  assert.equal((await fetch(origin + '/api/state', { headers: { ...headers, Origin: 'https://evil.example' } })).status, 403)
  const state = await (await fetch(origin + '/api/state', { headers })).json()
  assert.equal(state.runs[0].state, 'completed')
  const detail = await (await fetch(origin + '/api/call', { method: 'POST', headers, body: JSON.stringify({ method: 'status', params: { run_id: r.run_id } }) })).json()
  assert.equal(detail.result.final_text, 'FAKE_DONE')
  const hostileHost = await new Promise((resolve, reject) => {
    const req = http.get(origin + '/api/state', { headers: { ...headers, Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode) }); req.on('error', reject)
  })
  assert.equal(hostileHost, 403)
})

test('MCP death leaves task running; broker death cleans process tree and restores interrupted receipt', { skip: process.platform !== 'linux' }, async t => {
  const { proc, request, tool, cwd, home, env } = await context(t)
  await request('initialize', {})
  const r = await tool('droid_send', { cwd, message: 'MOCK:TREE' })
  const file = path.join(cwd, 'descendant.pid')
  for (let i = 0; !fs.existsSync(file) && i < 100; i++) await sleep(20)
  const descendant = Number(fs.readFileSync(file, 'utf8'))
  const info = JSON.parse(fs.readFileSync(path.join(home, 'broker.json')))
  const url = new URL(info.url), headers = { Authorization: `Bearer ${url.hash.slice(1)}`, 'Content-Type': 'application/json' }
  proc.kill('SIGKILL'); await sleep(100)
  const state = await (await fetch(url.origin + '/api/call', { method: 'POST', headers, body: JSON.stringify({ method: 'status', params: { run_id: r.run_id } }) })).json()
  assert.equal(state.result.state, 'running'); process.kill(descendant, 0)
  process.kill(info.pid, 'SIGKILL')
  const isRunning = () => { try { const stat = fs.readFileSync(`/proc/${descendant}/stat`, 'utf8'); return !stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ') } catch { return false } }
  for (let i = 0; isRunning() && i < 100; i++) await sleep(30)
  assert.equal(isRunning(), false, 'orphan watchdog must stop all tools')
  const { stdout } = await promisify(execFile)(process.execPath, [path.join(root, 'src/cli.mjs'), 'status', r.run_id], { env, timeout: 15000 })
  assert.equal(JSON.parse(stdout).state, 'interrupted')
})
