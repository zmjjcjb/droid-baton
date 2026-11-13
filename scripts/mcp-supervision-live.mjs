// Opt-in installed MCP → real Droid → supervisor review → acceptance.
import { execFileSync, spawn } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const t = JSON.parse(execFileSync('codex', ['mcp', 'get', 'droid-baton', '--json'], { encoding: 'utf8' })).transport
const proc = spawn(t.command, t.args, { cwd: t.cwd, env: { ...process.env, ...t.env }, stdio: ['pipe', 'pipe', 'pipe'] })
const pending = new Map(); let id = 0, run
proc.stderr.on('data', b => process.stderr.write(b))
readline.createInterface({ input: proc.stdout }).on('line', line => { const m = JSON.parse(line), p = pending.get(m.id); if (p) { pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result) } })
const rpc = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id, timer = setTimeout(() => reject(new Error('MCP deadline')), 60000); pending.set(n, { resolve, reject, timer }); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n') })
async function tool(name, args = {}) { const r = await rpc('tools/call', { name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text) }
try {
  await rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'codex-supervision-live', version: '1' } })
  const list = await rpc('tools/list'); assert.ok(list.tools.some(t => t.name === 'droid_supervise'))
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-mcp-supervision-'))
  run = await tool('droid_send', { cwd, message: '不调用任何工具，不读写文件。只输出 SUPERVISION_MCP_READY，随后按长期目标协议给 complete 报告，summary 为“只读联调完成”，remaining=[]。', supervision: { interval_s: 10, stall_s: 60, max_rounds: 3 }, timeout_s: 120, checks: ['node -e "process.exit(0)"'] })
  let done
  for (let i = 0; i < 10; i++) {
    const r = await tool('droid_wait', { run_id: run.run_id, timeout_s: 50 })
    if (r.timed_out) continue
    if (r.attention?.kind === 'checkpoint' || r.attention?.kind === 'stalled') { await tool('droid_supervise', { run_id: run.run_id, action: 'watch', attention_id: r.attention.id }); continue }
    assert.equal(r.attention?.kind, 'ready_for_review'); assert.equal(r.evidence.all_checks_passed, true); assert.match(r.checkpoint.summary, /只读联调完成/)
    assert.match((await tool('droid_status', { run_id: run.run_id })).final_text, /SUPERVISION_MCP_READY/)
    done = await tool('droid_supervise', { run_id: run.run_id, action: 'accept', attention_id: r.attention.id, reason: 'MCP 联调主控已核对只读目标输出、空文件变化和真实检查结果。' }); break
  }
  assert.equal(done?.state, 'completed')
  const report = { passed: true, tools: list.tools.length, model: done.model, run_id: done.run_id, rounds: done.supervisor.round, independently_checked: done.evidence.all_checks_passed, acceptance: done.acceptance }
  fs.writeFileSync(new URL('../docs/mcp-supervision-live.local.json', import.meta.url), JSON.stringify(report, null, 2)); console.log('PASS installed MCP supervision', JSON.stringify(report))
} catch (e) { if (run) await tool('droid_cancel', { run_id: run.run_id }).catch(() => {}); console.error(e.message); process.exitCode = 1 }
finally { for (const p of pending.values()) clearTimeout(p.timer); proc.stdin.end() }
