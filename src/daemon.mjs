#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import crypto from 'node:crypto'
import { Broker } from './broker.mjs'
import { ROOT, HOME, SOCKET, privateDir, readJson, writeJson } from './config.mjs'

privateDir()
const lock = path.join(HOME, 'broker.lock')
try {
  const fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd)
} catch (error) {
  if (error.code !== 'EEXIST') throw error
  const pid = Number(fs.readFileSync(lock, 'utf8'))
  let alive = false
  try { process.kill(pid, 0); alive = true } catch (e) { if (e.code === 'EPERM') alive = true }
  // A killed child can remain a zombie until its parent reaps it. kill(pid, 0)
  // succeeds for zombies; they must not prevent recovery of a stale socket/lock.
  if (alive && process.platform === 'linux') {
    try { const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); if (stat.slice(stat.lastIndexOf(')') + 2).startsWith('Z ')) alive = false } catch {}
  }
  if (alive) process.exit(0)
  fs.unlinkSync(lock)
  const fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd)
}
const broker = new Broker()
const tokenFile = path.join(HOME, 'dashboard-token.json')
let token = readJson(tokenFile)?.token
if (!token) { token = crypto.randomBytes(32).toString('hex'); writeJson(tokenFile, { token }) }
if (process.platform !== 'win32') { try { fs.unlinkSync(SOCKET) } catch (e) { if (e.code !== 'ENOENT') throw e } }
const peers = new Set()
const local = net.createServer(socket => {
  peers.add(socket); socket.on('error', () => {}); socket.on('close', () => peers.delete(socket))
  let buf = '', handled = false
  const abort = new AbortController(); socket.on('close', () => abort.abort())
  socket.setEncoding('utf8')
  socket.on('data', chunk => {
    if (handled) return
    buf += chunk
    if (buf.length > 2 * 1024 * 1024) return socket.destroy()
    const end = buf.indexOf('\n'); if (end === -1) return
    handled = true
    void (async () => {
      let req
      try {
        req = JSON.parse(buf.slice(0, end))
        const result = await broker.call(req.method, req.params, abort.signal)
        socket.end(JSON.stringify({ id: req.id, result }) + '\n')
      } catch (error) { socket.end(JSON.stringify({ id: req?.id, error: error.message }) + '\n') }
    })()
  })
})
const safeEqual = value => {
  const actual = Buffer.from(value || ''), expected = Buffer.from(`Bearer ${token}`)
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected)
}
const dashboard = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
  const host = `127.0.0.1:${dashboard.address().port}`
  if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== `http://${host}`)) { res.writeHead(403); return res.end('Forbidden') }
  const url = new URL(req.url, `http://${host}`)
  const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] }
  if (req.method === 'GET' && assets[url.pathname]) {
    const [file, mime] = assets[url.pathname]; res.setHeader('Content-Type', mime); return res.end(fs.readFileSync(path.join(ROOT, 'web', file)))
  }
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  if (!safeEqual(req.headers.authorization)) { res.writeHead(401); return res.end(JSON.stringify({ error: '需要本机任务面板访问密钥；请用 droid-baton dashboard 获取入口。' })) }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const runs = Object.values(broker.state.runs).slice(-100).reverse().map(r => ({ run_id: r.run_id, session_id: r.session_id, state: r.state, cwd: r.cwd, message: r.message.slice(0, 150), created_at: r.created_at, model: r.model }))
    return res.end(JSON.stringify({ workspaces: Object.values(broker.state.workspaces), runs }))
  }
  if (req.method !== 'POST' || url.pathname !== '/api/call') { res.writeHead(404); return res.end('{}') }
  if (!req.headers['content-type']?.startsWith('application/json')) { res.writeHead(415); return res.end('{}') }
  let body = ''
  try {
    for await (const chunk of req) { body += chunk; if (body.length > 2 * 1024 * 1024) throw new Error('请求过大') }
    const { method, params } = JSON.parse(body)
    const allowed = ['send', 'status', 'answer', 'cancel', 'supervise', 'open_terminal', 'read_session', 'list_models', 'rename_session', 'update_queued', 'create_workspace']
    if (!allowed.includes(method)) throw new Error('此操作不能通过面板调用。')
    return res.end(JSON.stringify({ result: await broker.call(method, { ...params, ...(method === 'send' ? { sender: 'human' } : {}) }) }))
  } catch (error) { res.writeHead(400); res.end(JSON.stringify({ error: error.message })) }
})
let stopping = false
async function stop() {
  if (stopping) return; stopping = true
  await broker.close()
  for (const peer of peers) peer.destroy()
  local.close(); dashboard.close()
  try { fs.unlinkSync(lock) } catch {}
  try { if (process.platform !== 'win32') fs.unlinkSync(SOCKET) } catch {}
  process.exit(0)
}
process.on('SIGTERM', stop); process.on('SIGINT', stop)
process.on('uncaughtException', error => { process.stderr.write(error.stack + '\n'); void stop() })
local.listen(SOCKET, () => { if (process.platform !== 'win32') fs.chmodSync(SOCKET, 0o600) })
dashboard.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${dashboard.address().port}/#${token}`
  broker.dashboardInfo = { url, pid: process.pid, socket: SOCKET }
  writeJson(path.join(HOME, 'broker.json'), broker.dashboardInfo)
})
