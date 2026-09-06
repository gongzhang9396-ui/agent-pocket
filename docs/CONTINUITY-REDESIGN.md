# Agent Pocket 会话接续改造记录

核对日期：2026-09-05。源码基线：`fd7e752` / `0.3.2`。

本文记录 Codex 接续的原始问题、隔离验证及实现。第 2 节描述原始基线，第 3—5 节保留长期方向；第 6 节描述已实现的改造。后续发现、分页与环境健康契约见 [Host 基础契约](HOST-FOUNDATION.md)，独立 Agent 的接入见 [Grok CLI](GROK-CLI.md)。新增功能尚未发布到稳定版，不代表已发布的 0.3.2 安装包已具备这些能力。

## 1. 产品目标

用户在手机上创建任务，回到原生 Codex Desktop 继续，再回手机继续；始终是同一个会话、同一份历史，模型来源和推理设置不会意外改变。执行中的回复、提问和审批也应在两端保持一致。

支持对象包括 Codex 官方通道，以及用户已配置的兼容第三方 API 通道。手机只登录 Agent Pocket；模型账号和 API 凭据属于电脑上的运行环境。接入第三方模型与接入独立的 Kimi Code/Grok agent 是不同工作，后者需要独立适配器。

普通用户共用管理员的 Relay，目标流程仍是“安装 → 扫码 → 登录 → 使用”。自行托管 Relay 的管理员另有部署流程。

## 2. 根因：一轮结束不会自动释放会话

代码里有两个不同层次的约束：

| 层次 | 改造前的实现 | 对接续的影响 |
| --- | --- | --- |
| 持久路由 | `bridge/src/store.ts` 的 `thread_owners`、`claimThreadOwner` | 首次归属长期保留，没有交接状态机 |
| 实际 writer | `bridge/src/codex.ts` 长期持有一个独立 app-server 子进程 | 任务空闲后仍可能保留 writer，另一个进程无法 resume |

`bridge/src/server.ts` 的 `turn/completed` 分支只清除 `activeTurns`、更新运行状态和发布事件，没有释放 app-server 中的会话。`startTurn` 按持久 owner 分流；Desktop 列表发现同一个 thread，也不会改变原有 Bridge 路由。

因此要继续保留“同一时刻一个 writer”的约束，同时重新设计会话归属与生命周期。不能把“归属永久不变”当成无缝接续的最终方案。

### 本机隔离实验

使用真实 `codex-cli 0.153.1`，临时 `CODEX_HOME`、空白工作目录、环境变量白名单及本机 HTTP Responses 固定响应。没有使用真实账号、真实模型、Desktop 会话或现有 Host 数据。

复现命令（仓库根目录，需 Node.js 24 和可执行的 Codex CLI）：

```powershell
node bridge/scripts/probe-thread-sharing.mjs
# CLI 不在 PATH 时，第二个参数可指定 codex.exe 的完整路径。
```

| 实验 | 本次观察 |
| --- | --- |
| A 创建会话并完成第一轮，B 只读历史 | 成功；B 看到 `notLoaded`，这不代表不存在外部 writer |
| 第一轮完成后，B resume | `already has an active writer` |
| A 调用 `thread/unsubscribe` | 返回 `unsubscribed` |
| 立即检查 A 的 loaded threads | 会话仍在其中 |
| 此时 B 再 resume | 仍然是 writer 冲突 |
| A 关闭 stdin，正常退出后，B resume 并执行第二轮 | 成功；会话 ID、模型、provider 保留，历史包含两轮 |

脚本输出 `firstExit.graceful`，若必须强制清理测试进程，不视为验证了正常交接。`results` 内的 `ok:false` 表示该步被上游拒绝，writer 冲突在这个实验中是预期观察。脚本在续聊失败、历史轮数不符或准备失败时返回非零；它是兼容性探针，不是所有上游行为的完整验收套件。临时目录仅包含合成数据，运行结束保留供本机检查。

