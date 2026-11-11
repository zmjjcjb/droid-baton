const token = location.hash.slice(1) || sessionStorage.getItem('droid-baton-token')
if (location.hash) { sessionStorage.setItem('droid-baton-token', token); history.replaceState(null, '', location.pathname) }
let selected, current, busy = false, lastDetail = ''
const $ = id => document.getElementById(id)
const names = { starting: '准备中', queued: '排队中', running: '执行中', waiting: '等待回答', checking: '独立验收中', background: '等待后台工作', review: '等待主控判断', paused: '已暂停', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' }
function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e }
function error(e) { $('notice').textContent = e.message }
async function api(method, params) {
  const res = await fetch('/api/call', { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ method, params }) })
  const data = await res.json(); if (!res.ok || data.error) throw new Error(data.error || '请求失败'); return data.result
}
function render(r) {
  const signature = JSON.stringify(r)
  current = r
  if (signature === lastDetail) return
  // Preserve an answer being typed while progress refreshes.
  if (r.needs_input && document.activeElement?.closest('#answer-form')?.dataset.request === r.pending?.request_id) return
  if (r.needs_attention && document.activeElement?.closest('#supervision-form')?.dataset.notice === r.attention?.id) return
  lastDetail = signature
  const d = $('detail'); d.replaceChildren()
  d.append(el('span', names[r.state] || r.state, `tag ${r.state}`), el('h1', r.message?.slice(0, 100) || '任务'), el('p', `${r.cwd} · ${r.model || 'Droid 默认模型'}`))
  const id = el('small', `运行 ${r.run_id} · 会话 ${r.session_id}`); d.append(id)
  if (r.error) d.append(el('pre', r.error))
  if (r.supervisor) d.append(el('p', `目标执行 ${r.supervisor.round}/${r.supervision.max_rounds} 轮 · 自动修复 ${r.supervisor.repairs}/${r.supervision.max_repairs} 次 · 已上报 ${r.supervisor.total_tokens} Token`))
  if (r.needs_attention) {
    const box = el('div', undefined, 'question'), form = el('form'); form.id = 'supervision-form'; form.dataset.notice = r.attention.id
    box.append(el('h2', '主控监督'), el('p', r.attention.message))
    const note = el('textarea'); note.rows = 2; note.placeholder = '判断依据；继续执行时可填写纠偏指令'; form.append(note)
    const actions = r.state === 'review' ? (r.checkpoint?.status === 'complete' ? [['accept', '审查后接收'], ['continue', '继续修复']] : [['continue', '继续执行']]) : [['watch', '正常，继续等待'], ['continue', '发送纠偏']]
    for (const [action, label] of actions) {
      const b = el('button', label); b.type = 'button'
      b.onclick = () => {
        if (action !== 'watch' && !note.value.trim()) return error(new Error('请填写判断依据或纠偏要求。'))
        api('supervise', { run_id: r.run_id, attention_id: r.attention.id, action, reason: note.value, ...(action === 'continue' ? { message: note.value } : {}) }).then(refresh).catch(error)
      }
      form.append(b)
    }
    box.append(form); d.append(box)
  }
  if (r.outstanding_work?.active) { const bg = el('details'); bg.append(el('summary', '尚未结束的后台工作'), el('pre', JSON.stringify(r.outstanding_work, null, 2))); d.append(bg) }
  if (r.needs_input) {
    const p = r.pending, box = el('div', undefined, 'question'); box.append(el('h2', p.kind === 'request_permission' ? 'Droid 请求批准操作' : 'Droid 有问题需要回答'))
    const form = el('form'); form.id = 'answer-form'; form.dataset.request = p.request_id
    if (p.kind === 'request_permission') {
      box.append(el('pre', JSON.stringify(p.toolUses, null, 2)))
      for (const o of p.options.filter(o => ['proceed_once', 'cancel'].includes(o.value))) {
        const b = el('button', o.value === 'cancel' ? '拒绝' : '批准本次操作'); b.type = 'button'
        b.onclick = () => api('answer', { run_id: r.run_id, request_id: p.request_id, selected_option: o.value, reason: '用户在本地任务面板明确选择。' }).then(refresh).catch(error); box.append(b)
      }
    } else if (p.kind === 'pick_options') {
      const inputs = p.rows.map(row => { const l = el('label', row.label), input = el('input'); input.type = p.multi ? 'checkbox' : 'radio'; input.name = 'pick'; input.value = row.id; l.prepend(input); form.append(l); return input })
      const b = el('button', '提交选择'); b.type = 'submit'; form.append(b)
      form.onsubmit = e => { e.preventDefault(); api('answer', { run_id: r.run_id, request_id: p.request_id, selected_ids: inputs.filter(x => x.checked).map(x => x.value) }).then(refresh).catch(error) }; box.append(form)
    } else {
      const inputs = p.questions.map(q => {
        const l = el('label', q.question), input = el('textarea'); input.required = true; input.rows = 2
        const options = el('p', q.options.join(' / '), 'hint'); l.append(options, input); form.append(l); return { q, input }
      })
      const b = el('button', '提交回答', 'primary'); b.type = 'submit'; form.append(b)
      form.onsubmit = e => { e.preventDefault(); api('answer', { run_id: r.run_id, request_id: p.request_id, answers: inputs.map(({ q, input }) => ({ index: q.index, answer: input.value })) }).then(refresh).catch(error) }; box.append(form)
    }
    d.append(box)
  }
  const output = r.partial_text || r.final_text
  if (output) d.append(el('h2', r.partial_text ? (['running', 'waiting'].includes(r.state) ? '正在输出' : '停止前的输出') : 'Droid 回复'), el('pre', output))
  if (r.steers?.length) d.append(el('h2', '运行中补充'), el('pre', r.steers.map(x => `${x.sender === 'human' ? '你' : 'Codex'}：${x.message}`).join('\n')))
  const logs = el('details'), summary = el('summary', '执行记录'); logs.append(summary, el('pre', (r.recent_events || []).map(e => `${e.time.slice(11, 19)} ${e.name || e.type}\n${e.text || e.input || e.result || ''}`).join('\n'))); d.append(logs)
  if (r.evidence) d.append(el('h2', '独立验收证据'), el('pre', JSON.stringify(r.evidence, null, 2)))
  if (r.usage) { const u = el('details'); u.append(el('summary', '本次用量'), el('pre', JSON.stringify(r.usage, null, 2))); d.append(u) }
  if (!['completed', 'failed', 'cancelled', 'interrupted'].includes(r.state)) {
    const b = el('button', r.state === 'queued' ? '取消排队' : '停止任务', 'danger'); b.onclick = () => api('cancel', { run_id: r.run_id }).then(refresh).catch(error); d.append(b)
  }
}
async function refresh() {
  if (busy) return; busy = true
  try {
    const res = await fetch('/api/state', { headers: { Authorization: `Bearer ${token}` } })
    const state = await res.json(); if (!res.ok) throw new Error(state.error || '连接失败')
    $('connection').textContent = '本地服务已连接'; $('notice').textContent = ''
    $('runs').replaceChildren()
    if (!selected && state.runs.length) selected = state.runs[0].run_id
    for (const r of state.runs) {
      const b = el('button', undefined, `run ${r.run_id === selected ? 'selected' : ''}`)
      b.append(el('span', names[r.state] || r.state, `tag ${r.state}`), el('div', r.message), el('small', r.cwd))
      b.onclick = () => { selected = r.run_id; lastDetail = ''; refresh() }; $('runs').append(b)
    }
    if (!$('cwd').value && state.workspaces.length) $('cwd').value = state.workspaces[0].path
    if (selected) render(await api('status', { run_id: selected, detail: 'full' }))
  } catch (e) { $('connection').textContent = '连接不可用'; error(e) } finally { busy = false }
}
$('refresh').onclick = refresh
$('mode').onchange = () => { $('checks').disabled = $('mode').value === 'steer'; $('supervision').disabled = $('mode').value === 'steer' }
$('compose').onsubmit = async e => {
  e.preventDefault()
  const mode = $('mode').value
  if (mode !== 'new' && !current) return error(new Error('请先选择一个任务。'))
  const params = { message: $('message').value, ...(mode === 'new' ? { cwd: $('cwd').value } : { session_id: current.session_id, mode }), ...(mode !== 'steer' ? { checks: $('checks').value.split('\n').filter(s => s.trim()) } : {}) }
  if (mode !== 'steer' && $('supervision').checked) params.supervision = true
  try { const r = await api('send', params); selected = r.run_id; $('message').value = ''; lastDetail = ''; await refresh() } catch (e) { error(e) }
}
refresh(); setInterval(refresh, 1500)
