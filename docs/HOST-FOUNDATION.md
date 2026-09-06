# Host 基础契约改造

本文记录 2026-09-05 至 2026-09-06 的 Host 契约改造，承接显式交接与 Android 界面改造。以下契约已在开发代码中实现，验收结果与边界见文末；尚未发布到稳定版。

## 不变的事实

以下正文描述 Codex 接入。2026-09-06 工作树另加入独立 [Grok CLI 适配器](GROK-CLI.md)，复用任务展示协议，但使用自己的原生会话和持久历史视图；不会把 Grok ID 路由到 Codex。

任务身份是 `(hostId, threadId)`，历史属于 Codex 的原生存储。读取这份历史不应依赖哪个界面开着，也不应顺手取得写入权。手机和 Desktop 是入口；Bridge app-server 与 Desktop task host 才是执行器。模型提供方决定模型请求的去向，与哪一个界面展示任务无关。

因此分开四件事：

- **发现与历史**：由 Host 的 Codex catalog 读取，跨 provider，并做项目白名单校验；Desktop Attach 只作为旧协议/其他 Desktop 存储的读取兼容路径。
- **运行状态**：空闲、运行、待确认、完成等，来自任务和 turn 的状态，不再拿“Desktop 所属”代替运行状态。
- **执行路由与能力**：`execution.backend` 指定写请求将交给谁，`execution.owner` 表示已确认归属，`execution.capabilities` 指明具体操作。未确认归属的旧任务保留 Desktop 写入验证路径；读取不会持久化归属。
- **环境健康**：本机执行连接、模型目录和 Desktop Attach 各自报告状态，一个元数据查询失败不使其他能力失效。接口连接就绪也不等于真实模型调用已通过。

写入仍由唯一执行器承担。已确认 Desktop 的任务不回退给 app-server；显式 handoff 仍需要空闲检查与正常退出证据。当前原生 Desktop 是否支持与 Host 共用同一执行器，仍没有可用的已验证入口。

## 本轮接口与调度

`thread/list` 优先本机 catalog，显式查询全部模型提供方及顶层任务来源。`thread/read` 使用只读元数据和 `thread/turns/list` 返回最新一页；不再把 Bridge 任务的整份历史伪装成“一页”。游标绑定读取后端和任务，旧 CLI 仅在明确不支持分页方法时退回完整读取。

列表和详情增加 `execution`，保留旧 `source/capabilities` 作为兼容字段。`model/list` 将有效配置中的模型作为默认项，即使它不在上游推荐目录中；不下发 provider endpoint、密钥、原始配置或配置来源。`host/runtime` 分别报告本机执行器与 Desktop。

Android 当前对话恢复先于项目/模型目录；同一 Host 的只读元数据独立完成、独立报错。其他 Host 可并发恢复，限制并发数。事件更新负责正在显示的消息，历史读取承担首次显示、缺口修复和终态校正，避免每次文本更新都重新读历史。

项目目录由 Host 白名单独立提供，普通文件夹也可作为工作目录。子项目扫描使用异步文件读取，限制深度 3、最多遍历 2,000 个目录，避免同步磁盘遍历阻塞文本事件。任务列表游标绑定 catalog 和搜索条件；Desktop 兼容列表不冒充支持后续分页。

请求超时与通道断开分开处理：单个 RPC 超时不会清空其他请求使用的加密通道；Host 明确离线时才废弃该连接并完成待答请求。握手按 Host 串行，旧 channel 的迟到响应不会交给新 channel 解密。

## Windows 安装

安装器增加可选 Desktop 集成，选择保存在 `desktopIntegrationEnabled`。API-only 用户可取消勾选；可选插件安装失败仅记录状态，不阻断 Host 配置与启动。原生 CLI 解析统一供配置、启动和插件安装使用，支持独立 EXE、npm Windows shim 对应的原生程序，以及 Desktop 版本目录更新后的 CLI。

