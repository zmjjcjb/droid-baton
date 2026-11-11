import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Broker } from '../src/broker.mjs'
import { projectRun, projectEvents, projectWork, projectPending, projectEvidence } from '../src/views.mjs'
import { observeWork } from '../src/supervision.mjs'

const fixture = fileURLToPath(new URL('./fixtures/fake-droid.mjs', import.meta.url))
fs.chmodSync(fixture, 0o755); process.env.DROID_BIN = fixture
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function context(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-views-')), cwd = path.join(root, 'project')
  fs.mkdirSync(cwd); process.env.DROID_FAKE_SESSIONS = path.join(root, 'sessions')
  const b = new Broker({ home: path.join(root, 'home') })
  t.after(async () => { await b.close(); await sleep(30); fs.rmSync(root, { recursive: true, force: true }) })
  return { b, cwd, root }
}

test('the compact view is far smaller than the raw run and keeps the actionable fields', () => {
  const run = {
    run_id: 'drun-1', session_id: 's1', state: 'running', cwd: '/tmp/x', model: 'fake',
    message: 'M'.repeat(5000),
    recent_events: Array.from({ length: 30 }, (_, i) => ({ seq: i + 1, time: 'T', type: 'tool_call', name: 'Execute', input: 'x'.repeat(2000) })),
    work: { tools: Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`t${i}`, { id: `t${i}`, name: 'Execute', input: { command: 'y'.repeat(1000) }, started_at: 'T' }])), jobs: {}, workers: {} },
  }
  const raw = JSON.stringify(run).length
  const view = projectRun(run)
  const size = JSON.stringify(view).length
  assert.ok(size < raw / 5, `compact view should be a small fraction of the raw run: ${size} vs ${raw}`)
  assert.equal(view.run_id, 'drun-1')
  assert.equal(view.state, 'running')
  assert.equal(view.events.length, 12)
  assert.equal(view.outstanding_work.counts.tools, 100)
  assert.equal(view.outstanding_work.recent_tools.length, 8)
  assert.equal(view.outstanding_work.tools_not_shown, 92)
  // The delegated message is only a preview; the supervisor already sent it.
  assert.ok(view.message_preview.length < 900)
  assert.equal(view.message, undefined)
})

test('events are returned incrementally by seq', () => {
  const events = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, time: 'T', type: 'tool_call', name: 'Read' }))
  const all = projectEvents(events, { since_seq: -1 })
  assert.equal(all.events.length, 10)
  assert.equal(all.last_seq, 10)
  const delta = projectEvents(events, { since_seq: 7 })
  assert.equal(delta.events.length, 3)
  assert.deepEqual(delta.events.map(e => e.seq), [8, 9, 10])
  const none = projectEvents(events, { since_seq: 10 })
  assert.equal(none.events.length, 0)
  assert.equal(none.last_seq, 10)
})

test('work projection reports only unfinished jobs as running', () => {
  const work = {
    tools: { a: { name: 'Execute', input: { command: 'ls' } } },
    jobs: { j1: { id: 'j1', source: 'Execute', status: 'running', pid: 42 }, j2: { id: 'j2', source: 'Task', status: 'completed' } },
    workers: { w1: { id: 'w1', source: 'Task', status: 'running' } },
  }
  const view = projectWork(work)
  assert.equal(view.active, true)
  assert.equal(view.running_jobs.length, 1)
  assert.equal(view.running_jobs[0].pid, 42)
  assert.equal(view.running_workers.length, 1)
  assert.equal(view.counts.jobs, 2)
})

test('a pending question keeps what an answer needs and drops the rest', () => {
  const pending = { request_id: 'req-1', kind: 'ask', questions: [{ index: 1, question: 'Q'.repeat(5000) }], secret: 'x' }
  const view = projectPending(pending)
  assert.equal(view.request_id, 'req-1')
  assert.equal(view.questions[0].index, 1)
  assert.ok(view.questions[0].question.length < 700)
  assert.equal(view.secret, undefined)
})