官方文档也说明取消最后一个订阅后存在无订阅且无活动的 30 分钟保留期。这不是可以立即交接的确认信号。[App-server 会话生命周期](https://learn.chatgpt.com/docs/app-server#unsubscribe-from-a-loaded-thread)

**这次验证的是两个受控 CLI 进程之间的交接机制，还没有验证原生 Desktop 的双向接续。**

## 3. 改造方向与尚缺的证据

### 首选方向：两个界面连接同一个执行器

手机与电脑应向同一个会话执行器发送命令、订阅事件，所有会话写入由该执行器处理。这样不需要在每次换设备时反复移交 writer。

公开 app-server 提供多种连接方式；CLI 的 `--remote` 可以连接远程执行器。但 WebSocket 传输仍被标为实验性，且通用 CLI 接口不能直接证明原生 Desktop 支持相同接入方式。[App-server 连接方式](https://learn.chatgpt.com/docs/app-server#connect-the-cli-terminal-ui)

本机 Desktop `26.901.4073.0` 的定向静态检查找到了 SSH 远程环境的 `connectToRemoteAppServer`、`app-server proxy` 和 Unix 控制 socket 路径；没有确认可供 Agent Pocket 复用 Desktop 本地执行器的公开入口。`codex app-server daemon version` 在 Windows 返回仅支持 Unix 平台。

下一步技术验证必须回答：

1. 当前 Windows Desktop 能否通过受支持的连接方式与 Host 共用一个执行器？
2. 多客户端连接时，Desktop 发起的 turn 能否实时被 Host 订阅，手机发起的 turn 能否实时显示在 Desktop？
3. 审批与问题的应答由谁接收，如何保证只处理一次？
4. 官方通道、兼容第三方 Responses API、不同 provider 的旧会话分别能否往返接续？

仅把 CLI 的传输从 stdio 改成 WebSocket，不能宣布完成这项改造。验收对象必须包括原生 Desktop。

### 过渡方案：显式、安全地交接会话

如果原生 Desktop 暂不能共用执行器，可以先验证按需交接：

1. 冻结这个会话的新写请求，确认当前轮次、待审批、待回答问题、持久 Goal、子任务及后台命令状态；
2. 确认历史和 Agent Pocket 待上传事件已经保存；
3. 让持有会话的执行器正常释放，并取得确定的关闭证据；
4. 目标执行器通过上游原生 resume 获取 writer；
5. 成功后再更新路由、订阅与客户端状态；失败时保留可恢复状态，不向两端重复发送提示词。

原始实现由一个 app-server 管理多个 Bridge 任务，不能退出整个进程来释放其中一个任务。本轮已实现受控的分任务执行进程（第 6 节）。这增加进程与内存成本，也仍需验证原生 Desktop 的完整往返体验。

建议把 `createdBy`、当前 `executionBackend`、`writerState`、`modelProvider`、`model`、`reasoningEffort`、能力集合分开表达；来源信息不再承担全部控制权语义。交接状态至少区分就绪、运行、交接中、外部持有、状态未知。默认保持现有安全路由，待真实往返验收通过后再迁移旧任务。

### 模型能力以实际运行环境为准

provider 表示连接方式及来源；model 表示该来源下的模型。只靠模型名称无法判断能否执行 Desktop 创建、Plan、图片或某种工具。

Host 应提供脱敏的有效模型设置与能力，不下发 API 密钥或私有 endpoint。选择模型、恢复旧会话、切换 provider 和进程重启分别验证；不自动把会话切到另一来源。

Codex 的自定义 provider 是已有配置能力，不能将“第三方”整体等同于“不支持”。过去 Desktop bootstrap 在某些 HTTP 通道失败的记录，要按版本和协议能力重新验证。[自定义模型提供方](https://learn.chatgpt.com/docs/config-file/config-advanced#custom-model-providers)

## 4. 安装与部署要收敛的地方

先完成共同 Relay 用户的安装闭环：

- 一个 Host 入口包含状态、配对、配置和修复。错误直接指出 Codex、Relay、目录权限或绑定数据中的哪一步失败。
- 安装时识别可用的 Codex CLI、有效 provider 配置和 Desktop 状态；区分“可运行 API 任务”与“可接续原生 Desktop”，避免用一句“先登录 Desktop”笼统挡住用户。
- 已有配置时同时检查身份完整性、计划任务路径和插件版本。修复保留身份与用户配置，写入前自动备份，失败可恢复。
- 白名单由用户选择项目确认，目录和版本尽量自动发现。已绑定用户可修改普通配置，切换账号/Relay 作为独立操作处理。
- 统一安装完成自检，区分“程序已装好”“手机已配对”“会话可读写”，不能只因为存在配置文件就显示成功。

自托管管理员再增加独立部署预检：环境、版本、签名公钥、备份位置、反代连通性一次检查，产物路径统一。现有签名、备份、账号隔离和更新回滚机制保留；这一轮未修改或重新部署 Relay。

## 5. 分阶段验收

| 阶段 | 交付与通过条件 |
| --- | --- |
| 已完成：接手基线 | 实际复现空闲 writer 冲突；修复恢复模型设置的字段错误；更新使用说明 |
| 第一阶段：原生接续验证 | 手机发起 → 原生 Desktop 继续 → 手机继续，同一 ID、完整历史；官方和第三方 API 各走一遍 |
| 第二阶段：控制与恢复 | 运行中 steer/中断、审批/问题、断线重放、Host/Desktop 重启、重复发送、交接失败均不丢失或重复执行 |
| 第三阶段：安装闭环 | 干净 Windows 用户和 Android 安装 → 扫码登录 → API 任务 → 双端接续 → 升级 → 保留身份重装 |

第一阶段未通过前，不发布“像 Remote 一样无缝接续”的承诺。原生 Desktop 的稳定共享入口仍是技术未知项；按用户后续要求，本轮同时改善 Android 界面、刷新和流式显示。

## 6. 本轮实际实现（未发布）

### 按任务释放 writer

`bridge/src/codex-pool.ts` 将 catalog 读取与任务执行分开：每个 Bridge 根任务拥有一个独立 app-server，子任务留在所属执行器内。默认最多 8 个任务执行器，加上一个 catalog 进程；达到上限时只回收可以确定空闲的执行器，否则返回忙碌。平时保留空闲执行器，以免手机每轮续聊都承担启动成本。

手机任务菜单新增“在电脑继续”。Host 先确认 Desktop Attach 能读取同一任务和允许的工作目录，然后阻止该任务的新写请求，检查当前轮次、Goal、待答请求、子任务、后台终端、队列和执行器状态；全部空闲才关闭这个执行器的 stdin，并等待正常退出。只有收到正常退出证据后才将手机续聊路由切到 Desktop。退出超时、状态未知或操作结果不确定时，不强制杀进程、不宣布交接成功。其他任务的执行器继续工作。

这一步释放的是 Host writer，**没有自动在 Desktop 中发起新一轮，也没有证明 Desktop 已成功 resume**。Desktop Attach 之后负责手机追加消息；审批、问题和中断目前仍在电脑处理。没有实现 Desktop writer 转回 Bridge writer，更没有让两端共享同一个执行器。

并发保护还覆盖创建任务到首轮之间的空档；不同执行器的审批 ID 会被隔离。目标设置超时后保留已创建任务并提示检查状态，不继续自动发起首轮。启动失败会归还执行器名额。

真实 CLI 的生产池验证：

```powershell
node --experimental-strip-types bridge/scripts/probe-thread-sharing.mjs --pool
```

使用临时 CODEX_HOME 和 loopback 自定义 Responses provider：释放第一个任务后，另一 CLI 保留同一 ID、模型和 provider 完成第二轮；第二个任务不受影响并完成第二轮。两份历史各有两轮，共 4 次合成模型请求，原执行器正常退出。

### 刷新与流式显示

- Android 打开或刷新任务只读最新一页；更早内容按需加载，刷新保留已显示的消息及阅读位置。
- 旧页重叠时用服务端历史校正状态，同时保留读取期间新收到的消息、审批与状态；刷新期间再次到达的同步请求会排队再读一次。
- Host 首段消息立即发布，后续片段以 100ms 小批次合并；完成、审批等事件前先刷新文本缓冲。减少逐字持久化、加密和中继确认的次数。
- Desktop watcher 通过 Attach 等待更新，只在状态转换、缺口或终态时校正历史，不再周期性全量读取；这不等于原生逐 token 推送，也不是端到端延迟承诺。
- 续聊恢复设置优先使用 `ThreadResumeResponse` 顶层有效模型和推理档位，避免意外丢失第三方模型设置。

### Android 界面

默认改为暖白背景、白色卡片和青绿色强调；列表突出标题和状态，减少重复路径与提示。刷新指示留在固定位置，任务操作收进菜单。滚动跟随实际排版高度，用户向上翻阅时暂停跟随；底部按钮可回到最新消息。

调试包提供 `UiPreviewActivity`，只使用内存假数据，可以检查列表、对话、持续 Markdown 回复、延迟刷新及加载旧页。这个入口不会编入 release。

### 验证边界

集成 Grok 后，Bridge 回归为 130/130、Android 单元测试为 42/42，debug 与 release 构建通过；Windows 隔离检查为 12/12。Bridge 在 `bridge` 目录运行 `npm test`，Windows 检查入口为 `installer/windows/test-runtime.ps1`。截图、日志和本机验收记录保留在忽略目录。Relay 没有源码变更，接手基线的 27 项测试通过。

仍需完成原生 Desktop 与真实第三方 API 的完整往返、系统性的实网断线恢复、全新安装/升级/回滚验收，以及安装修复界面。API-only 的独立任务发现和项目/模型读取已实现，详见 Host 基础契约。现有设备升级及部分真机续聊已验证，但不能代替上述完整验收。
