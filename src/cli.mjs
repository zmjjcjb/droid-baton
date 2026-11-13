#!/usr/bin/env node
import { parseArgs } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { call, connectCall } from './client.mjs'
import { setup } from './setup.mjs'
import { HOME, readJson } from './config.mjs'

const help = `Droid Baton — Codex → Factory Droid
  node src/cli.mjs setup [--remove]         注册/移除 Codex MCP
  node src/cli.mjs dashboard [--open]       本机任务面板
  node src/cli.mjs models | workspaces | sessions | runs
  node src/cli.mjs send --cwd /path "任务" [--check "npm test"]
  node src/cli.mjs send --session ID --mode steer "补充要求"
  node src/cli.mjs wait RUN_ID              阻塞等待完成/问题，可后台运行
  node src/cli.mjs watch RUN_ID [--open]    实时监视同一任务（可另开终端）
  node src/cli.mjs send --supervise ...     多轮目标监督；默认最多12轮/2次修复
  node src/cli.mjs status RUN_ID
  node src/cli.mjs cancel RUN_ID
  node src/cli.mjs call METHOD '{"参数":"值"}'
  node src/cli.mjs doctor | stop
发送参数：--model ID --autonomy off|low|medium|high --timeout 秒 --check 命令（可重复）
问题/权限通过面板或 call answer 回答；不自动代答。`
const { values: v, positionals: pos } = parseArgs({ allowPositionals: true, options: { cwd: { type: 'string' }, session: { type: 'string' }, mode: { type: 'string' }, model: { type: 'string' }, autonomy: { type: 'string' }, timeout: { type: 'string' }, check: { type: 'string', multiple: true }, remove: { type: 'boolean' }, open: { type: 'boolean' }, supervise: { type: 'boolean' }, 'keep-open': { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } })
const print = data => process.stdout.write(JSON.stringify(data, null, 2) + '\n')
try {
  const cmd = pos[0]
  if (!cmd || v.help || cmd === 'help') process.stdout.write(help + '\n')
  else if (cmd === 'setup') print(setup({ remove: v.remove }))
  else if (cmd === 'stop') {
    const info = readJson(path.join(HOME, 'broker.json'))
    const live = await connectCall('ping', {}, { timeout: 1000 }).catch(() => null)
    if (live && live.pid === info?.pid) { process.kill(live.pid, 'SIGTERM'); print({ stopped: true, pid: live.pid }) }
    else print({ stopped: false, message: '服务未运行。' })
  } else if (cmd === 'doctor') {
    const info = await call('ping'); const models = await call('list_models')
    print({ ...info, model_count: models.models?.length, node: process.version, data_permissions: (fs.statSync(HOME).mode & 0o777).toString(8), note: '仅验证接口，不证明模型请求或工具执行可用。' })
  } else if (cmd === 'send') {
    print(await call('send', { message: pos.slice(1).join(' '), ...(v.cwd ? { cwd: v.cwd } : {}), ...(v.session ? { session_id: v.session } : {}), ...(v.mode ? { mode: v.mode } : {}), ...(v.model ? { model: v.model } : {}), ...(v.autonomy ? { autonomy: v.autonomy } : {}), ...(v.timeout ? { timeout_s: Number(v.timeout) } : {}), ...(v.supervise ? { supervision: true } : {}), checks: v.check || [] }))
  } else if (cmd === 'wait') {
    let result
    for (;;) {
      result = await call('wait', { run_id: pos[1], timeout_s: 3540 })
      if (!result.timed_out) break
    }
    print(result)
    if (['failed', 'cancelled', 'interrupted'].includes(result.state) || result.evidence?.all_checks_passed === false) process.exitCode = 1
    else if (result.needs_input) process.exitCode = 2
    else if (result.needs_attention) process.exitCode = 3
  } else if (cmd === 'watch') {
    if (v.open) print(await call('open_terminal', { run_id: pos[1] }))
    else {
      process.stdout.write('Droid Baton · 执行监视（Ctrl+C 只关闭监视，不停止任务）\n')
      const plain = s => String(s || '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
      let revision = -1, seq = 0, state, text = '', notice
      for (;;) {
        const r = await call('observe', { run_id: pos[1], after_revision: revision, timeout_s: 50 }); revision = r.revision || 0
        if (r.state !== state) { process.stdout.write(`\n[${r.state}] ${r.supervisor ? `第 ${r.supervisor.round} 轮` : ''}\n`); state = r.state }
        for (const e of r.recent_events || []) if ((e.seq || 0) > seq) {
          seq = e.seq
          if (e.type !== 'assistant') process.stdout.write(plain(`${e.time.slice(11, 19)} ${e.name || e.type} ${e.input || e.error || e.text || ''}`) + '\n')
        }
        const next = r.partial_text || r.final_text || ''
        if (next !== text) { process.stdout.write(plain(next.startsWith(text) ? next.slice(text.length) : '\n' + next)); text = next }
        if (r.attention && r.attention.id !== notice) { notice = r.attention.id; process.stdout.write('\n需要主控判断：' + plain(r.attention.message) + '\n') }
        if (['completed', 'failed', 'cancelled', 'interrupted'].includes(r.state)) { process.stdout.write(`\n任务结束：${r.state}\n`); break }
      }
      if (v['keep-open'] && process.stdin.isTTY) { process.stdout.write('按 Enter 关闭窗口。\n'); await new Promise(resolve => { process.stdin.resume(); process.stdin.once('data', resolve) }); process.stdin.pause() }
    }
  } else if (cmd === 'dashboard') {
    const info = await call('dashboard'); print(info)
    if (v.open) {
      const file = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer.exe' : 'xdg-open'
      const proc = spawn(file, [info.url], { detached: true, stdio: 'ignore' }); proc.on('error', error => process.stderr.write(error.message + '\n')); proc.unref()
    }
  } else if (cmd === 'call') print(await call(pos[1], JSON.parse(pos[2] || '{}')))
  else if (['status', 'cancel'].includes(cmd)) print(await call(cmd, v.session ? { session_id: v.session } : { run_id: pos[1] }))
  else if ({ models: 1, workspaces: 1, sessions: 1, runs: 1 }[cmd]) print(await call(`list_${cmd}`, v.cwd ? { cwd: v.cwd } : {}))
  else throw new Error(`未知命令：${cmd}\n${help}`)
} catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1 }
