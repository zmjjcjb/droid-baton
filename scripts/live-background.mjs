import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import assert from 'node:assert/strict'
import { call } from '../src/client.mjs'
import { ROOT } from '../src/config.mjs'
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-background-real-'))
let run
try {
  run = await call('send', { cwd, autonomy: 'medium', supervision: { max_rounds: 5, interval_s: 10, stall_s: 90 }, timeout_s: 180, message: '这是桥接后台工作门控的受控故障注入测试。只调用一次 Execute，command 为 node -e "setTimeout(()=>{require(\'fs\').writeFileSync(\'background.txt\',\'DONE\')},12000)"，fireAndForget=true，riskLevel=medium，summary="Run finite background verification"。返回后不要等待、不要再调用其他工具，立刻用 droid-baton JSON 报告 complete，summary="后台命令已启动，交给外部监督器跟踪退出"，remaining=[]。这是为了验证外部监督器不会把你的本轮结束误当作全部工作结束。若之后自动收到后台完成通知，只需再次按协议报告 complete；禁止启动新命令、禁止调用子代理。最终背景文件应该为 DONE。', checks: ['node -e "if(require(\'fs\').readFileSync(\'background.txt\',\'utf8\')!==\'DONE\')process.exit(3)"'] })
  let revision = -1, sawBackground = false, identityObserved = false, final
  const notices = [], deadline = Date.now() + 190000
  while (Date.now() < deadline) {
    const r = await call('observe', { run_id: run.run_id, after_revision: revision, timeout_s: 50 }); revision = r.revision || 0
    sawBackground ||= r.state === 'background'
    identityObserved ||= Object.values(r.work?.jobs || {}).some(j => j.identity)
    if (r.needs_input) throw new Error('未预期输入：' + JSON.stringify(r.pending))
    if (r.needs_attention) {
      notices.push(r.attention.kind)
      if (['checkpoint', 'stalled'].includes(r.attention.kind)) await call('supervise', { run_id: r.run_id, action: 'watch', attention_id: r.attention.id })
      else if (r.attention.kind === 'missing_checkpoint') await call('supervise', { run_id: r.run_id, action: 'continue', attention_id: r.attention.id, message: '已收到后台结束事件。不要调用任何工具，只用 droid-baton JSON 报告当前完整目标状态。', reason: '原生后台通知后补全同一目标的结束报告。' })
      else if (r.attention.kind === 'ready_for_review') { final = r; break }
      else throw new Error(JSON.stringify(r.attention))
    }
    if (['failed', 'cancelled', 'interrupted', 'completed'].includes(r.state)) throw new Error('目标提前结束：' + r.state + ':' + r.error)
  }
  assert.ok(final, '未进入主控接收阶段'); assert.ok(sawBackground, '未观察到等待后台阶段'); assert.ok(identityObserved, '未通过本机进程身份验证')
  assert.equal(final.evidence.all_checks_passed, true); assert.equal(final.outstanding_work.active, false)
  const done = await call('supervise', { run_id: run.run_id, action: 'accept', attention_id: final.attention.id, reason: '已观察原生后台 PID 身份及退出；独立检查文件内容为 DONE。' })
  assert.equal(done.state, 'completed')
  const report = { passed: true, run_id: run.run_id, cwd, saw_background: sawBackground, process_identity_observed: identityObserved, checks: done.evidence.all_checks_passed, notices, native_turns: done.native_turns || [] }
  fs.writeFileSync(path.join(ROOT, 'docs/background-live.local.json'), JSON.stringify(report, null, 2)); console.log('PASS real native background process', JSON.stringify(report))
} catch (error) { if (run) await call('cancel', { run_id: run.run_id }).catch(() => {}); console.error(error.message); process.exitCode = 1 }
