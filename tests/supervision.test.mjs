import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Broker } from '../src/broker.mjs'
import { checkpoint, supervisionOptions, observeWork, liveWork } from '../src/supervision.mjs'
import { ownedProcess, processAlive, stopProcess } from '../src/processes.mjs'
import { spawn } from 'node:child_process'
import * as evidence from '../src/evidence.mjs'
import { savedOutcome } from '../src/discovery.mjs'

const fixture = fileURLToPath(new URL('./fixtures/fake-droid.mjs', import.meta.url))
fs.chmodSync(fixture, 0o755); process.env.DROID_BIN = fixture
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function context(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-supervise-')), cwd = path.join(root, 'project')
  fs.mkdirSync(cwd); process.env.DROID_FAKE_SESSIONS = path.join(root, 'sessions')
  const b = new Broker({ home: path.join(root, 'home') })
  t.after(async () => { await b.close(); await sleep(30); fs.rmSync(root, { recursive: true, force: true }) })
  return { b, cwd, root }
}
const check = file => `node -e "if(require('fs').readFileSync('${file}','utf8')!=='GOOD')process.exit(3)"`
async function state(b, id, target) {
  for (let i = 0; i < 300; i++) { const r = b.getRun(id); if (r.state === target) return r; await sleep(10) }
  assert.equal(b.getRun(id).state, target)
}

