# Desktop 网页审批（开发版）

此改动扩展电脑端适配与现有网页卡片，不改变 `/app` 同源部署、密码/TOTP、设备验证、加密通道或任务 writer。稳定版 v0.3.2 与线上服务不会因源码修改自动升级。

## 支持范围

| 原生请求 | 网页行为 |
| --- | --- |
| `item/commandExecution/requestApproval` | 完整命令、目录、原因和网络范围；只显示原生允许的“允许本次 / 拒绝 / 取消” |
| `item/fileChange/requestApproval` | 展示完整文件改动；相同的一次性决定范围 |
| 权限扩展、MCP、身份验证、未知请求 | 提示回 Desktop，不发送响应 |
| 缺少命令/文件详情、不可识别版本、非本地 Host | 关闭审批能力，保留原读取/续写路径 |

现有 Android 的 `approval/respond` 参数仍兼容；它不必提供新增字段，服务端按保存的请求身份路由。旧 Attach 不声明能力时保持原行为。网页关闭或锁定只断开连接，不会拒绝审批或中断任务。

## 契约与信任边界

1. 网页通过已有认证和加密 Host channel 调用 `thread/interactions`、`approval/respond`。Relay 仍只处理密文。
2. Host 使用现有随机令牌认证的 Attach named pipe；新增 `thread/approvals`、`approval/respond`，要求 `desktop-approval-v1`。对用户暴露的三个 MCP 工具保持只读。
3. Attach 连接同 Windows 用户的 `\\.\pipe\codex-ipc`，使用长度前缀 JSON。每次读取、响应均新建连接，初始化后发现 owner，并只订阅指定本地 thread 的 owner。
4. 本实现只接受状态流版本 11、原生审批方法版本 1（local）。不同版本不能试探性写入，也不能降级到另一个 writer。
5. 只从新订阅返回的 `requests` 获取当前待处理请求；历史工具条目仅补全同一 item 的命令/文件详情，不能创建审批。
6. 每次提交重新读取实时快照，核对线程 ID、规范化 cwd、原生 owner、保留类型的 request ID、完整内容指纹和允许的决定。网页传入的 target/backend/agent 不能更换审批路由。
7. 同 Windows 用户的本地 Desktop 和 Attach 属于可信边界；这不是公开、稳定的 Desktop 扩展 API。Desktop 升级后需要兼容回归。

状态流 v11 与本地 command/file response v1 中，`availableDecisions` 是可选字段；仅这两个已知方法缺省时采用固定的 `accept / decline / cancel` 集合，并转换为网页的一次性决定。显式空数组、错误类型、只允许会话级授权或其他版本均不能获得这组默认值。

短连接期间出现 patch、未知状态、owner 离线或超出 16 MiB 的原生帧时放弃本次读取；下一次请求重新取得 snapshot，不用不完整状态批准。单项可展示审批详情限制为 128 KiB，过大时回 Desktop。

## 去重和不确定结果

Bridge 使用现有 SQLite `pending_requests.response_json` 保存 `submitting / unknown / succeeded / resolved_elsewhere`，没有新增数据库表。原生身份形成独立于客户端 operationId 的持久唯一 request ID。

- 向 Attach 发出审批前，原子占用对应 pending 行。崩溃留下的 `submitting` 与 `unknown` 一样不能重发。
- 同一线程、同一带类型的原生请求 ID 在持续存在期间固定绑定首次 owner 和指纹；owner 变化不能生成另一张可操作卡片。只有实时快照明确观察到原请求消失后，已确定状态的身份才可结束；unknown 保持占用。
- 只有 Attach 明确确认尚未发送原生决定的错误才释放占用。Socket 超时、断线、错误/外部 owner 回执以及不完整回执均按 unknown 处理。
- 已成功请求的同决定返回重复成功；不同决定冲突。普通 operation ledger 仍检查相同 operationId 的请求指纹。
- 原生请求消失且本机未尝试提交时，只标记已在其他位置处理，不推断用户选择。已经 unknown 的请求不会仅凭消失改为成功。
- 消失状态使用条件更新，不能覆盖并发提交的 `submitting / unknown`。成功回执和明确未发送的错误仍按原提交结果结算。
- 原生 pending 的 tombstone 不随 24 小时事件窗口删除，避免长任务在清理或重启后被重新批准。它们会包含审批元数据，应与 Host 数据库一同保护；本版不提供自动清理 unknown tombstone 的入口。

网页在可见状态每 4 秒串行补齐当前任务交互；后台恢复先同步再启用按钮。连接关闭、能力缺失、已处理或 unknown 时关闭操作。点击立即禁用，传输错误只查询原 operationId，不自动重发。命令和 diff 通过 React 文本节点展示，不解释 HTML。

## 验证与启用

运行：

```powershell
cd bridge
npm test
cd ..\relay
npm test
npm run build
npx tsc -p web/tsconfig.json --noEmit
cd ..
node desktop-attach-plugin/scripts/ipc-self-test.mjs
node desktop-attach-plugin/scripts/non-desktop-self-test.mjs
node desktop-attach-plugin/scripts/hooks-self-test.mjs
node desktop-attach-plugin/scripts/rollout-reader-test.mjs
```

新增自动测试使用临时 SQLite、模拟 Attach 和模拟原生 named pipe，覆盖跨 follower 连接定向到同 owner、分帧/粘帧、版本/目录/身份错误、内容改变、状态失效、丢回执、并发、不同 operationId、重启和事件过期。网页测试覆盖决定白名单、断线/unknown 禁用、命令与文件内容转义以及传输失败监听清理。这些测试不向真实任务提交任何审批。

2026-10-13 本机只读检查：真实 Desktop 原生初始化和当前任务 snapshot 成功，没有待审批请求，也未发送真实审批。真实 Windows Desktop 的“允许本次 / 拒绝”、iPhone Safari 到 Relay/Host 的端到端审批仍待验收，不能用模拟测试替代。

启用需要同步更新 Host、Attach 插件和网页构建；安装器已包含新增模块。运行中的旧 detached Attach host 不会热加载源码，需在安全空闲时重启 Desktop 并使插件重新加载。旧插件握手缺少新能力时网页继续提示回 Desktop。Relay 保持现有部署开关，不因本功能自动上线。

2026-10-13 用户授权的个人手机试用已部署网页、Host 与 Attach；只重启了空闲的 detached adapter，Desktop 主体和任务保持运行。线上探针确认审批 capability 可见，真实审批决定仍等待独立测试任务验收。本次属于个人试用，尚未登记为全量客户端更新。

真实验收使用独立测试项目：产生只读命令审批，先在网页拒绝，再对另一条请求允许本次；确认原 Desktop 继续执行且没有第二 writer。另测桌面抢先处理、两标签页同时点、提交后断网、Host 重启和 Desktop 升级。文件审批仅对测试目录中的无价值文件操作。全链路验收前将本能力视为实验功能。

协议参考：[codex-mobile-bridge 固定源码版本](https://github.com/try2love/codex-mobile-bridge/tree/b94dedc40858219d79f58a6c1307acfe3ec8e849/bridge/clients/codex)。本仓库使用 Node 独立实现，仅采用必要的协议格式，没有引入该项目的网关、账号系统或模型执行器。
