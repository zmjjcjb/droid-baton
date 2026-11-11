import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Broker } from '../src/broker.mjs'

const fixture = fileURLToPath(new URL('./fixtures/fake-droid.mjs', import.meta.url))
fs.chmodSync(fixture, 0o755)
process.env.DROID_BIN = fixture
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function context(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-baton-test-'))
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd)
  process.env.DROID_FAKE_SESSIONS = path.join(root, 'native-sessions')
  const broker = new Broker({ home: path.join(root, 'home') })
  t.after(async () => { await broker.close(); await sleep(30); fs.rmSync(root, { recursive: true, force: true }) })
  return { broker, cwd, root }
}
async function waitState(b, id, state) {
  for (let i = 0; i < 200; i++) { if (b.getRun(id).state === state) return; await sleep(10) }
  assert.equal(b.getRun(id).state, state)
}
test('real RPC adapter: create, stream, independent file evidence, failing check and continuation', async t => {
  const { broker: b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:WRITE', checks: ['node -e "process.exit(0)"', 'node -e "process.exit(3)"'] })
  const done = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.equal(done.state, 'completed'); assert.equal(done.model, 'fake-default')
  assert.equal(done.final_text, 'FAKE_DONE'); assert.equal(done.evidence.all_checks_passed, false)
  assert.equal(done.evidence.checks[1].exit_code, 3)
  assert.deepEqual(done.evidence.changes.created.map(x => x.path), ['result.txt'])
  const r2 = await b.send({ session_id: r.session_id, message: 'MOCK:OK' })
  assert.equal(r2.session_id, r.session_id)
  assert.equal((await b.wait({ run_id: r2.run_id, timeout_s: 5 })).state, 'completed')
  assert.equal((await b.call('read_session', { session_id: r.session_id })).messages.filter(m => m.role === 'user').length, 2)
})
test('question relay accepts free text, rejects stale request and double answer', async t => {
  const { broker: b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:QUESTION' })
  const question = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.equal(question.needs_input, true); assert.equal(question.pending.questions[0].index, 1)
  await assert.rejects(b.answer({ run_id: r.run_id, request_id: 'stale', answers: [] }), /过期/)
  await b.answer({ run_id: r.run_id, request_id: question.pending.request_id, answers: [{ index: 1, answer: '绿色，允许自由文本。' }] })
  await assert.rejects(b.answer({ run_id: r.run_id, request_id: question.pending.request_id, answers: [] }), /没有/)
  const done = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.match(done.final_text, /绿色/); assert.equal(done.state, 'completed')
})
test('permission relay requires offered outcome and explicit authorization reason', async t => {
  const { broker: b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:PERMISSION' })
  const { pending: p } = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  await assert.rejects(b.answer({ run_id: r.run_id, request_id: p.request_id, selected_option: 'proceed_once' }), /reason/)
  await assert.rejects(b.answer({ run_id: r.run_id, request_id: p.request_id, selected_option: 'proceed_always', reason: 'test' }), /选项/)
  await b.answer({ run_id: r.run_id, request_id: p.request_id, selected_option: 'cancel' })
  assert.equal((await b.wait({ run_id: r.run_id, timeout_s: 5 })).state, 'failed')
})
test('followup queue can be edited and removed; starts only after previous verification', async t => {
  const { broker: b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:SLOW' })
  const q = await b.send({ session_id: r.session_id, message: 'will edit' })
  assert.equal(q.state, 'queued')
  await b.call('update_queued', { run_id: q.run_id, action: 'edit', message: 'MOCK:WRITE' })
  const removed = await b.send({ session_id: r.session_id, message: 'remove me' })
  await b.call('update_queued', { run_id: removed.run_id, action: 'remove' })
  assert.equal(b.getRun(removed.run_id).state, 'cancelled')
  await b.wait({ run_id: r.run_id, timeout_s: 5 })
  const done = await b.wait({ run_id: q.run_id, timeout_s: 5 })
  assert.equal(done.state, 'completed'); assert.ok(fs.existsSync(path.join(cwd, 'result.txt')))
})
test('steer arrives at end_of_loop and shares the existing run receipt', async t => {
  const { broker: b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:WAIT' })
  await waitState(b, r.run_id, 'running')
  const steered = await b.send({ session_id: r.session_id, mode: 'steer', message: '新要求' })
  assert.equal(steered.run_id, r.run_id)
  const done = await b.wait({ run_id: r.run_id, timeout_s: 5 })
  assert.match(done.final_text, /新要求/); assert.equal(done.steers.length, 1)
})
test('parallel directories: wait-any returns earliest; overlapping cwd is refused', async t => {
  const { broker: b, cwd, root } = await context(t)
  const other = path.join(root, 'other'); fs.mkdirSync(other)
  const r = await b.send({ cwd, message: 'MOCK:WAIT' })
  await assert.rejects(b.send({ cwd, message: 'MOCK:OK' }), /重叠/)
  const fast = await b.send({ cwd: other, message: 'MOCK:OK' })
  const done = await b.wait({ run_ids: [r.run_id, fast.run_id], timeout_s: 5 })
  assert.equal(done.ended[0].run_id, fast.run_id); assert.equal(done.still_running[0].run_id, r.run_id)
  await b.cancel({ run_id: r.run_id })
})
test('cancel kills complete owned process group including shell descendants', async t => {
  const { broker: b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:TREE' })
  const file = path.join(cwd, 'descendant.pid')
  for (let i = 0; !fs.existsSync(file) && i < 200; i++) await sleep(10)
  const pid = Number(fs.readFileSync(file, 'utf8'))
  process.kill(pid, 0)
  await b.cancel({ run_id: r.run_id })
  await sleep(100)
  let running = false
  try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); running = !stat.split(' ')[2].includes('Z') } catch {}
  assert.equal(running, false)
  assert.equal(b.getRun(r.run_id).state, 'cancelled')
})
test('cancelling independent checks is responsive and cancels descendants', async t => {
  const { broker: b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:OK', checks: ['node -e "setInterval(()=>{},1000)"'] })
  await waitState(b, r.run_id, 'checking')
  const start = Date.now(); await b.cancel({ run_id: r.run_id })
  assert.ok(Date.now() - start < 2500); assert.equal(b.getRun(r.run_id).state, 'cancelled')
})
test('failure cancels queued changes; broker restart never replays a running task', async t => {
  const { broker: b, cwd, root } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:FAIL' })
  const q = await b.send({ session_id: r.session_id, message: 'MOCK:WRITE' })
  assert.equal((await b.wait({ run_id: r.run_id, timeout_s: 5 })).state, 'failed')
  assert.equal(b.getRun(q.run_id).state, 'cancelled'); assert.equal(fs.existsSync(path.join(cwd, 'result.txt')), false)
  const waiting = await b.send({ session_id: r.session_id, message: 'MOCK:WAIT' })
  await waitState(b, waiting.run_id, 'running')
  await b.close()
  const next = new Broker({ home: path.join(root, 'home') })
  assert.equal(next.getRun(waiting.run_id).state, 'interrupted')
  assert.equal(next.state.sessions[r.session_id].active_run, null)
  await next.close()
})
test('cancelled wait does not cancel worker; runtime timeout does', async t => {
  const { broker: b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:WAIT', timeout_s: 1 })
  const ctl = new AbortController(); const waiting = b.wait({ run_id: r.run_id, timeout_s: 5 }, ctl.signal)
  ctl.abort(); assert.equal((await waiting).timed_out, true)
  assert.ok(['starting', 'running'].includes(b.getRun(r.run_id).state))
  await waitState(b, r.run_id, 'failed'); assert.match(b.getRun(r.run_id).error, /timeout_s/)
})
