# Droid Baton

以 [dsh-baton 0.6.11](https://github.com/JialaoLiu/dsh-baton/tree/27856b463a7344952da32263719acb6ae97f8bef) 为模板，让 **Codex 规划和验收，Factory Droid 执行**。保留派发、续聊、队列、补充、等待、问答、取消和独立证据链。无需 npm 依赖。

当前版本 0.2.2，验证环境为 Linux、Node 22.23.4、Droid 0.240.0。保留原 MIT 许可证与署名，派生关系见 [NOTICE.md](NOTICE.md)。

本仓库为 [zmjjcjb/droid-baton](https://github.com/zmjjcjb/droid-baton)。不是 Factory 或 OpenAI 的官方集成。

## 长期任务监督

长期任务设置 `supervision: true`，在同一运行内有界续做、跟踪后台工作并独立验收。默认由本地服务巡检。提问、需要决定的异常和最终验收才返回 Codex。需要实时看进度可设置 `terminal: true`。完整参数见 [长期任务说明](docs/LONG_TASKS.md)。

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
| `droid_wait` | 等待一个或多个任务结束、提问或请求监督决定 |
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

Codex 的 `droid_wait` 默认单次 3540 秒，其他 MCP 客户端默认 50 秒。CLI `wait` 在进程内继续等待，直到有终态或待处理事件。等待超时或取消时，Droid 继续执行。显式 cancel 停止工作。面板每 1.5 秒读取本地状态，无需调用模型。

## 上下文开销

派发后用一次 `droid_wait` 等待，多任务合用 `run_ids`。每次处理完终态就移除相应 ID。暂时保留待处理通知时，可用 `after_attention` 记录已收到的通知 ID，等待该运行的新通知或其他运行的结果。

- `droid_send`、`droid_wait`、`droid_supervise`、`droid_answer` 和 `droid_cancel` 默认使用 `detail: "decision"`，返回状态、待答请求、完成报告和检查结果等当前所需的信息。
- `droid_status` 默认使用 `detail: "summary"`，供按需查看进度与近期事件。传入 `since_seq` 可筛选更新的近期事件。
- `detail: "full"` 读取完整运行状态；需要原始工具记录时可读 `~/.droid-baton/events/<run_id>.jsonl`，需要完整验收记录时可读 `evidence_record`。

交接长任务时，把任务文件路径、执行范围、预算和验收命令一次给 Droid。预检、实施、运行和可自动判断的验收由 Droid 与本地服务处理。Codex 处理确需主控的决定并核查最终证据。

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

卸载执行 `node src/cli.mjs setup --remove` 和 `node src/cli.mjs stop`。运行记录及 Droid 原生会话保留。尚未发布 npm 包，没有开机自启或计划任务。

## 差距与验证

对照见 [docs/COMPARISON.md](docs/COMPARISON.md)。主要差距：独立面板/监视终端代替原应用融合；不接管其他客户端中的活跃聊天；已增加有界目标监督及已观察原生任务跟踪，但还不是完整的 Factory Mission Control 或所有外部后台任务的接管。原生会话发现依赖已保存文件格式，外部会话续聊仅适用于已经停止的会话。

```bash
npm test                    # 自动化回归，不发真实模型请求
node scripts/ui-smoke.mjs    # 系统 Chrome：问答、创建、取消及手机宽度
npm run test:live            # 可选真实模型联调，会消耗当前 Droid 额度
```

实际结果见 [docs/VERIFICATION.md](docs/VERIFICATION.md)。仅声明 Linux 实测，其他平台需另行联调。
