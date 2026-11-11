// Use the installed Codex entry verbatim, speaking MCP as a Codex client would.
import { execFileSync, spawn } from 'node:child_process'
import readline from 'node:readline'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
const config = JSON.parse(execFileSync('codex', ['mcp', 'get', 'droid-baton', '--json'], { encoding: 'utf8' })).transport
const proc = spawn(config.command, config.args, { cwd: config.cwd, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
let id = 0; const pending = new Map()
proc.stderr.on('data', b => process.stderr.write(b))
readline.createInterface({ input: proc.stdout }).on('line', line => {
  const msg = JSON.parse(line), own = pending.get(msg.id)
  if (!own) return
  pending.delete(msg.id); clearTimeout(own.timer); msg.error ? own.reject(new Error(msg.error.message)) : own.resolve(msg.result)
})
const rpc = (method, params = {}) => new Promise((resolve, reject) => { const n = ++id, timer = setTimeout(() => reject(new Error('MCP deadline')), 60000); pending.set(n, { resolve, reject, timer }); proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n') })
async function tool(name, args) { const r = await rpc('tools/call', { name, arguments: args }); if (r.isError) throw new Error(r.content[0].text); return JSON.parse(r.content[0].text) }
try {
  await rpc('initialize', { protocolVersion: '2025-03-26', clientInfo: { name: 'codex-live-verification', version: '1' }, capabilities: {} })
  const list = await rpc('tools/list'); assert.equal(list.tools.length, 11)
  const models = await tool('droid_list_models', {}); assert.ok(models.models.length > 0)
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-baton-mcp-real-'))
  const run = await tool('droid_send', { cwd, message: '只回复 MCP_DROID_BATON_OK，不调用工具，不读写文件。', checks: ['node -e "process.exit(0)"'], timeout_s: 90 })
  const result = await tool('droid_wait', { run_id: run.run_id, timeout_s: 50 })
  assert.equal(result.state, 'completed'); assert.match(result.final_text, /MCP_DROID_BATON_OK/); assert.equal(result.evidence.all_checks_passed, true)
  console.log(JSON.stringify({ passed: true, tools: list.tools.length, models: models.models.length, run_id: run.run_id, model: result.model, reply: result.final_text, checks_passed: result.evidence.all_checks_passed }))
  const reportFile = new URL('../docs/live-verification.local.json', import.meta.url)
  const report = JSON.parse(fs.readFileSync(reportFile)); report.tests.push({ name: '按已安装 Codex 配置完整 MCP→真实 Droid→独立验收', passed: true, run_id: run.run_id, session_id: run.session_id }); fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))
} catch (error) { console.error(error.message); process.exitCode = 1 }
finally { for (const p of pending.values()) clearTimeout(p.timer); proc.stdin.end() }
