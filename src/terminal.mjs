import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { ROOT } from './config.mjs'

export async function openTerminal(runId, home) {
  const argv = [process.execPath, path.join(ROOT, 'src/cli.mjs'), 'watch', runId, '--keep-open']
  if (process.platform !== 'linux' || (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY)) return { launched: false, reason: '当前环境没有可用的 Linux 图形终端；可在终端执行 watch。', argv, env: { DROID_BATON_HOME: home } }
  let bin
  for (const name of ['gnome-terminal', 'konsole', 'x-terminal-emulator', 'xterm']) {
    try { bin = execFileSync('which', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); if (bin) break } catch {}
  }
  if (!bin) return { launched: false, reason: '未找到终端模拟器。', argv, env: { DROID_BATON_HOME: home } }
  const args = /gnome-terminal$/.test(bin) ? ['--title=Droid Baton · 任务执行', '--', ...argv] : ['-e', ...argv]
  return await new Promise(resolve => {
    const child = spawn(bin, args, { env: { ...process.env, DROID_BATON_HOME: home }, detached: true, stdio: 'ignore' })
    let settled = false
    const finish = result => { if (settled) return; settled = true; clearTimeout(timer); child.unref(); resolve(result) }
    const timer = setTimeout(() => finish({ launched: true, pid: child.pid, note: '已启动同一 Droid 任务的只读执行监视终端；没有另开第二个会话执行器。' }), 800)
    child.on('error', error => finish({ launched: false, reason: error.message, argv, env: { DROID_BATON_HOME: home } }))
    child.on('exit', code => finish({ launched: code === 0, exit_code: code, argv, env: { DROID_BATON_HOME: home } }))
  })
}
