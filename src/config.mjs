import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
export const HOME = path.resolve(process.env.DROID_BATON_HOME || path.join(os.homedir(), '.droid-baton'))
export const SOCKET = process.platform === 'win32' ? `\\\\.\\pipe\\droid-baton-${Buffer.from(HOME).toString('hex').slice(-100)}` : path.join(HOME, 'broker.sock')
export const now = () => new Date().toISOString()
export function privateDir(dir = HOME) { fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); fs.chmodSync(dir, 0o700) }
export function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback } }
export function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, file)
}
export function realDir(dir) {
  if (typeof dir !== 'string' || !dir.trim()) throw new Error('必须指定工作目录 cwd，或 workspace_id/session_id。')
  const abs = fs.realpathSync(dir.replace(/^~(?=$|[\\/])/, os.homedir()))
  if (!fs.statSync(abs).isDirectory()) throw new Error('cwd 必须是目录。')
  return abs
}
export function killTree(pid, signal = 'SIGTERM') {
  if (!pid) return
  try {
    if (process.platform === 'win32') {
      import('node:child_process').then(({ execFile }) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => {}))
    } else process.kill(-pid, signal)
  } catch (error) { if (error.code !== 'ESRCH') throw error }
}
