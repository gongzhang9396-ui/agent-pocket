# DeepSeek Harness 接入核验与实施边界

状态：2026-11-06 已实现 DSH Agent、Flutter／网页入口和 Android 0.4.1（401）候选。实际能力及尚未完成的发布项目见 [接入验收记录](DEEPSEEK-INTEGRATION-ACCEPTANCE.md)。下文保留最初核验和设计边界，“拟定”不代表全部已经开放。

## 已验证事实

- 本机官方 CLI 包为 `@deepseek-ai/dsh@0.2.1-rc.2`，通过 npm 安装。存在 `DSH_HOME` 自定义数据目录；接入必须沿用这个目录，不能误用默认目录生成另一套空会话。
- `dsh --profile acp --help` 和 `dsh --profile web --help` 均可运行。Windows Host 应解析 npm 入口并用 Node 启动，不能将 `.ps1/.cmd` 当作普通可执行文件直接 `spawn(..., shell:false)`。
- 对实际 CLI 做了 `initialize` 和 `session/list`：协议版本 1，服务标识 `deepseek-harness-acp`，返回 4 个持久会话，无下一页。没有创建、恢复、发送、取消任何会话，也没有调用模型。
- 这次握手声明 `session/list`、`session/resume`、`session/close`，图片、音频及 embedded context 均为 false。不能以官方新版文档提及图片就启用本机附件能力。
- 检查时未发现可确认归属 DSH 的运行中进程及监听器。安装 CLI 和保存会话不等于已启动可供 Pocket 连接的 Host。
- 忽略目录中的本机记录：`output/dsh-20261106/acp-probe.mjs`、`acp-probe-result.json`。记录仅保留能力和数量，不包含会话标题、正文、凭据。

## 接入选择

目标是把 DSH 作为 Codex、Grok 之外的第三个 Agent，保留电脑已有对话、历史、模型选择及交互。优先采用 **DSH 官方 Host 的 Session Controller / API Gateway**，保持一个执行器负责会话；Pocket 继续通过现有加密 Relay 访问电脑。

ACP 可作自动化接入参考和兼容探测，但本机版本不提供 transcript replay、用户提问、Plan 等完整交互面，且使用 `session/resume`，不支持 Grok 适配器依赖的 `session/load`。不能直接复制 Grok 适配器并替换命令。

同一数据目录下的独立 Web、桌面、ACP 进程不自动成为同一个执行器。已有会话被其他进程持有时，必须保留 `session/writer-held` 冲突；不能删除锁、结束用户进程或另起 writer 强行续写。

## 拟定功能映射

以下为已安装官方包类型与实现中的服务方法，不代表 Pocket 已实现，也不代表可以直接构造同名 HTTP 路由。

| Pocket 功能 | DSH 服务 | 边界 |
| --- | --- | --- |
| 任务列表、搜索 | `session.list/search` | 冷读；按 Pocket 项目白名单再过滤 |
| 聊天历史 | `session.page` | 按 durable seq 分页，保留事件版本 |
| 实时回复、断线补齐 | `session.follow` | durable 序列与临时 assistant stream 分开处理 |
| 新建任务 | `session.create` | 使用服务返回的实际 sessionId；不能假定请求 ID 就是最终 ID |
| 发送、运行中插话 | `session.prompt` 的 `queue/steer` | requestId 对应 Pocket operationId；按运行能力开放 |
| 待发送消息 | `session.updateQueue` | 精确匹配 itemId，不操作其他队列项 |
| 中断 | `session.cancel` | 只影响目标活动；不隐式清空其待发送消息 |
| 模型与推理档位 | `session.modelCatalog/selectModel` | 从实际模型目录读取；选择操作有默认设置副作用，见下文 |
| 用户提问 | live `user-questions/request` waterfall；continued `userQuestions.answer(sessionId, callId, answer)` | 读取 `userQuestions` projection 区分 open / continued；按准确 callId 回答 |
| 工具审批 | `approval/request` scoped waterfall | 单次允许、拒绝、取消；不是 Session Controller 上假设的 `approval/respond` 方法 |
| 文件、图片 | DSH file upload / attachment 能力 | 单独核验类型、上限、归属及模型支持后再开放；不能直接套用 Codex 的 20 MiB 支持结论 |