test('supervision configuration is bounded and checkpoints reject contradictory completion', () => {
  assert.equal(supervisionOptions(false), null); assert.equal(supervisionOptions(true).max_rounds, 12)
  assert.throws(() => supervisionOptions({ max_rounds: 100 }), /max_rounds/)
  assert.throws(() => supervisionOptions({ arbitrary: true }), /未知/)
  assert.equal(checkpoint('```droid-baton\n{"status":"complete","summary":"x","remaining":["not done"]}\n```'), null)
  assert.equal(checkpoint('模型口头说完成'), null)
})
test('multi-turn goal retains run/session and initial evidence until independent checks + main review', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_STAGES', supervision: true, checks: ['node -e "if(!require(\'fs\').existsSync(\'b.txt\'))process.exit(1)"'] })
  const review = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.equal(review.state, 'review'); assert.equal(review.attention.kind, 'ready_for_review'); assert.equal(review.supervisor.round, 2)
  assert.equal(review.session_id, r.session_id); assert.equal(review.run_id, r.run_id)
  assert.deepEqual(review.evidence.changes.created.map(c => c.path), ['a.txt', 'b.txt'])
  const done = await b.call('supervise', { run_id: r.run_id, attention_id: review.attention.id, action: 'accept', reason: '需求覆盖已审查，独立检查通过。' })
  assert.equal(done.state, 'completed'); assert.equal(done.acceptance.without_checks, false)
})
test('failed independent checks trigger bounded repair and fresh recheck, not cached success', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_REPAIR', supervision: true, checks: [check('result.txt')] })
  const review = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.equal(review.attention.kind, 'ready_for_review'); assert.equal(review.supervisor.repairs, 1); assert.equal(review.supervisor.round, 2)
  assert.equal(review.evidence.all_checks_passed, true); assert.equal(review.supervisor.checks_serial, 2)
  assert.equal(fs.readFileSync(path.join(cwd, 'result.txt'), 'utf8'), 'GOOD')
  fs.writeFileSync(path.join(cwd, 'result.txt'), 'BAD_AFTER_REVIEW')
  await assert.rejects(b.call('supervise', { run_id: r.run_id, action: 'accept', reason: '验证接收时漂移检测。' }), /未通过/)
  assert.equal(b.getRun(r.run_id).state, 'review'); assert.equal(b.getRun(r.run_id).evidence.all_checks_passed, false)
})
test('failed checks stop at repair budget and do not execute queued followups', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_CHECKFAIL', supervision: { max_repairs: 1 }, checks: [check('result.txt')] })
  const q = await b.send({ session_id: r.session_id, message: 'MOCK:WRITE' })
  const review = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.equal(review.attention.kind, 'checks_failed'); assert.equal(review.supervisor.round, 2); assert.equal(b.getRun(q.run_id).state, 'queued')
  await assert.rejects(b.call('supervise', { run_id: r.run_id, action: 'accept', reason: '不能接收错误。' }), /未通过/)
})
test('round and token budgets never mark incomplete goal successful', async t => {
  const { b, cwd, root } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_STUCK', supervision: { max_rounds: 2 } })
  const review = await b.wait({ run_id: r.run_id, timeout_s: 5 }); assert.equal(review.attention.kind, 'round_budget'); assert.equal(review.supervisor.round, 2)
  await assert.rejects(b.call('supervise', { run_id: r.run_id, action: 'continue', reason: '不能越过预算。' }), /预算/)
  const other = path.join(root, 'other'); fs.mkdirSync(other)
  const r2 = await b.send({ cwd: other, message: 'MOCK:GOAL_STUCK', supervision: { max_tokens: 1 } })
  assert.equal((await b.wait({ run_id: r2.run_id, timeout_s: 5 })).attention.kind, 'token_budget')
})
test('native background Task receipt and TaskOutput must settle before goal acceptance', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_BACKGROUND', supervision: true, checks: ['node -e "if(!require(\'fs\').existsSync(\'background.txt\'))process.exit(1)"'] })
  const review = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.equal(review.attention.kind, 'ready_for_review'); assert.equal(review.supervisor.round, 2)
  assert.equal(review.outstanding_work.active, false); assert.equal(review.work.jobs['task-1'].status, 'completed')
})
test('parent turn completion waits for Mission state and worker end before checking', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_MISSION', supervision: true, checks: ['node -e "if(!require(\'fs\').existsSync(\'mission.txt\'))process.exit(1)"'] })
  await state(b, r.run_id, 'background')
  assert.equal(b.getRun(r.run_id).evidence, undefined)
  const review = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.equal(review.attention.kind, 'ready_for_review'); assert.equal(review.evidence.all_checks_passed, true)
  assert.equal(review.work.mission.state, 'completed'); assert.equal(review.work.workers['worker-mission-1'].status, 'completed')
})
test('heartbeat is liveness only; stall notification wakes wait and acknowledgements do not storm', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_WAIT', supervision: { interval_s: 10, stall_s: 10 } })
  const goal = await state(b, r.run_id, 'running')
  const now = Date.now(); goal.activity.last_progress_ms = now - 60000; goal.supervisor.last_notice_ms = now - 30000
  observeWork(goal, { type: 'mission_heartbeat' }, now)
  assert.equal(goal.activity.last_progress_ms, now - 60000)
  await b.supervisor.tick(now)
  const notice = await b.wait({ run_id: r.run_id, timeout_s: 1 })
  assert.equal(notice.attention.kind, 'stalled'); assert.equal(notice.state, 'running')
  await assert.rejects(b.call('supervise', { run_id: r.run_id, action: 'watch', attention_id: 'stale' }), /过期/)
  await b.call('supervise', { run_id: r.run_id, action: 'watch', attention_id: notice.attention.id })
  await b.supervisor.tick(Date.now() + 1000); assert.equal(goal.attention, null)
})
test('missing report and unchecked completion require real main-agent decision', async t => {
  const { b, cwd, root } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_MISSING', supervision: true })
  assert.equal((await b.wait({ run_id: r.run_id, timeout_s: 5 })).attention.kind, 'missing_checkpoint')
  await assert.rejects(b.call('supervise', { run_id: r.run_id, action: 'accept', reason: '不能靠口头完成。', accept_without_checks: true }), /接收条件/)
  const other = path.join(root, 'other'); fs.mkdirSync(other)
  const r2 = await b.send({ cwd: other, message: 'MOCK:GOAL_COMPLETE', supervision: true })
  const review = await b.wait({ run_id: r2.run_id, timeout_s: 5 }); assert.equal(review.attention.kind, 'unverified_complete')
  await assert.rejects(b.call('supervise', { run_id: r2.run_id, action: 'accept', reason: '尚未审查。' }), /未配置/)
  assert.equal((await b.call('supervise', { run_id: r2.run_id, action: 'accept', reason: '已逐项审查产物。', accept_without_checks: true })).state, 'completed')
})
test('explicit pause/resume holds same run, while user cancel can never be resumed', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_WAIT', supervision: true })
  await state(b, r.run_id, 'running')
  await b.call('supervise', { run_id: r.run_id, action: 'pause' }); assert.equal(b.getRun(r.run_id).state, 'paused')
  await b.call('supervise', { run_id: r.run_id, action: 'resume', reason: '明确恢复暂停目标。', message: 'MOCK:GOAL_COMPLETE' })
  assert.equal((await b.wait({ run_id: r.run_id, timeout_s: 5 })).attention.kind, 'unverified_complete')
  await b.cancel({ run_id: r.run_id })
  await assert.rejects(b.call('supervise', { run_id: r.run_id, action: 'resume', reason: '不可恢复用户取消。' }), /已经结束/)
})
test('native Task await default and foreground Execute are distinguished without false completion', () => {
  const r = {}
  observeWork(r, { type: 'tool_call', toolUse: { id: 't', name: 'Task', input: {} } })
  assert.equal(liveWork(r).jobs.length, 1)
  observeWork(r, { type: 'tool_call', toolUse: { id: 't', name: 'Task', input: { await: true } } })
  assert.equal(liveWork(r).jobs.length, 0); assert.equal(r.activity.tool_calls, 1)
  observeWork(r, { type: 'tool_call', toolUse: { id: 'e', name: 'Execute', input: { command: 'echo ok' } } })
  observeWork(r, { type: 'tool_progress_update', toolUseId: 'e', toolName: 'Execute', update: { terminalId: 'term-1', type: 'status', status: 'running' } })
  assert.equal(liveWork(r).active, true)
  observeWork(r, { type: 'tool_result', toolUseId: 'e', content: 'Process exited with code 0' })
  assert.equal(liveWork(r).active, false)
})
test('detached fireAndForget process is independently tracked until exit', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_PID', supervision: true, checks: ['node -e "if(!require(\'fs\').existsSync(\'pid-result.txt\'))process.exit(1)"'] })
  await state(b, r.run_id, 'background')
  assert.ok(Object.values(b.getRun(r.run_id).work.jobs).some(j => j.identity))
  const review = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.equal(review.attention.kind, 'ready_for_review'); assert.equal(review.outstanding_work.active, false)
  assert.equal(review.evidence.all_checks_passed, true)
})
test('cancellation kills detached native processes and reused identities are never signalled', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_PIDHANG', supervision: true })
  await state(b, r.run_id, 'background')
  const job = Object.values(b.getRun(r.run_id).work.jobs).find(j => j.identity)
  assert.ok(processAlive(job.identity))
  assert.equal(stopProcess({ ...job.identity, start_ticks: 'wrong identity' }), false)
  assert.ok(processAlive(job.identity))
  await b.cancel({ run_id: r.run_id }); await sleep(50); assert.equal(processAlive(job.identity), false)
})
test('active long-goal baseline survives retention cleanup and explicit crash recovery preserves deadline', async t => {
  const { b, cwd, root } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_WAIT', supervision: true })
  await state(b, r.run_id, 'running')
  const before = path.join(b.home, 'evidence', `${r.run_id}.before.json`)
  const deadline = b.getRun(r.run_id).deadline
  for (let i = 0; i < 55; i++) evidence.prepare(b.home, { run_id: `old-${i}`, session_id: 'other', cwd })
  assert.ok(fs.existsSync(before), 'active baseline may not be evicted by completed-run retention')
  await b.close()
  const recovered = new Broker({ home: path.join(root, 'home') })
  try {
    assert.equal(recovered.getRun(r.run_id).state, 'interrupted')
    await recovered.call('supervise', { run_id: r.run_id, action: 'resume', reason: '显式恢复已中断的同一目标，不延长时限。', message: 'MOCK:GOAL_COMPLETE' })
    const review = await recovered.wait({ run_id: r.run_id, timeout_s: 5 })
    assert.equal(review.attention.kind, 'unverified_complete'); assert.equal(review.session_id, r.session_id)
    assert.equal(review.deadline, deadline); assert.equal(review.supervisor.round, 2)
  } finally { await recovered.close() }
})
test('native child outcome reader ignores an older completion when a later turn has started', async t => {
  const { root } = await context(t), dir = path.join(root, 'native-logs')
  const previous = process.env.DROID_SESSIONS_DIR; process.env.DROID_SESSIONS_DIR = dir
  fs.mkdirSync(dir)
  try {
    const file = path.join(dir, 'child-native-1.jsonl')
    fs.writeFileSync(file, [JSON.stringify({ type: 'session_start', id: 'child-native-1' }), JSON.stringify({ type: 'message', message: { role: 'user', content: 'first' } }), JSON.stringify({ type: 'agent_turn_outcome', turnId: 'old', reason: 'completed' })].join('\n') + '\n')
    assert.equal(savedOutcome('child-native-1').reason, 'completed')
    fs.appendFileSync(file, JSON.stringify({ type: 'message', message: { role: 'user', content: 'new task' } }) + '\n')
    assert.equal(savedOutcome('child-native-1').reason, null)
    fs.appendFileSync(file, JSON.stringify({ type: 'agent_turn_outcome', turnId: 'new', reason: 'completed' }) + '\n')
    assert.equal(savedOutcome('child-native-1').turn_id, 'new')
    assert.equal(savedOutcome('child-native-1').reason, 'completed')
  } finally { if (previous === undefined) delete process.env.DROID_SESSIONS_DIR; else process.env.DROID_SESSIONS_DIR = previous }
})
test('native background completion cannot bypass the overall round budget', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_NATIVEBUDGET', supervision: { max_rounds: 1 } })
  const paused = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.equal(paused.state, 'paused'); assert.equal(paused.attention.kind, 'round_budget'); assert.equal(paused.supervisor.round, 1)
  const job = Object.values(paused.work.jobs).find(j => j.identity)
  await sleep(30); assert.equal(processAlive(job.identity), false)
})
test('supervision interval spans continuation rounds instead of being postponed by every turn', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:GOAL_WAIT', supervision: { interval_s: 10, stall_s: 60 } })
  const goal = await state(b, r.run_id, 'running')
  goal.supervisor.last_notice_ms = Date.now() - 11000
  const previous = goal.supervisor.last_notice_ms
  b.supervisor.beginTurn(goal, 'continuation')
  assert.equal(goal.supervisor.last_notice_ms, previous)
  await b.supervisor.tick()
  assert.equal(goal.attention.kind, 'checkpoint')
})
