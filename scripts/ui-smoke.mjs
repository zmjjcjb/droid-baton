// Browser integration check using system Chrome and its DevTools protocol. No npm deps.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'droid-baton-ui-'))
process.env.DROID_BATON_HOME = path.join(tmp, 'home')
process.env.DROID_BIN = path.join(root, 'tests/fixtures/fake-droid.mjs')
process.env.DROID_FAKE_SESSIONS = path.join(tmp, 'native')
fs.chmodSync(process.env.DROID_BIN, 0o755)
const { call } = await import('../src/client.mjs')
const { killTree } = await import('../src/config.mjs')
const cwd = path.join(tmp, 'project'); fs.mkdirSync(cwd)
let chrome, ws, broker
const sleep = ms => new Promise(r => setTimeout(r, ms))
try {
  const r = await call('send', { cwd, message: 'MOCK:QUESTION' })
  await call('wait', { run_id: r.run_id, timeout_s: 5 })
  broker = await call('dashboard')
  const profile = path.join(tmp, 'chrome')
  chrome = spawn(process.env.CHROME_BIN || '/usr/bin/google-chrome', ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', `--user-data-dir=${profile}`, 'about:blank'], { detached: true, stdio: 'ignore' })
  const portFile = path.join(profile, 'DevToolsActivePort')
  for (let i = 0; !fs.existsSync(portFile) && i < 200; i++) await sleep(50)
  const port = fs.readFileSync(portFile, 'utf8').split('\n')[0]
  const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let id = 0; const pending = new Map(), exceptions = []
  ws.onmessage = e => { const msg = JSON.parse(e.data); if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params); const own = pending.get(msg.id); if (own) { pending.delete(msg.id); clearTimeout(own.timer); msg.error ? own.reject(new Error(msg.error.message)) : own.resolve(msg.result) } }
  const cdp = (method, params = {}) => new Promise((resolve, reject) => { const requestId = ++id; const timer = setTimeout(() => reject(new Error(`Chrome timeout: ${method}`)), 10000); pending.set(requestId, { resolve, reject, timer }); ws.send(JSON.stringify({ id: requestId, method, params })) })
  const evaluate = async expression => { const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails)); return r.result?.value }
  async function until(expression) { for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await sleep(50) } throw new Error('UI did not reach expected state: ' + expression) }
  await cdp('Page.enable'); await cdp('Runtime.enable'); await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false })
  await cdp('Page.navigate', { url: broker.url })
  await until(`document.querySelector('#answer-form textarea') !== null`)
  await evaluate(`document.querySelector('#answer-form textarea').focus();document.querySelector('#answer-form textarea').value='GREEN_UI';document.querySelector('#answer-form').requestSubmit()`)
  await until(`document.querySelector('#detail').textContent.includes('GREEN_UI') && document.querySelector('#detail .completed') !== null`)
  await evaluate(`document.querySelector('#cwd').value=${JSON.stringify(cwd)};document.querySelector('#message').value='MOCK:WAIT';document.querySelector('#compose').requestSubmit()`)
  await until(`document.querySelector('#detail .running') !== null`)
  await evaluate(`document.querySelector('#detail button.danger').click()`)
  await until(`document.querySelector('#detail .cancelled') !== null`)
  await evaluate(`document.querySelector('#supervision').checked=true;document.querySelector('#message').value='MOCK:GOAL_STAGES';document.querySelector('#checks').value='node -e "require(\\'fs\\').accessSync(\\'b.txt\\')"';document.querySelector('#compose').requestSubmit()`)
  await until(`document.querySelector('#supervision-form textarea') !== null && document.querySelector('#detail .review') !== null`)
  await evaluate(`document.querySelector('#supervision-form textarea').focus();document.querySelector('#supervision-form textarea').value='UI 已核对目标与独立检查';Array.from(document.querySelectorAll('#supervision-form button')).find(b=>b.textContent.includes('接收')).click()`)
  await until(`document.querySelector('#detail .completed') !== null && document.querySelector('#detail').textContent.includes('MOCK:GOAL_STAGES')`)
  await cdp('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true })
  assert.equal(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), true)
  assert.equal(exceptions.length, 0)
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true })
  fs.writeFileSync(path.join(root, 'docs/dashboard-mobile.png'), Buffer.from((await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })).data, 'base64'))
  console.log('PASS browser: question answer, create task, cancel task, long goal acceptance, mobile width, no JS exceptions')
} finally {
  ws?.close(); if (chrome) killTree(chrome.pid, 'SIGKILL')
  if (broker) { try { process.kill(broker.pid, 'SIGTERM') } catch {} }
  await sleep(200)
  fs.rmSync(tmp, { recursive: true, force: true })
}
