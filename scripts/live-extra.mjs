import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { call, connectCall } from '../src/client.mjs'
import { ROOT } from '../src/config.mjs'
const file = path.join(ROOT, 'docs/live-verification.local.json')
const report = JSON.parse(fs.readFileSync(file, 'utf8'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
let activeRun
try {
  const old = await call('ping')
  const runs = await call('list_runs'); assert.ok(runs.every(r => ['completed', 'failed', 'cancelled', 'interrupted'].includes(r.state)))
  process.kill(old.pid, 'SIGTERM')
  for (let i = 0; i < 100; i++) { if (!(await connectCall('ping', {}, { timeout: 100 }).catch(() => null))) break; await sleep(50) }
  const next = await call('ping'); assert.notEqual(next.pid, old.pid)
  const session = report.tests.find(x => x.session_id)?.session_id
  const r = await call('send', { session_id: session, message: '不要调用工具。仅根据会话历史回答：我们上一轮修复 math.mjs 时，add 最终应该返回 a+b 还是 a-b？只输出正确表达式。', timeout_s: 120 })
  activeRun = r.run_id
  const done = await call('wait', { run_id: r.run_id, timeout_s: 50 })
  assert.equal(done.state, 'completed'); assert.match(done.final_text, /a\s*\+\s*b/)
  report.tests.push({ name: '任务服务重启后从原生会话恢复真实上下文', passed: true, run_id: r.run_id, session_id: session })
  console.log('PASS native context after broker restart')
  const cwd = path.join(report.root, 'permission'); fs.mkdirSync(cwd, { recursive: true })
  const p = await call('send', { cwd, autonomy: 'off', message: '桥接权限测试：只创建 permission.txt，内容为 PERMISSION_ONCE。必须使用文件创建工具。不要执行终端命令、不要修改其他文件；若需要批准，请通过正常权限请求等待。', timeout_s: 120 })
  activeRun = p.run_id
  const q = await call('wait', { run_id: p.run_id, timeout_s: 50 })
  assert.equal(q.needs_input, true, q.final_text || q.error); assert.equal(q.pending.kind, 'request_permission')
  assert.ok(q.pending.options.some(o => o.value === 'proceed_once'))
  await call('answer', { run_id: p.run_id, request_id: q.pending.request_id, selected_option: 'proceed_once', reason: '用户要求完成桥接联调；仅批准脚本明确指定的临时测试目录内 permission.txt 创建。' })
  const done2 = await call('wait', { run_id: p.run_id, timeout_s: 50 })
  assert.equal(done2.state, 'completed', JSON.stringify(done2.pending || done2.error)); assert.match(fs.readFileSync(path.join(cwd, 'permission.txt'), 'utf8'), /PERMISSION_ONCE/)
  report.tests.push({ name: '真实权限请求转交并仅批准一次文件创建', passed: true, run_id: p.run_id })
  console.log('PASS native permission request and single approval')
} catch (error) {
  report.tests.push({ name: '额外真实恢复/权限联调', passed: false, error: error.message })
  if (activeRun) await call('cancel', { run_id: activeRun }).catch(() => {})
  console.error(error.message); process.exitCode = 1
} finally { fs.writeFileSync(file, JSON.stringify(report, null, 2)) }