npm 布局依据 [Codex 官方启动器源码](https://github.com/openai/codex/blob/main/codex-cli/bin/codex.js)，同时兼容 `vendor/<target>/bin` 与旧版 `vendor/<target>/codex`。解析器不执行 shim，也不读取模型凭据。打包 allowlist 加入 `codex-pool.ts` 与 `task-catalog.ts`，回归测试校验全部本地运行时 import 均被收录。

## 验收条件

1. 关闭/缺少 Desktop Attach 时，纯 API 环境仍能列出、读取、创建和继续 Host 任务；跨 provider 旧任务可发现。
2. 列表和读取前后 owner 不变；只读分页不加载第二 writer，已有 writer 仍保持独占。
3. 长任务先显示最近一页；模型/项目查询失败或延迟不阻塞当前对话恢复。
4. Desktop 任务同时显示真实运行状态和执行后端；按钮由能力决定。
5. 有效自定义模型出现在默认选择中；原始配置和凭据不进入手机响应。
6. 执行连接初始化不查询无关目录；上游接口不支持、错误和超时各有可验证行为。

协议依据为本机 CLI 0.153.1 生成的 TypeScript schema，以及 [官方 app-server 文档](https://learn.chatgpt.com/docs/app-server)。`thread/read` 与 `thread/turns/list` 是不恢复 writer 的读取接口；通用 WebSocket 接口不能作为原生 Desktop 已支持共享执行器的证据。

## 验证证据与未完成项

- 基础契约阶段的 Bridge 回归 **100/100**，Android 单元测试 **39/39**、`assembleDebug` 成功，Windows 隔离检查 **12/12**。后续集成 Grok 后为 Bridge **130/130**、Android **42/42**，见 [Grok 验证](GROK-CLI.md#验证)。Relay 没有源码改动。
- `bridge/scripts/probe-thread-sharing.mjs --pool`：真实 CLI 0.153.1、生产池及 BridgeServer、全新 CODEX_HOME、无账户、loopback 模型，共 6 次合成请求。当前 provider 为 `probe`，旧任务来自 `other`，均能列出。API-only 路径经 Server 新建并续写两轮；原生分页成功；读取外部 writer 的任务不改变 owner 或独占锁；正常释放后同 ID/模型/provider 接续，另一任务不受影响。
- Android 调试包在独立 AVD 上检查自定义模型、无 reasoning 选项的新建表单：填写提示词后创建按钮从禁用变为启用。只用假数据，没有连接真实账号。暖白/青绿界面保持，截图在忽略目录 `output/runtime-foundation/api-model.png`。
- Windows PowerShell 5.1 的 12 项隔离测试覆盖 EXE、失效旧路径、6 种 npm 布局、Desktop CLI、拒绝裸 shim、插件缺失与显式关闭集成。Inno Setup 6.7.3 用假 payload 编译安装器结构成功；这不等于完整安装包或真实安装升级验收。
- 独立复核后补强了列表游标、握手串行和迟到响应处理。“Desktop owner 的历史必须只能经 Desktop 读取”未采纳：这正是本轮拆开的错误耦合；只读路径不决定写入归属。缺失新版 capabilities 仍按禁用处理，已发布旧 Host 使用 legacy 兼容分支。

原生 Desktop → Bridge 回迁、两端共用执行器、第三方真实模型与真实手机网络的端到端延迟、完整安装/升级/回滚尚未验收。未登记 owner 的旧任务保留 Desktop 写入验证路径，不能自动认领为 Bridge writer。当前仍是 Codex 兼容 API 接入，不是任意 Agent/模型协议的通用适配器。

Bridge/Android/Windows/探针日志与 UI 截图保存在忽略目录。Inno 的 `Installer-Structure-Test-Only.exe` 仅是假 payload 语法产物，不能作为安装包使用。

## 升级验证

现有 Windows Host 与 Android 真机的覆盖升级已验证：维护握手确认零活动任务后停止准确的 Host，备份停止后的状态，再部署并校验运行文件；重启后保留原身份与配置。Android 复用已有签名，以 `adb install -r` 覆盖正式包，保留登录与设备身份。独立 `.debug` 包不继承正式应用的设备身份，不能作为无需登录的升级路径。

Codex CLI 0.153.4 的生产池隔离探针也已通过，覆盖 API-only 两轮、跨 provider 发现、分页、外部 writer 保留和显式释放后的接续。签名 Android 构建与 R8/native binding 检查通过。这些结果不等同于全新安装、所有版本回滚或原生 Desktop 的完整往返验收。

## 大历史导致 Host 离线

打开长对话后，真机出现“连接暂时中断，正在自动恢复任务内容”，Host 的 Relay 连接反复断开。只读测量该任务的原生最新 10 轮：JSON 为 3,905,722 字节，加密后的 Base64 预计 5,207,716 字符，超过 Relay 约 2 MiB 的帧限制。按轮数分页不足以限制真实传输大小。

`TaskCatalog.read` 已增加 768 KiB 的 UTF-8 JSON 页预算。一轮内也可分页，游标记录原生页位置及稳定的 turn/item 边界；新消息或新轮次插入后不会按变化后的数字偏移继续。旧 CLI 的完整历史兼容路径同样分页。超出单页的单条记录会返回明确的大小错误，不静默裁掉正文；进一步拆分单条超大记录尚未实现。

Relay Connector 在加密前限制单个 RPC 响应，过大时改为小错误，避免推进了密钥流状态却丢弃数据；外层发送也按字节检查，超限不发送、不留下 pending 请求。根因修复只更新了 Host，已安装手机直接兼容。未扩大 Relay 的消息上限。

Bridge 104/104 回归通过，覆盖中文数据大小、原生/旧 CLI 分页、并发新增 item/turn、单条超大记录、小错误后通道继续可用及外层大小保护。真机上原对话自动恢复，点击“加载更早的消息”成功；加载前后同一可见消息 bounds 完全相同，未再出现断线提示，Host 连接日志在后续检查期间未新增断线。另通过现有 Desktop Attach 只读探针恢复本地 IPC，Bridge 探针确认连接且可写；没有发送模型消息作为此次验证。

Relay 端 WebSocket 缺少连接级 error 监听也是独立风险，尚未在服务器部署加固；当前 Host 的发送预算已避免本次超大历史触发该路径。
