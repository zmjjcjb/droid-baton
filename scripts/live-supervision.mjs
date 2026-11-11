// Opt-in: real Droid turns in isolated scratch directories, existing model route.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { call } from '../src/client.mjs'
import { ROOT } from '../src/config.mjs'
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-supervision-real-'))
const report = { date: new Date().toISOString(), tests: [], root }
const activeRuns = new Set()
async function supervise(r, verify) {
  activeRuns.add(r.run_id)
  const notices = []
  for (let i = 0; i < 30; i++) {
    const st = await call('wait', { run_id: r.run_id, timeout_s: 50 })
    if (st.timed_out) continue
    if (st.needs_input) throw new Error('未预期的输入请求：' + JSON.stringify(st.pending))
    if (st.needs_attention) {
      notices.push(st.attention.kind)
      if (['checkpoint', 'stalled'].includes(st.attention.kind)) {
        await call('supervise', { run_id: r.run_id, action: 'watch', attention_id: st.attention.id }); continue
      }
      if (st.attention.kind === 'ready_for_review') {
        verify(st)
        const accepted = await call('supervise', { run_id: r.run_id, action: 'accept', attention_id: st.attention.id, reason: '联调主控已检查原目标文件内容、同一会话/运行 ID 及真实独立检查。' })
        assert.equal(accepted.state, 'completed'); activeRuns.delete(r.run_id)
        return { ...accepted, notices }
      }
      throw new Error('需要人工/主控处理：' + JSON.stringify(st.attention))
    }
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(st.state)) throw new Error('未完成主控审查就结束：' + st.state + ':' + st.error)
  }
  throw new Error('监督循环超过联调轮次')
}
async function test(name, fn) {
  try { const data = await fn(); report.tests.push({ name, passed: true, ...data }); console.log('PASS', name, JSON.stringify(data)) }
  catch (e) { report.tests.push({ name, passed: false, error: e.message }); console.error('FAIL', name, e.message); process.exitCode = 1 }
}
await test('真实两轮目标推进、独立检查和主控接收', async () => {
  const cwd = path.join(root, 'stages'); fs.mkdirSync(cwd)
  const r = await call('send', { cwd, autonomy: 'low', timeout_s: 240, supervision: { interval_s: 10, stall_s: 60, max_rounds: 5 }, message: '这是多轮目标联调。最终目标是本目录同时有 a.txt（精确内容 PHASE1）和 b.txt（精确内容 DONE）。必须分两轮：当前第一轮只创建 a.txt，不能创建 b.txt；在最后的 droid-baton JSON 块中使用 status=continue，remaining=["创建 b.txt，内容 DONE"]。收到监督器续做消息后才创建 b.txt，并在所有目标满足时输出 complete。不要运行命令、不要调用子代理、不要改其他文件。', checks: ['node -e "const f=require(\'fs\');if(f.readFileSync(\'a.txt\',\'utf8\').trim()!==\'PHASE1\'||f.readFileSync(\'b.txt\',\'utf8\').trim()!==\'DONE\')process.exit(3)"'] })
  const st = await supervise(r, st => { assert.ok(st.supervisor.round >= 2); assert.equal(st.evidence.all_checks_passed, true); assert.equal(st.run_id, r.run_id); assert.equal(st.session_id, r.session_id) })
  return { run_id: st.run_id, model: st.model, rounds: st.supervisor.round, checks: st.evidence.all_checks_passed, notices: st.notices }
})
await test('真实验收失败自动修复，维持同一目标', async () => {
  const cwd = path.join(root, 'repair'); fs.mkdirSync(cwd)
  const r = await call('send', { cwd, autonomy: 'low', timeout_s: 240, supervision: { interval_s: 10, stall_s: 60, max_rounds: 5, max_repairs: 2 }, message: '这是监督器的故障注入测试，真正目标是通过桥接程序的外部检查。当前第一轮请只创建 result.txt，精确内容 BAD，然后在 droid-baton JSON 代码块里报告 status=complete、summary="故障注入阶段已就绪"、remaining=[]，以便外部监督器触发检查失败分支。不要自己运行检查，也不要提前修正 BAD。之后收到外部验收失败输出时，才把 result.txt 修复为精确内容 GOOD，并再次报告 complete。不要运行命令、不要调用子代理、不要改其他文件。', checks: ['node -e "if(require(\'fs\').readFileSync(\'result.txt\',\'utf8\').trim()!==\'GOOD\')process.exit(3)"'] })
  const st = await supervise(r, st => { assert.ok(st.supervisor.repairs >= 1); assert.equal(st.evidence.all_checks_passed, true); assert.equal(fs.readFileSync(path.join(cwd, 'result.txt'), 'utf8').trim(), 'GOOD') })
  return { run_id: st.run_id, rounds: st.supervisor.round, repairs: st.supervisor.repairs, notices: st.notices }
})
for (const id of activeRuns) await call('cancel', { run_id: id }).catch(() => {})
fs.writeFileSync(path.join(ROOT, 'docs/supervision-live.local.json'), JSON.stringify(report, null, 2))
