// Baton's evidence engine runs outside the broker so checks never block control/cancel.
import * as evidence from './evidence.mjs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const [home, runId, mode] = process.argv.slice(2)
if (mode === '--collect') {
  try { process.stdout.write(JSON.stringify(evidence.collect(home, runId))) }
  catch (error) { process.stderr.write(error.stack); process.exitCode = 1 }
} else {
  // The original evidence engine uses synchronous checks. A separate wrapper
  // keeps the parent-death watchdog responsive even while a check is blocked.
  const parent = process.ppid
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), home, runId, '--collect'], { stdio: 'inherit' })
  child.on('error', error => { process.stderr.write(error.message); process.exit(1) })
  child.on('exit', code => process.exit(code ?? 1))
  setInterval(() => {
    let gone = process.ppid !== parent
    if (process.platform === 'win32') { try { process.kill(parent, 0) } catch { gone = true } }
    if (!gone) return
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'])
    else process.kill(-process.pid, 'SIGKILL')
    process.exit(1)
  }, 1000).unref()
}
