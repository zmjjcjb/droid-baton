# Droid Baton

以 [dsh-baton 0.6.11](https://github.com/JialaoLiu/dsh-baton/tree/27856b463a7344952da32263719acb6ae97f8bef) 为模板，让 **Codex 规划和验收，Factory Droid 执行**。保留派发、续聊、队列、补充、等待、问答、取消和独立证据链。无需 npm 依赖。

当前版本 0.2.1，已在 Linux、Node 22.23.4、Droid 0.240.0 验证。保留原 MIT 许可证与署名，派生关系见 [NOTICE.md](NOTICE.md)。

## 长期任务监督

0.2 已加入同一目标的多轮续做、后台工作跟踪、失败检查后的有限修复、停滞/预算提醒和 Codex 审查接收。长期任务设置 `supervision: true`；需要终端可设置 `terminal: true`。完整流程、参数与边界见 [长期任务说明](docs/LONG_TASKS.md)。

## 开始使用

需要可正常使用的 Codex CLI、Factory Droid 和 Node.js ≥22.15。沿用 Droid 已有模型和登录/自定义 provider 配置，不读取或复制 API Key，不另行调用模型 API。

在本目录运行：

```bash
node src/cli.mjs setup
```

注册会备份 Codex 配置，只增加 `droid-baton` MCP 项；记录 Node、Droid 绝对路径及数据目录，避免桌面 PATH 与终端不同。之后在 Codex **新建聊天**加载工具。可先调用 `droid_list_models`，再发任务：

> 把这个任务交给 Droid，工作目录为 /absolute/project。只修改 src/example.mjs，完成后独立运行 npm test；失败就在同一会话修复，最后向我报告证据。

除非用户明确指定模型，否则新会话沿用 Droid 默认模型，续聊保留该会话模型。权限同样沿用 Droid，只有任务确有授权时才指定 `autonomy`。

打开本地面板：

```bash
node src/cli.mjs dashboard --open
```

面板可查看执行输出和工具记录，向运行中任务补充要求、排队续聊、回答问题、批准单次操作和停止任务。仅绑定 `127.0.0.1`，首次入口含本机访问密钥片段，请勿分享入口。

## 工具

| 工具 | 用途 |
| --- | --- |
| `droid_list_workspaces` | 桥接登记的工作目录 |
| `droid_list_sessions` | 桥接会话及本机保存的 Droid 主会话 |
| `droid_read_session` | 近期会话消息 |
| `droid_list_models` | Droid 实际可选模型，不返回凭据 |
| `droid_send` | 新建、续聊、followup 排队或 steer 补充 |
| `droid_status` | 一次查看状态、事件、问题、回复、用量和证据（默认精简视图） |
| `droid_wait` | 等待单个任务或多个任务中任一个结束/提问（默认精简视图） |
| `droid_answer` | 回答问题、选择列表，或批准/拒绝单次权限请求 |
| `droid_supervise` | 处理长期目标监督通知，纠偏、暂停/恢复及审查接收 |
| `droid_cancel` | 停止运行及所属工具进程树，不自动重试 |
| `droid_call` | 少用工具入口，缩短 MCP 工具目录 |

通过 `droid_call` 可调用 `droid_create_workspace`、`droid_rename_workspace`、`droid_rename_session`、`droid_session_activity`、`droid_update_queued`、`droid_list_runs`、`droid_dashboard`，参数见工具描述。

新任务必须指定 `cwd` 或 `workspace_id`。保存返回的 `run_id`、`session_id`，不要使用“最近会话”关联并行结果。MCP 派发还返回可后台执行的 `wait_command` 和等价 `wait_argv`/`wait_env`。

忙碌会话默认 `followup` 排队，前一项执行和独立验收结束后再开始。`steer` 在当前工具循环结束后补充到同一运行，返回同一 run_id；不能强行打断 shell。新增检查或换模型应使用 followup。前序运行失败、取消或服务重启时，排队任务取消，不会静默继续修改文件。

## 验收与等待

```text
starting → running → waiting（提问/权限）→ running → checking → completed
                   ↘ failed / cancelled / interrupted
```

- 派发前使用 Baton 文件快照引擎，结束后比较新增、修改、删除的文件。
- `checks` 由独立进程实际执行，返回退出码、耗时、输出尾部，不以 Droid 自报的“测试通过”代替。
- `completed` 只表示 Droid 本轮正常结束；还须检查 `evidence.all_checks_passed`。CLI wait 在检查失败时返回非零退出码。
- 完成表仍是模型自述，需求覆盖和代码质量需要验收，必要时审查 diff。
- 快照沿用上游范围：跳过依赖/构建/缓存目录及符号链接；最多枚举 100000 文件，对最多 3000 个近期文件取内容指纹，较大文件依赖元数据。不是全盘审计。
- 每条检查最多 120 秒，总检查预算 180 秒。检查在单独受管进程组内执行，可响应取消。命令须在用户授权范围内。
- 默认阻止不同会话同时修改相同/嵌套目录；并发用独立目录/工作树。显式 `allow_shared_cwd` 放开后证据可能串入其他运行的修改。

wait 使用事件等待，Codex MCP 默认单次 3540 秒、其他客户端及 CLI 每次连接默认 50 秒；完成、提问或监督通知提前返回。超时只结束本次等待。注册的 Codex 工具超时为 3600 秒。取消 MCP 等待或退出 Codex 不会自动停止 Droid；停止工作须显式 cancel。面板每 1.5 秒读取本地状态，不调用模型。

## 上下文开销

`droid_status` 和 `droid_wait` 默认返回精简视图，而不是 Droid 的完整记录。完整记录里 `work.tools` 保留最近 100 次工具调用的全部输入、`recent_events` 保留 30 条事件的完整载荷，单次序列化可达 200 KB 以上；监督者对同一个运行轮询几十次，这些字节会被反复计入上下文。

精简视图只保留监督者真正据以决策的内容：状态与计数、未结束的后台工作、最近 12 条事件的一行摘要、待答问题和验收结论。实测同一运行 **218.9 KB → 12.7 KB（减少 94%）**。

- `detail`：`summary`（默认）或 `full`。`full` 保留历史完整形状，供面板、CLI 和需要逐条证据的调用使用。
- `since_seq`：只返回 `seq` 大于该值的新事件。传上次返回的 `last_seq` 即可增量轮询，无新事件时返回几乎为零字节。
- 精简视图会报告被折叠的数量（`tools_not_shown`、`events_not_shown`），不会静默丢内容。
- 原始记录始终保留在 `~/.droid-baton/events/<run_id>.jsonl`，每条带单调递增的 `seq`。

监督者还应避免重复读取 Droid 正在修改的文件或运行它正在运行的命令。重复检测会在停滞通知中给出诊断：同一工具调用连续重复 3 次以上即提示可能原地打转，并附上最后使用的工具。

问题回答须附当前 `request_id`，过期/重复回答会被拒绝。权限只支持本次批准 `proceed_once` 和拒绝 `cancel`，不通过任务桥写永久授权。

## CLI 与维护

```bash
node src/cli.mjs doctor
node src/cli.mjs models
node src/cli.mjs sessions
node src/cli.mjs send --cwd /absolute/project --check 'npm test' '实现指定功能'
node src/cli.mjs send --session SESSION_ID --mode steer '补充要求'
node src/cli.mjs wait RUN_ID
node src/cli.mjs status RUN_ID
node src/cli.mjs cancel RUN_ID
node src/cli.mjs call answer '{"run_id":"RUN_ID","request_id":"REQUEST_ID","answers":[{"index":1,"answer":"自由文本"}]}'
```

wait 退出码：0 成功，1 执行/检查失败或取消/中断，2 等待输入，3 等待主控监督判断。

数据默认 `~/.droid-baton`，目录权限 0700，socket/状态/日志为当前用户所有。`DROID_BATON_HOME` 可改数据目录，`DROID_BIN` 可指定 Droid；改后重新 setup。`DROID_SESSIONS_DIR` 只影响原生会话只读发现。

MCP 与面板连接同一个独立任务服务。MCP 重启时任务继续；服务自身停止/崩溃时，受管 Droid/验收进程树被清理，运行标为 interrupted，不自动重放。闲置会话进程约 60 秒后释放，下次续聊恢复原生历史。

更新后先等待任务结束，再执行 `node src/cli.mjs stop`，下次调用自动启动新服务。保留 Baton 的 stdio 热更新外壳，但运行中的 broker 不做无缝热替换。

卸载执行 `node src/cli.mjs setup --remove` 和 `node src/cli.mjs stop`。运行记录及 Droid 原生会话保留。尚未发布 npm/GitHub，没有开机自启或计划任务。

## 差距与验证

对照见 [docs/COMPARISON.md](docs/COMPARISON.md)。主要差距：独立面板/监视终端代替原应用融合；不接管其他客户端中的活跃聊天；已增加有界目标监督及已观察原生任务跟踪，但还不是完整的 Factory Mission Control 或所有外部后台任务的接管。原生会话发现依赖已保存文件格式，外部会话续聊仅适用于已经停止的会话。

```bash
npm test                    # 自动化回归，不发真实模型请求
node scripts/ui-smoke.mjs    # 系统 Chrome：问答、创建、取消及手机宽度
npm run test:live            # 可选真实模型联调，会消耗当前 Droid 额度
```

实际结果见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。仅声明 Linux 实测，其他平台需另行联调。
