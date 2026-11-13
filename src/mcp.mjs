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
const detailOpt = { type: 'string', enum: ['decision', 'summary', 'full'], description: 'decision=决定所需的信息；summary=进度和近期事件；full=完整状态。' }
const sinceOpt = seq('仅用于 summary，返回 seq 大于此值的近期事件。')
export const tools = [
  { name: 'droid_list_workspaces', description: '列出 Droid Baton 登记的工作目录；不等同于 Factory 桌面侧栏。', inputSchema: schema() },
  { name: 'droid_list_sessions', description: '列出桥接会话及本机保存的 Droid 主会话，含模型和运行状态。读取原生文件只用于发现，不修改它们。', inputSchema: schema({ cwd: str('按目录筛选。'), query: str('按标题或目录搜索。'), limit: int('最多条数。') }) },
  { name: 'droid_read_session', description: '读取指定会话的近期可见消息。使用明确 session_id，不要用“最近会话”关联并发任务。', inputSchema: schema({ session_id: str('会话 ID。'), last: int('近期消息数。', 1, 100) }, ['session_id']) },
  { name: 'droid_list_models', description: '查询本机 Droid 当前实际可选模型。不要读取设置文件里的凭据。除非用户指定模型，否则派发时省略 model，沿用 Droid 默认/会话配置。', inputSchema: schema() },
  { name: 'droid_send', description: '把完整目标、任务说明文件路径、允许范围和验收交给本机 Factory Droid。新任务用 cwd/workspace_id，续聊用 session_id；忙碌时 followup 排队，steer 在当前工具循环后投递。长期任务设 supervision:true，能独立执行的验收放入 checks。派发后用 droid_wait 等事件，Codex 处理授权、实际阻塞及最终验收。', inputSchema: schema({ message: str('完整任务说明。'), cwd: str('绝对工作目录。'), workspace_id: str('已登记工作目录 ID。'), session_id: str('续聊会话 ID。'), mode: { type: 'string', enum: ['followup', 'steer'] }, checks: { type: 'array', items: str('授权范围内的独立验收命令。'), maxItems: 10 }, model: str('仅用户明确指定时填写实际模型 ID。'), reasoning_effort: str('仅用户明确要求时填写。'), autonomy: { type: 'string', enum: ['off', 'low', 'medium', 'high'], description: '仅按用户授权设置；省略沿用 Droid 权限。' }, timeout_s: int('总运行时限，秒；默认 21600。', 1, 604800), title: str('会话标题。'), allow_shared_cwd: { type: 'boolean', description: '用户明确需要时允许并发会话修改重叠目录；证据可能混入。' }, detail: detailOpt }, ['message']) },
  { name: 'droid_status', description: '按需查看一次进度，默认 summary。常规等待用 droid_wait。', inputSchema: schema({ ...selector, detail: detailOpt, since_seq: sinceOpt }) },
  { name: 'droid_wait', description: '一次等待单个或多个运行的结束、待答问题或监督决定。Codex 省略 timeout_s 可等至 3540 秒；普通巡检留在本地。默认返回 decision。等待超时或取消仅结束等待。保留仍在执行的 ID 再等；已收到的终态从 run_ids 移除。', inputSchema: schema({
    ...selector, run_ids: { type: 'array', items: str('运行 ID。'), minItems: 1, maxItems: 64 },
    timeout_s: int('单次等待上限，秒。Codex 默认 3540，其他客户端默认 50。', 1, 3540),
    after_attention: { type: 'object', additionalProperties: { type: 'string' }, description: '可选，每个 run_id 已收到的 attention.id 或 pending.request_id；该等待只返回新通知。' },
    detail: detailOpt, since_seq: sinceOpt,
  }) },
  { name: 'droid_answer', description: '按当前 request_id 回答问题或选择。权限只支持当前请求给出的 cancel 或 proceed_once；批准需要用户授权依据。', inputSchema: schema({ run_id: str('运行 ID。'), request_id: str('当前 pending.request_id。'), answers: { type: 'array', items: schema({ index: int('问题 index。'), answer: str('用户回答，可用选项原文或自由文本。') }, ['index', 'answer']) }, cancelled: { type: 'boolean' }, selected_option: str('权限选项：proceed_once 或 cancel。'), selected_ids: { type: 'array', items: str('选择列表里的 ID。') }, reason: str('代答或权限批准的授权依据。'), detail: detailOpt }, ['run_id', 'request_id']) },
  { name: 'droid_cancel', description: '停止指定运行及其会话队列，终止所属进程。仅取消 queued run_id 时只移除该项。', inputSchema: schema({ ...selector, detail: detailOpt }) },
  { name: 'droid_call', description: '调用少用工具：droid_create_workspace(path,title?,create_dir?)、droid_rename_workspace(workspace_id,title)、droid_rename_session(session_id,title)、droid_session_activity、droid_update_queued(run_id,action=edit/remove/steer,message?)、droid_list_runs(session_id?,limit?)、droid_dashboard。也可调用上列工具。', inputSchema: schema({ name: str('工具名。'), arguments: { type: 'object', description: '对应参数。' } }, ['name']) },
]
const supervisionSchema = schema({ interval_s: int('本地巡检间隔，默认 300 秒。', 10, 86400), stall_s: int('无实质进展的提醒阈值，默认 900 秒。', 10, 86400), max_rounds: int('执行轮次上限，默认 12。', 1, 50), max_repairs: int('独立检查失败后的自动修复次数，默认 2。', 0, 10), max_tokens: int('Droid 已上报的 input+output 上限；0 不启用。', 0, 100000000), auto_continue: { type: 'boolean', description: '默认 true，范围和预算内自动续做及修复。' }, require_review: { type: 'boolean', description: '默认 true，检查通过后由 Codex 审查再接收。' }, notify_progress: { type: 'boolean', description: '默认 false。仅用户需要定期主控介入时启用，普通巡检也会唤醒 Codex。' } })
const sendTool = tools.find(t => t.name === 'droid_send')
sendTool.inputSchema.properties.supervision = { oneOf: [{ type: 'boolean' }, supervisionSchema], description: '长期任务设 true，启用本地巡检、有界续做、独立验收失败修复及主控审查。' }
sendTool.inputSchema.properties.terminal = { type: 'boolean', description: '可选，打开同一任务的只读监视终端；不启动第二个执行器。' }
tools.splice(tools.length - 1, 0, { name: 'droid_supervise', description: '处理 needs_attention。watch 确认通知；continue 纠偏或续做；accept 审查需求覆盖和证据后接收；pause/resume 暂停/恢复。提供当前 attention_id。预算用尽、明确阻塞和终止须按原授权处理。', inputSchema: schema({ run_id: str('目标运行 ID。'), action: { type: 'string', enum: ['watch', 'continue', 'accept', 'pause', 'resume'] }, attention_id: str('当前 attention.id。'), reason: str('主控判断依据；continue/accept/resume 必填。'), message: str('授权范围内的纠偏或续做要求。'), accept_without_checks: { type: 'boolean', description: '没有 checks 且主控已审查产物时显式开启。' }, detail: detailOpt }, ['run_id', 'action']) })
tools.find(t => t.name === 'droid_call').description += ' 还支持 droid_supervise 和 droid_open_terminal(run_id)。旧聊天可通过本入口调用新工具。'
const known = new Set([...tools.map(t => t.name), ...['create_workspace', 'rename_workspace', 'rename_session', 'session_activity', 'update_queued', 'list_runs', 'dashboard', 'open_terminal'].map(x => `droid_${x}`)])
const write = msg => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
const pending = new Map()
const decisionTools = new Set(['droid_send', 'droid_wait', 'droid_supervise', 'droid_answer', 'droid_cancel'])
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
      if (args.detail === undefined) {
        if (decisionTools.has(name)) args = { ...args, detail: 'decision' }
        else if (name === 'droid_status') args = { ...args, detail: 'summary' }
      }
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
