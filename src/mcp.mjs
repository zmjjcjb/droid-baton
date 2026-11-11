// Baton-style newline JSON-RPC over stdio. Requests run concurrently so a wait does
// not prevent answering a question, steering or cancellation from another client.
import readline from 'node:readline'
import path from 'node:path'
import { call } from './client.mjs'
import { ROOT, HOME, VERSION } from './config.mjs'

const str = description => ({ type: 'string', description })
const int = (description, minimum = 1, maximum = 200) => ({ type: 'integer', description, minimum, maximum })
const seq = description => ({ type: 'integer', description, minimum: -1 })
const schema = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false })
const selector = { run_id: str('运行 ID。'), session_id: str('会话 ID。') }
const detailOpt = { type: 'string', enum: ['summary', 'full'], description: 'summary=精简摘要（默认，省上下文）；full=完整记录（体积大，仅在需要逐条证据时使用）。' }
const sinceOpt = seq('只返回 seq 大于该值的新事件；传上次返回的 last_seq 即可增量读取，避免重复拉取。-1 表示全部。')
export const tools = [
  { name: 'droid_list_workspaces', description: '列出 Droid Baton 登记的工作目录；不等同于 Factory 桌面侧栏。', inputSchema: schema() },
  { name: 'droid_list_sessions', description: '列出桥接会话及本机保存的 Droid 主会话，含模型和运行状态。读取原生文件只用于发现，不修改它们。', inputSchema: schema({ cwd: str('按目录筛选。'), query: str('按标题或目录搜索。'), limit: int('最多条数。') }) },
  { name: 'droid_read_session', description: '读取指定会话的近期可见消息。使用明确 session_id，不要用“最近会话”关联并发任务。', inputSchema: schema({ session_id: str('会话 ID。'), last: int('近期消息数。', 1, 100) }, ['session_id']) },
  { name: 'droid_list_models', description: '查询本机 Droid 当前实际可选模型。不要读取设置文件里的凭据。除非用户指定模型，否则派发时省略 model，沿用 Droid 默认/会话配置。', inputSchema: schema() },
  { name: 'droid_send', description: '将明确目标、允许修改范围和验收方式交给本机 Factory Droid 执行。立即返回 run_id、session_id、任务面板入口及 wait_command。新任务必须给 cwd/workspace_id；session_id 续聊。同一忙碌会话默认 followup 排队；steer 在当前工具循环结束后补充要求，不能强行打断 shell。checks 由桥接程序独立运行，命令须在用户授权范围内。并行任务使用独立目录。等待用 droid_wait 或后台 wait_command，勿反复 status 轮询；可以按用户要求同时做独立工作。', inputSchema: schema({ message: str('完整任务说明。'), cwd: str('绝对工作目录。'), workspace_id: str('已登记工作目录 ID。'), session_id: str('续聊会话 ID。'), mode: { type: 'string', enum: ['followup', 'steer'] }, checks: { type: 'array', items: str('授权范围内的验收命令。'), maxItems: 10 }, model: str('仅用户明确指定时填写实际模型 ID。'), reasoning_effort: str('仅用户明确要求时填写。'), autonomy: { type: 'string', enum: ['off', 'low', 'medium', 'high'], description: '仅按用户授权设置；省略则沿用 Droid 权限。不能据此推断 Codex 权限已转授。' }, timeout_s: int('总运行时限，秒；默认 21600。', 1, 86400), title: str('会话标题。'), allow_shared_cwd: { type: 'boolean', description: '用户明确需要时允许并发会话修改重叠目录；证据会互相混入。默认拒绝。' } }, ['message']) },
  { name: 'droid_status', description: '用户要求时查看一次进度、近期工具、回复、输入请求或独立验收结果。默认返回精简摘要；需要完整逐条记录时传 detail=full。常规等待请用 droid_wait。', inputSchema: schema({ ...selector, detail: detailOpt, since_seq: sinceOpt }) },
  { name: 'droid_wait', description: '事件驱动等待单个/多个任务完成或请求输入，不消耗模型轮次轮询进度。多个任务用一次 run_ids，任一个结束即返回。MCP 断连仅取消等待，任务仍运行。timed_out=true 时继续等待，勿把超时视为任务失败；停止必须显式 droid_cancel。收到问题后用 droid_answer；只按用户已授权范围代答。完成后基于 evidence 验收，必要时检查 diff。默认返回精简摘要；把上次返回的 last_seq 作为 since_seq 传入即可只取新增事件。', inputSchema: schema({ ...selector, run_ids: { type: 'array', items: str('运行 ID。'), minItems: 1, maxItems: 64 }, timeout_s: int('单次等待秒数，最大 3540；默认 50。', 1, 3540), detail: detailOpt, since_seq: sinceOpt }) },
  { name: 'droid_answer', description: '回答 Droid 当前提问、选择或权限请求；必须带当前 request_id，防止错答旧问题。未经授权不要替用户选择；转交时先给自己的建议。权限仅支持 cancel 或 proceed_once，不写永久规则。代答后向用户说明回答和依据。', inputSchema: schema({ run_id: str('运行 ID。'), request_id: str('当前 pending.request_id。'), answers: { type: 'array', items: schema({ index: int('问题 index。'), answer: str('用户回答，可用选项原文或自由文本。') }, ['index', 'answer']) }, cancelled: { type: 'boolean' }, selected_option: str('权限选项：proceed_once 或 cancel，且必须由本次 Droid 提供。'), selected_ids: { type: 'array', items: str('选择列表里的 ID。') }, reason: str('代答或权限批准的授权依据。') }, ['run_id', 'request_id']) },
  { name: 'droid_cancel', description: '停止指定运行及该会话后续排队消息，终止属于它的 Droid/工具进程树。仅取消 queued run_id 时只移除该排队消息。尊重用户停止，不要自行重试。', inputSchema: schema(selector) },
  { name: 'droid_call', description: '调用少用工具：droid_create_workspace(path,title?,create_dir?)、droid_rename_workspace(workspace_id,title)、droid_rename_session(session_id,title)、droid_session_activity、droid_update_queued(run_id,action=edit/remove/steer,message?)、droid_list_runs(session_id?,limit?)、droid_dashboard。也可调用上列工具。', inputSchema: schema({ name: str('工具名。'), arguments: { type: 'object', description: '对应参数。' } }, ['name']) },
]
const supervisionSchema = schema({ interval_s: int('返回主控监督摘要的间隔，默认 300 秒。', 10, 86400), stall_s: int('无内容/工具/文件进展的提醒阈值，默认 900 秒；心跳不算进展。', 10, 86400), max_rounds: int('自动执行轮次上限，默认 12。', 1, 50), max_repairs: int('验收失败后自动修复次数，默认 2。', 0, 10), max_tokens: int('累计上报 input+output Token 上限；0 不启用，非金额预算。', 0, 100000000), auto_continue: { type: 'boolean' }, require_review: { type: 'boolean', description: '默认 true，检查通过后返回 Codex 审查再接收。' } })
const sendTool = tools.find(t => t.name === 'droid_send')
sendTool.inputSchema.properties.supervision = { oneOf: [{ type: 'boolean' }, supervisionSchema], description: '长期任务设 true：同一目标有界续做、后台跟踪、独立验收失败修复、巡检和主控审查；默认最多 12 轮/2 次修复，每 5 分钟监督一次。不自动提高权限或切换模型。' }
sendTool.inputSchema.properties.terminal = { type: 'boolean', description: '可选，打开同一任务的只读监视终端；不启动第二个执行器。' }
sendTool.inputSchema.properties.timeout_s.maximum = 604800
sendTool.description += ' 长期任务必须设 supervision=true 并尽量提供 checks；收到 needs_attention 后调用 droid_supervise 作出判断，再继续等待，直到目标接收或明确失败。不要在第一次轮次结束时提前收尾。'
sendTool.description += ' 你是监督者，不是执行者：负责澄清目标、拆解、纠偏和验收，执行交给 Droid。不要自己去读 Droid 正在改的文件或跑它正在跑的命令——那会重复消耗上下文并与 Droid 冲突；需要证据时看返回的 evidence 与 events 摘要，确需逐条记录再传 detail=full。'
tools.splice(tools.length - 1, 0, { name: 'droid_supervise', description: '处理长期任务监督通知。watch=确认当前进展正常并继续等待；continue=给执行中任务纠偏或让本轮结束的目标继续；accept=审查需求覆盖后接收（要求完成报告、已观察后台结束、独立检查通过）；pause/resume=显式暂停/恢复。带当前 attention_id 防止误处理旧通知。不得因为 Codex 工具返回、Droid 声称完成或轮次结束就结束整个目标；持续 droid_wait，处理 checkpoint/stalled/checks_failed 等通知。达到预算、原生故障或用户停止时不擅自绕过。', inputSchema: schema({ run_id: str('目标运行 ID。'), action: { type: 'string', enum: ['watch', 'continue', 'accept', 'pause', 'resume'] }, attention_id: str('当前 attention.id。'), reason: str('主控判断依据；continue/accept/resume 必填。'), message: str('纠偏/续做要求，仍在原始授权范围内。'), accept_without_checks: { type: 'boolean', description: '仅没有 checks 且主控已审查产物时显式开启。' }, detail: detailOpt }, ['run_id', 'action']) })
tools.find(t => t.name === 'droid_wait').description += ' needs_attention=true 时目标尚未结束：查看 attention，调用 droid_supervise 后再次等待。Codex 默认单次等待 3540 秒，遇到监督通知会提前返回；不要用短间隔反复请求进度。增量轮询：把上次返回的 last_seq 作为 since_seq 传入，只取新增事件，避免重复拉取同一批内容。'
tools.find(t => t.name === 'droid_call').description += ' 还支持 droid_supervise 和 droid_open_terminal(run_id)。旧聊天可通过本入口调用新工具。'
const known = new Set([...tools.map(t => t.name), ...['create_workspace', 'rename_workspace', 'rename_session', 'session_activity', 'update_queued', 'list_runs', 'dashboard', 'open_terminal'].map(x => `droid_${x}`)])
const write = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const pending = new Map()
let clientName = 'Codex'
const quote = s => `'${s.replace(/'/g, `'\\''`)}'`
const waitCommand = id => `env ${quote(`DROID_BATON_HOME=${HOME}`)} ${quote(process.execPath)} ${quote(path.join(ROOT, 'src/cli.mjs'))} wait ${quote(id)}`
async function handle(msg) {
  if (!msg || typeof msg !== 'object' || Array.isArray(msg) || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    write({ id: null, error: { code: -32600, message: 'Invalid Request' } }); return
  }
  if (msg.method === 'notifications/cancelled') { pending.get(msg.params?.requestId)?.abort(); return }
  if (msg.id === undefined) return
  const controller = new AbortController(); pending.set(msg.id, controller)
  try {
    let result
    if (msg.method === 'initialize') {
      clientName = msg.params?.clientInfo?.name || 'Codex'
      const versions = ['2025-06-18', '2025-03-26', '2024-11-05']
      result = { protocolVersion: versions.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : versions[0], capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'droid-baton', version: VERSION }, instructions: '把任务交给本机 Factory Droid 并带回证据；从 droid_send 开始。' }
    } else if (msg.method === 'ping') result = {}
    else if (msg.method === 'tools/list') result = { tools }
    else if (msg.method === 'tools/call') {
      let name = msg.params?.name, args = msg.params?.arguments || {}
      if (name === 'droid_call') { name = args.name; args = args.arguments || {} }
      if (!known.has(name)) throw new Error(`未知工具 ${name}。可用：${[...known].join(', ')}`)
      if (name === 'droid_send') args = { ...args, sender: /codex|chatgpt/i.test(clientName) ? 'codex' : clientName }
      if (name === 'droid_wait' && args.timeout_s === undefined) args = { ...args, timeout_s: /codex|chatgpt/i.test(clientName) ? 3540 : 50 }
      // Every MCP result is copied into the supervisor's context and paid for on
      // each poll. The compact view is the default here; `detail: 'full'` stays
      // available for a caller that genuinely needs every recorded field.
      if ((name === 'droid_status' || name === 'droid_wait' || name === 'droid_supervise') && args.detail === undefined) args = { ...args, detail: 'summary' }
      let progress
      if (name === 'droid_wait' && msg.params?._meta?.progressToken !== undefined) {
        const start = Date.now()
        progress = setInterval(() => write({ method: 'notifications/progress', params: { progressToken: msg.params._meta.progressToken, progress: Math.floor((Date.now() - start) / 1000), message: '正在等待 Droid；有结果或问题时返回。' } }), 20000)
      }
      try {
        const data = await call(name, args, { signal: controller.signal })
        if (name === 'droid_send') {
          data.wait_command = process.platform === 'win32' ? undefined : waitCommand(data.run_id)
          data.wait_argv = [process.execPath, path.join(ROOT, 'src/cli.mjs'), 'wait', data.run_id]
          data.wait_env = { DROID_BATON_HOME: HOME }
          data.dashboard = (await call('dashboard')).url
          if (args.terminal) data.terminal = await call('open_terminal', { run_id: data.run_id })
        }
        result = { content: [{ type: 'text', text: JSON.stringify(data) }] }
      } finally { clearInterval(progress) }
    } else { write({ id: msg.id, error: { code: -32601, message: `Unknown method ${msg.method}` } }); return }
    write({ id: msg.id, result })
  } catch (error) {
    if (msg.method === 'tools/call') write({ id: msg.id, result: { isError: true, content: [{ type: 'text', text: error.message }] } })
    else write({ id: msg.id, error: { code: -32603, message: error.message } })
  } finally { pending.delete(msg.id) }
}
const reader = readline.createInterface({ input: process.stdin })
reader.on('line', line => {
  if (line.length > 2 * 1024 * 1024) return write({ id: null, error: { code: -32600, message: 'Request too large' } })
  let msg; try { msg = JSON.parse(line) } catch { return write({ id: null, error: { code: -32700, message: 'Parse error' } }) }
  void handle(msg)
})
reader.on('close', () => { for (const c of pending.values()) c.abort() })
