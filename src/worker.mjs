// Own the complete process group. If the broker dies, do not leave Droid/tools running.
import { spawn } from 'node:child_process'
import { ownedProcess, stopProcess } from './processes.mjs'
const parent = process.ppid
const background = new Map()
const cleanup = () => { for (const identity of background.values()) { try { stopProcess(identity) } catch {} } }
process.on('message', msg => {
  if (msg?.type !== 'track_process') return
  const identity = ownedProcess(msg.identity?.pid, process.pid)
  if (identity?.start_ticks === msg.identity.start_ticks) background.set(identity.pid, identity)
})
process.on('exit', cleanup)
process.on('SIGTERM', () => { cleanup(); process.exit(143) })
process.on('SIGHUP', () => { cleanup(); process.exit(129) })
const bin = process.env.DROID_BIN || 'droid'
const child = spawn(bin, ['exec', '--input-format', 'stream-jsonrpc', '--output-format', 'stream-jsonrpc'], { stdio: 'inherit', windowsHide: true })
child.on('error', error => { process.stderr.write(`${error.message}\n`); process.exit(127) })
child.on('exit', code => process.exit(code ?? 1))
setInterval(() => {
  let gone = process.ppid !== parent
  if (process.platform === 'win32') { try { process.kill(parent, 0) } catch { gone = true } }
  if (!gone) return
  cleanup()
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'])
  else process.kill(-process.pid, 'SIGKILL')
  process.exit(1)
}, 1000).unref()
