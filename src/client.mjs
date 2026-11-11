import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { ROOT, HOME, SOCKET, privateDir } from './config.mjs'

export function connectCall(method, params = {}, { signal, timeout = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(SOCKET)
    let data = '', settled = false
    const finish = (error, value) => {
      if (settled) return; settled = true
      clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy()
      error ? reject(error) : resolve(value)
    }
    const abort = () => finish(new Error('等待已取消；Droid 任务仍在运行。如需停止任务，请调用 droid_cancel。'))
    const timer = setTimeout(() => finish(new Error(`${method} 连接超时。`)), timeout)
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort, { once: true })
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method, params }) + '\n'))
    socket.on('error', error => finish(error))
    socket.on('close', () => finish(new Error('Droid Baton 服务连接中断；请求可能已被接收。请查状态，勿盲目重复派发。')))
    socket.on('data', chunk => {
      data += chunk
      if (data.length > 16 * 1024 * 1024) return finish(new Error('任务结果过大。'))
      const end = data.indexOf('\n'); if (end === -1) return
      try { const msg = JSON.parse(data.slice(0, end)); finish(msg.error ? new Error(msg.error) : null, msg.result) } catch (e) { finish(e) }
    })
  })
}
let starting
export async function ensureBroker() {
  try { return await connectCall('ping', {}, { timeout: 1000 }) } catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error
  }
  starting ??= (async () => {
    privateDir()
    const log = path.join(HOME, 'broker.log')
    if (fs.existsSync(log) && fs.statSync(log).size > 4 * 1024 * 1024) fs.renameSync(log, log + '.1')
    const fd = fs.openSync(log, 'a', 0o600)
    const proc = spawn(process.execPath, [path.join(ROOT, 'src/daemon.mjs')], { cwd: osHome(), detached: true, stdio: ['ignore', fd, fd], env: process.env, windowsHide: true })
    proc.on('error', () => {}); proc.unref(); fs.closeSync(fd)
    const until = Date.now() + 10000
    let last
    while (Date.now() < until) {
      await new Promise(r => setTimeout(r, 100))
      try { const info = await connectCall('ping', {}, { timeout: 500 }); if (info.url) return info } catch (error) { last = error }
    }
    throw new Error(`本地任务服务启动失败：${last?.message || '超时'}。诊断日志：${log}`)
  })().finally(() => { starting = null })
  return await starting
}
function osHome() { return process.env.USERPROFILE || process.env.HOME || ROOT }
export async function call(method, params = {}, options = {}) {
  const info = await ensureBroker()
  const bareMethod = method.replace(/^droid_/, '')
  const readOnly = ['ping', 'status', 'list_runs', 'list_models', 'list_workspaces', 'list_sessions', 'read_session', 'dashboard']
  if (info.version !== (await import('./config.mjs')).VERSION && !readOnly.includes(bareMethod)) throw new Error(`运行中的任务服务版本是 ${info.version}，与当前代码不一致。请先等待已有任务结束，再执行 droid-baton stop；下次调用会启动新版本。`)
  const bare = method.replace(/^droid_/, '')
  const timeout = bare === 'wait' ? (Math.min(Number(params.timeout_s) || 50, 3540) + 10) * 1000 : bare === 'supervise' ? 210000 : 60000
  // Retry only connection establishment via ensureBroker; never replay a send after disconnect.
  return await connectCall(method, params, { timeout, ...options })
}