test('evidence keeps pass/fail verdicts and the changed-file list', () => {
  const evidence = { all_checks_passed: false, checks: [{ name: 'npm test', exit_code: 3, ok: false, output_tail: 'z'.repeat(5000) }], changes: { created: [{ path: 'a.txt' }] } }
  const view = projectEvidence(evidence)
  assert.equal(view.all_checks_passed, false)
  assert.equal(view.checks[0].exit_code, 3)
  assert.deepEqual(view.changes.created, [{ path: 'a.txt' }])
  assert.ok(view.checks[0].output_tail.length < 700)
})

test('the broker serves a compact status by default over MCP and keeps the full shape on request', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:WAIT' })
  for (let i = 0; i < 100 && b.getRun(r.run_id).state !== 'running'; i++) await sleep(10)
  const summary = b.status({ run_id: r.run_id, detail: 'summary' })
  const full = b.status({ run_id: r.run_id, detail: 'full' })
  assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length)
  assert.equal(summary.state, full.state)
  assert.equal(summary.run_id, full.run_id)
  // The full shape keeps the raw fields the dashboard and CLI read.
  assert.ok(Array.isArray(full.recent_events))
  assert.ok(full.outstanding_work)
  assert.equal(typeof full.outstanding_work.active, 'boolean')
  // The compact view keeps the same observable state, without the raw transcript.
  assert.equal(summary.outstanding_work.active, full.outstanding_work.active)
})

test('a poll with since_seq returns only the events newer than the cursor', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:WAIT' })
  for (let i = 0; i < 100 && b.getRun(r.run_id).state !== 'running'; i++) await sleep(10)
  const first = b.status({ run_id: r.run_id, detail: 'summary' })
  assert.ok(first.last_seq > 0)
  const second = b.status({ run_id: r.run_id, detail: 'summary', since_seq: first.last_seq })
  assert.equal(second.events.length, 0)
  assert.equal(second.last_seq, first.last_seq)
})

test('a repeated identical tool call is counted as a stuck worker', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:WAIT' })
  for (let i = 0; i < 100 && b.getRun(r.run_id).state !== 'running'; i++) await sleep(10)
  const run = b.getRun(r.run_id)
  const call = input => observeWork(run, { type: 'tool_call', toolUse: { id: `t${Math.random()}`, name: 'Execute', input } })
  call({ command: 'ls' }); call({ command: 'ls' })
  assert.equal(run.activity.repeated, 2)
  call({ command: 'ls' })
  assert.equal(run.activity.repeated, 3)
  // A different argument breaks the run.
  call({ command: 'pwd' })
  assert.equal(run.activity.repeated, 1)
  // Argument order must not matter for the comparison.
  call({ a: 1, b: 2 }); call({ b: 2, a: 1 })
  assert.equal(run.activity.repeated, 2)
})

test('the compact view reports the repeat count so a supervisor can diagnose a stall', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:WAIT' })
  for (let i = 0; i < 100 && b.getRun(r.run_id).state !== 'running'; i++) await sleep(10)
  const run = b.getRun(r.run_id)
  for (let i = 0; i < 3; i++) observeWork(run, { type: 'tool_call', toolUse: { id: `x${i}`, name: 'Execute', input: { command: 'ls' } } })
  const view = b.status({ run_id: r.run_id, detail: 'summary' })
  assert.equal(view.activity.repeated, 3)
})

test('a stalled run names the suspected cause in the supervisor notice', async t => {
  const { b, cwd } = await context(t)
  const r = await b.send({ cwd, message: 'MOCK:WAIT', supervision: { interval_s: 10, stall_s: 10 } })
  for (let i = 0; i < 100 && b.getRun(r.run_id).state !== 'running'; i++) await sleep(10)
  const run = b.getRun(r.run_id)
  for (let i = 0; i < 3; i++) observeWork(run, { type: 'tool_call', toolUse: { id: `y${i}`, name: 'Execute', input: { command: 'ls' } } })
  const now = Date.now(); run.activity.last_progress_ms = now - 60000; run.supervisor.last_notice_ms = now - 30000
  await b.supervisor.tick(now)
  const notice = await b.wait({ run_id: r.run_id, timeout_s: 1 })
  assert.equal(notice.attention.kind, 'stalled')
  assert.match(notice.attention.message, /连续重复 3 次/)
  assert.match(notice.attention.message, /最后工具：Execute/)
})
