import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ROOT, HOME } from './config.mjs'

export function setup({ remove = false } = {}) {
  const config = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml')
  fs.mkdirSync(path.dirname(config), { recursive: true, mode: 0o700 })
  const before = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : ''
  const backup = `${config}.bak-droid-baton-${Date.now()}`
  if (before) fs.writeFileSync(backup, before, { mode: 0o600 })
  let droidBin = process.env.DROID_BIN
  if (!remove && !droidBin) {
    try { droidBin = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['droid'], { encoding: 'utf8' }).trim().split(/\r?\n/)[0] } catch { throw new Error('找不到 Droid；先安装 Droid 或设置 DROID_BIN。') }
  }
  // Do not round-trip the user's file through `codex mcp add`: its serializer can
  // normalize or discard fields of OTHER MCP entries. Replace only our tables.
  let skip = false
  const kept = before.split(/\r?\n/).filter(line => {
    if (/^\s*\[/.test(line)) {
      skip = /^\s*\[mcp_servers\.(?:droid-baton|"droid-baton"|'droid-baton')(?:\.[^\]]+)?\]\s*(?:#.*)?$/.test(line)
    }
    return !skip
  }).join('\n').trimEnd()
  const own = remove ? '' : [
    '[mcp_servers.droid-baton]',
    `command = ${JSON.stringify(process.execPath)}`,
    `args = [${JSON.stringify(path.join(ROOT, 'src/server.mjs'))}]`,
    `cwd = ${JSON.stringify(os.homedir())}`,
    'tool_timeout_sec = 3600',
    '', '[mcp_servers.droid-baton.env]',
    `DROID_BIN = ${JSON.stringify(droidBin)}`,
    `DROID_BATON_HOME = ${JSON.stringify(HOME)}`,
  ].join('\n')
  const text = [kept, own].filter(Boolean).join('\n\n') + '\n'
  const tmp = `${config}.${process.pid}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, config)
  return { registered: !remove, config, backup: before ? backup : undefined, message: remove ? 'Removed only the droid-baton MCP entry.' : 'Registered only the droid-baton MCP entry.', next: remove ? '只移除 MCP 注册；任务服务和运行记录保留。' : '在 Codex 新建聊天以加载 droid_* 工具。当前聊天的工具目录不保证即时更新。' }
}
