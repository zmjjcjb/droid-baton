// Opt-in, paid-model integration verification. Uses the user's existing Droid route.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { call } from '../src/client.mjs'
import { HOME, ROOT } from '../src/config.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-baton-real-'))
const report = { date: new Date().toISOString(), root, data_home: HOME, tests: [], runs: [] }
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function run(name, fn) {
  const started = Date.now()
  try { const result = await fn(); report.tests.push({ name, passed: true, seconds: (Date.now() - started) / 1000, ...result }); console.log('PASS', name) }
  catch (error) { report.tests.push({ name, passed: false, error: error.message }); console.log('FAIL', name, error.message); process.exitCode = 1 }
}
async function send(args) {
  const r = await call('send', { timeout_s: 150, ...args }); report.runs.push({ run_id: r.run_id, session_id: r.session_id }); return r
}
async function end(id) {
  const until = Date.now() + 160000
  for (;;) {
    const r = await call('wait', { run_id: id, timeout_s: 50 })
    if (!r.timed_out) return r
    if (Date.now() > until) throw new Error('live test deadline')
  }
}
let session
await run('真实文件修改与独立失败检查', async () => {
  const cwd = path.join(root, 'math'); fs.mkdirSync(cwd)
  const r = await send({ cwd, autonomy: 'low', message: '这是桥接验收的刻意失败样例。只创建 math.mjs，精确内容为 export function add(a,b){return a-b}\n，不运行命令、不修复这个刻意错误、不改其他文件。', checks: ['node --input-type=module -e "import {add} from \'./math.mjs\'; if(add(2,3)!==5) process.exit(3)"'] })
  session = r.session_id
  const done = await end(r.run_id)
  assert.equal(done.state, 'completed', JSON.stringify(done.pending || done.error)); assert.equal(done.evidence.all_checks_passed, false)
  assert.equal(done.evidence.checks[0].exit_code, 3); assert.ok(done.evidence.changes.created.some(c => c.path === 'math.mjs'))
  return { model: done.model, run_id: r.run_id, session_id: session, check_exit: 3 }
})
if (session) await run('同一真实会话修复并通过独立检查', async () => {
  const r = await send({ session_id: session, message: '现在修复上一轮刻意留下的错误：math.mjs 中 add(a,b) 应返回 a+b。只修改这个文件，不运行命令。', checks: ['node --input-type=module -e "import {add} from \'./math.mjs\'; if(add(2,3)!==5 || add(-2,3)!==1) process.exit(3)"'] })
  assert.equal(r.session_id, session)
  const done = await end(r.run_id)
  assert.equal(done.state, 'completed'); assert.equal(done.evidence.all_checks_passed, true)
  return { run_id: r.run_id, session_id: session, changes: done.evidence.changes }
})
await run('真实 AskUser 问题转交与自由文本回答', async () => {
  const cwd = path.join(root, 'question'); fs.mkdirSync(cwd)
  const r = await send({ cwd, autonomy: 'low', message: '请必须使用 AskUser 工具（不是文本提问），询问我“桥接测试选择哪种颜色？”，提供红色与蓝色两个选项。收到答案后，精确复述答案即可，不调用其他工具，不创建文件。如果工具的实际名称是 AskUserQuestion，就使用该名称。' })
  const q = await end(r.run_id)
  assert.equal(q.needs_input, true, JSON.stringify({ state: q.state, final: q.final_text, error: q.error })); assert.equal(q.pending.kind, 'ask_user')
  await call('answer', { run_id: r.run_id, request_id: q.pending.request_id, answers: q.pending.questions.map(q => ({ index: q.index, answer: '绿色（自由文本验证）' })), reason: '仅用于当前桥接联调，测试答案已在脚本中明确指定。' })
  const done = await end(r.run_id)
  assert.equal(done.state, 'completed'); assert.match(done.final_text, /绿色/)
  return { run_id: r.run_id, questions: q.pending.questions.length }
})
await run('真实执行中补充与排队续聊', async () => {
  const cwd = path.join(root, 'steer'); fs.mkdirSync(cwd)
  const r = await send({ cwd, autonomy: 'medium', message: '执行桥接运行中补充测试：先用终端运行 node -e "setTimeout(()=>{},12000)" 等待12秒，等待完成前不要写文件。之后只创建 result.txt，内容为 ORIGINAL。不要调用子代理、不要改其他文件。' })
  let st
  for (let i = 0; i < 100; i++) {
    st = await call('status', { run_id: r.run_id })
    if (st.recent_events?.some(e => e.type === 'tool_call' && /Execute|Bash|bash|execute/i.test(e.name))) break
    if (st.needs_input || ['completed', 'failed'].includes(st.state)) break
    await sleep(300)
  }
  assert.equal(st.state, 'running', JSON.stringify(st.pending || st.error))
  const steer = await call('send', { session_id: r.session_id, mode: 'steer', message: '运行中更新：result.txt 最终内容改为 STEERED，不要保留 ORIGINAL。' })
  assert.equal(steer.run_id, r.run_id)
  const follow = await send({ session_id: r.session_id, mode: 'followup', message: '请只读取 result.txt 并回复 FOLLOWUP: 后跟文件内容，不要修改文件，不运行命令。' })
  assert.equal(follow.state, 'queued')
  const done = await end(r.run_id); assert.equal(done.state, 'completed')
  assert.match(fs.readFileSync(path.join(cwd, 'result.txt'), 'utf8'), /STEERED/)
  const done2 = await end(follow.run_id); assert.equal(done2.state, 'completed'); assert.match(done2.final_text, /STEERED/)
  return { run_id: r.run_id, followup_run_id: follow.run_id, session_id: r.session_id }
})
await run('真实取消运行，不自动重试', async () => {
  const cwd = path.join(root, 'cancel'); fs.mkdirSync(cwd)
  const r = await send({ cwd, autonomy: 'medium', message: '这是取消测试。先执行 node -e "setTimeout(()=>{},60000)" 等待60秒，之后才创建 SHOULD_NOT_EXIST.txt。不要执行其他任务。' })
  for (let i = 0; i < 80; i++) {
    const st = await call('status', { run_id: r.run_id })
    if (st.recent_events?.some(e => e.type === 'tool_call')) break
    await sleep(300)
  }
  const cancelled = await call('cancel', { run_id: r.run_id })
  assert.equal(cancelled.state, 'cancelled'); await sleep(300)
  assert.equal(fs.existsSync(path.join(cwd, 'SHOULD_NOT_EXIST.txt')), false)
  return { run_id: r.run_id }
})
fs.mkdirSync(path.join(ROOT, 'docs'), { recursive: true })
const file = path.join(ROOT, 'docs/live-verification.local.json')
fs.writeFileSync(file, JSON.stringify(report, null, 2))
console.log(`Report: ${file}`)