## 必须先解决的两个协议细节

1. **交互权限。** `/connect` 可建立 API operator，声明 `interactions=answer` 仍不足以取得所有交互回答权。`PeerOptions` 明确说明非 owner Peer 不能回答 waterfall。新提问的 live waterfall 与已继续提问的 Remote answer 是两条路径。需使用官方允许的 owner 交互接入或本地 DSH 插件适配；不得绕过认证、扩大永久授权，或把过期提问显示为可回答。
2. **模型设置副作用。** 当前 `SessionController.selectModel()` 同时在后台调用 `agentDefaultModel.saveSelection()`。读取或打开模型面板不能调用它。若 Pocket 承诺仅改变当前会话，则适配层需要明确的会话级选择路径并核验，不应悄悄修改电脑的默认模型。

Host 启动与复用也须有可验证的本地发现信息。默认由本地适配管理 loopback 服务及认证连接；无需让用户在手机填写另一套 DSH 地址或模型凭据。复用不了已运行桌面进程时应明确提示，不能宣称已实现跨端共享。

## Pocket 代码改造边界

- Bridge 新增独立 DSH provider，任务 ID 使用 `dsh:<sessionId>`，分页游标与事件 `source` 独立。未知 Agent 不得回落到 Codex。
- 继续使用现有 operation ledger：请求未知时查询回执和 DSH 已提交的 requestId，不自动重发；创建与发送分别处理。保留线程级写入串行化。
- `AgentTaskStore` 当前硬编码 Grok，`native_id` 还有全表 UNIQUE 约束；不能直接共用后让两个 Agent 的原生 ID 冲突。优先保留 DSH 自身历史，不把它伪装成 Grok transcript。
- Flutter 的任务抓取、筛选、计数、任务标识和新建面板改为依照 `agent/list` 与 capabilities，清除 Codex/Grok 二选一判断。
- 网页端增加同等功能入口，现有 iOS 网页容器随网页更新获得入口；本次不涉及 Flutter iOS 重写。
- 不更改 Relay 的模型执行职责，不把 DSH 的密钥下发手机，不用公开 DSH 服务代替现有 Relay。

## 实施及验收顺序

1. 完成本地 Host 发现、官方认证连接及 owner 交互原型；验证冷读已有历史不会激活或迁移会话，固定实际兼容版本。
2. 实现 DSH provider 与合约测试：历史分页、事件补齐、requestId 去重、未知发送结果、writer 冲突、模型实际生效、审批和提问过期/重复回答。
3. 接入 Flutter 与网页的动态 Agent 入口；按实际声明能力开放附件、插话和其他控制。Plan/Goal 不因 DSH 内部存在同名工具就直接启用 Codex 控件。
4. 隔离项目验证真实一轮文本、工具审批拒绝、用户提问、电脑与手机交替续聊，再做 Android 真机和 iOS 网页容器验收。
5. Host 空闲时部署兼容更新；签名构建新的 Android 版本后，再登记服务器更新渠道。保留现有 0.4.0 扫码修复候选和用户身份数据。

## 依据

官方文档随 master 变化；本次能力判断以已安装 `0.2.1-rc.2` 包及实际握手为准。

- [官方 ACP 合约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)
- [官方 ACP profile](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md)
- [官方 Session Controller](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/api/session-controller/README.md)
- 本地包内 `dsh-api-session-controller/lib/types/index.d.ts`、`types.d.ts`，及 `lib/index.js` 的 `selectModel` 实现。
- 本地包内 `dsh-client-connection/lib/types/peer.d.ts`、`rpc-host.d.ts`、`browser-auth.d.ts`。
- 本地包内 `dsh-user-questions/lib/typert.remote-client.d.ts`、`dsh-user-approval/lib/types/types.d.ts`，以及 `dsh-client-ui-user-questions/lib/client.js` 的 `rpcFor` 和 `PendingQuestion.answer`。
- [DSH Go](https://github.com/ccch1mneyyy/dsh-go)：产品体验和远程接入参考，使用 SSH / DSHarness Remote；不意味着 Pocket 必须引入同一套远程服务。
