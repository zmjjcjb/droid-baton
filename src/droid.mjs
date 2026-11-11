// Factory's documented JSON-RPC subprocess interface, not a model API wrapper.
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import readline from 'node:readline'
import path from 'node:path'
import { ROOT, killTree } from './config.mjs'

export class Droid extends EventEmitter {
  constructor({ cwd, env = process.env } = {}) {
    super()
    this.nextId = 0; this.pending = new Map(); this.closed = false
    this.protocol = '1.260.0'
    this.child = spawn(process.execPath, [path.join(ROOT, 'src/worker.mjs')], { cwd, env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe', 'ipc'], windowsHide: true })
    this.child.stdin.on('error', () => {})
    this.child.stderr.on('data', chunk => this.emit('diagnostic', chunk.toString().slice(-4000)))
    this.reader = readline.createInterface({ input: this.child.stdout })
    this.reader.on('line', line => {
      if (line.length > 32 * 1024 * 1024) return this.fail(new Error('Droid 输出帧过大。'))
      let msg
      try { msg = JSON.parse(line) } catch { return this.emit('diagnostic', line.slice(0, 1000)) }
      if (msg.factoryProtocolVersion) this.protocol = msg.factoryProtocolVersion
      if (msg.method === 'droid.session_notification') this.emit('notification', msg.params?.notification, msg.params?.sessionId)
      else if (msg.method && msg.id !== undefined) this.emit('request', msg)
      else if (this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id); this.pending.delete(msg.id); clearTimeout(p.timer)
        msg.error ? p.reject(new Error(`${msg.error.message} (${msg.error.code})`)) : p.resolve(msg.result)
      }
    })
    this.child.on('error', error => this.fail(error))
    this.child.on('exit', (code, signal) => {
      killTree(this.child.pid, 'SIGKILL')
      this.fail(new Error(`Droid 进程退出：${signal || code}`))
    })
  }
  envelope(msg) { return { jsonrpc: '2.0', type: msg.method ? 'request' : 'response', factoryApiVersion: '1.0.0', factoryProtocolVersion: this.protocol, ...msg } }
  write(msg) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Droid 连接已关闭。')
    this.child.stdin.write(JSON.stringify(this.envelope(msg)) + '\n')
  }
  request(method, params = {}, { timeout = 30000, id = `baton-${++this.nextId}` } = {}) {
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} 超时`)) }, timeout) : null
      this.pending.set(id, { resolve, reject, timer })
      try { this.write({ id, method, params }) } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error) }
    })
  }
  answer(id, result) { this.write({ id, result }) }
  trackProcess(identity) { if (this.child.connected) this.child.send({ type: 'track_process', identity }, () => {}) }
  fail(error) {
    if (this.closed) return
    this.closed = true
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error) }
    this.pending.clear(); this.emit('disconnected', error)
    killTree(this.child.pid, 'SIGKILL')
  }
  close() { if (!this.closed) this.fail(new Error('Droid 会话连接已关闭。')) }
}
