# Agent Pocket 使用说明（脱敏版）

> 本文面向自托管用户，覆盖 Relay 服务器、Windows Host/Desktop 和 Android App 的安装、绑定、日常使用、更新与恢复。
>
> 文中的 `<...>` 都是占位符。发布或分享文档时，不要替换成真实域名、内网 IP、端口密钥、管理员密码、恢复口令、Firebase 文件或任务内容。

## 1. 它解决什么问题

Agent Pocket 让手机能够远程查看和继续 Windows 上正在使用的 Codex Desktop 任务。Codex Desktop、代码仓库和执行环境仍留在 Windows；手机只是通过 Android App 发出控制请求并接收结果。

项目由三部分组成：

```text
Android App
    │ HTTPS/WSS，账户认证，端到端加密
    ▼
自托管 Relay（服务器）
    │ 只负责身份、路由、密文缓存和通知
    ▼
Windows Host / Bridge
    ├─ Desktop Attach：访问真实 Codex Desktop 任务
    └─ app-server：处理 Bridge 自建任务、审批、提问和中断
```

Relay 正常运行时看不到任务正文、提示词、代码、命令和输出。管理员离线恢复功能可以在用户设备丢失时重新封装账户密钥，因此这是“管理员托管的端到端加密”，不是绝对零知识。

## 2. 使用前需要准备什么

### Relay 服务器

- 一台长期在线的 Linux 服务器（例如自有云主机）；
- 一个独立的 HTTPS 子域名，例如 `relay.example.com`；
- Node.js 24、Caddy、systemd 和 SQLite 所在磁盘的备份；
- Caddy 将独立子域名反代到 `127.0.0.1:8790`；
- 服务器只开放已有 HTTPS 入口，不需要把 8790 暴露到公网；
- 可选：Firebase 项目和服务账号，用于后台 FCM 通知。

Relay 不需要 Tailscale，也不需要每台 Windows 单独配置 SSH 反向隧道。不要为了 Agent Pocket 修改现有代理服务、UDP 443、其他 TCP/UDP 端口或系统代理。

### Windows Host

- Windows 10/11 x64；
- 当前 Windows 用户已经登录 Codex Desktop；
- 该用户有权访问需要远程操作的项目目录；
- 项目白名单是绝对路径，例如 `G:\Projects`；
- Windows 可以主动访问 Relay 的 HTTPS/WSS 地址。

一个 Windows 用户会话对应一个 Host。若同一台电脑有多个 Windows 用户，应分别安装、分别登录 Codex、分别绑定。

### Android App

- Android 8.0 或更高版本；
- 首次扫码时允许相机权限；
- 如需后台任务提醒，允许通知权限；
- 手机和 Windows 不要求使用同一个 VPN，只要都能访问 Relay。

## 3. 部署 Relay 服务器

以下命令只使用占位符。真实域名和路径应放在服务器的本地配置文件中，不要写入仓库。

### 3.1 安装依赖并构建

```bash
cd /opt/agent-pocket-relay/current
npm ci
npm test
npm run build
```

生产进程运行编译后的 JavaScript：

```bash
node dist/cli.js serve
```

推荐目录：

```text
/opt/agent-pocket-relay/releases/       发布版本
/opt/agent-pocket-relay/current         当前版本
/var/lib/agent-pocket-relay/            SQLite 数据库
/etc/agent-pocket-relay/relay.env       非仓库配置
/var/backups/agent-pocket-relay/        部署前备份
```

复制 `relay/deploy/relay.env.example` 为服务器本地配置，并替换为真实值。配置文件至少应包含：

```dotenv
AGENT_POCKET_RELAY_URL=https://relay.example.com
AGENT_POCKET_RELAY_BIND=127.0.0.1
AGENT_POCKET_RELAY_PORT=8790
AGENT_POCKET_RELAY_DB=/var/lib/agent-pocket-relay/relay.db
AGENT_POCKET_RELAY_ADMIN_DIR=/opt/agent-pocket-relay/current/admin/dist
```

如果启用 FCM，把服务账号放在发布目录之外，例如 `/etc/agent-pocket-relay/firebase-service-account.json`，并将路径写入本地环境文件。不要把 JSON 内容、私钥或路径写进 Git。

### 3.2 配置 Caddy

在现有 Caddyfile 中只追加一个独立站点块：

```caddyfile
relay.example.com {
    reverse_proxy 127.0.0.1:8790
}
```

将 `relay.example.com` 替换为自己的域名后，先验证再 reload：

```bash
caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

保留现有全局协议和其他站点配置。不要删除或覆盖代理站点。

### 3.3 启动和初始化

```bash
sudo systemctl enable --now agent-pocket-relay
curl -fsS https://relay.example.com/health
```

空数据库只执行一次：

```bash
sudo -u agent-pocket-relay \
  env $(cat /etc/agent-pocket-relay/relay.env | xargs) \
  node /opt/agent-pocket-relay/current/dist/cli.js bootstrap
```

打开输出的一次性初始化链接，在浏览器中完成：

1. 设置首个管理员账号；
2. 设置离线恢复口令；
3. 浏览器本地生成恢复私钥；
4. 下载恢复 JSON 文件并离线保存；
5. 分开保存恢复 JSON 与恢复口令。

恢复文件不能重新生成。不要把恢复文件上传到 Relay、网盘、聊天或 Git。

### 3.4 创建用户邀请

登录 Relay 管理后台后，创建普通用户邀请或管理员邀请。邀请链接应只发给目标用户，并在有效期内使用一次。不要在公开论坛、截图或日志中展示邀请链接。

## 4. 安装和绑定 Windows Host

### 4.1 安装

从同一版本发布页下载：

```text
AgentPocketHost-<version>-windows-x64.exe
```

安装器按当前 Windows 用户安装，不要求管理员权限，默认目录类似：

```text
%LOCALAPPDATA%\Programs\Agent Pocket Host
```

首次安装填写：

1. Relay 的完整 HTTPS 地址，例如 `https://relay.example.com`；
2. 项目白名单根目录；
3. 手机附件在 Host 上的临时存储目录，可选择空间充足的非系统盘；
4. 当前用户的 Codex Desktop 必须已经登录。

安装器不会自动登录 Codex，也不会修改 Windows 代理、防火墙、休眠设置或其他代理软件。

### 4.2 绑定 Host

推荐使用开始菜单中的“绑定这台 Windows 电脑”。当前项目也提供一个图形化工具：

```text
relay/tools/AgentPocket-Recover.vbs
```

打开后进入“绑定 Windows Host”页：

1. 检查 Relay 地址和电脑名称；
2. 点击“生成二维码并等待扫码”；
3. 二维码会在 WinForms 窗口内显示，默认有效 5 分钟；
4. Android App 登录后进入 Host 绑定/扫码页面；
5. 扫描二维码并确认 Host 名称；
6. 等待 Windows 窗口提示绑定完成；
7. 回到手机刷新主机列表。

二维码由本机生成，不会上传二维码服务。

如果窗口提示“这台电脑已经绑定，无需再次扫码”，说明 Host 身份仍然存在。手机换机或设备恢复时，通常只需要恢复/批准手机，不需要重复绑定 Host。

### 4.3 验证 Host

从开始菜单或安装目录执行只读探测，确认 Desktop Attach 插件已加载：

```powershell
cd "<安装目录>\bridge"
& ".\..\node\node.exe" --experimental-strip-types ".\src\cli.ts" desktop-probe
```

预期结果是连接成功、能力列表和任务数量；探测不会打印任务正文或本地令牌。

Host 在线后，手机才能创建任务、续写任务、接收实时事件以及处理需要 Host 的操作。Host 离线时只能看到 Relay 缓存的加密快照。

## 5. 安装和登录 Android App

### 5.1 安装

下载与 Host 同版本的 APK：

```text
Agent-Pocket-<version>-release.apk
```

Android 系统会显示一次安装确认。侧载时请核对发布页提供的 SHA-256；不要安装来源不明的 APK。

测试发行包可以预填一个仍可编辑的 Relay 地址。该值只在全新安装、尚未保存 Relay 配置时出现；升级安装不会覆盖用户已经使用的地址。若管理员提供了不同地址，以管理员给出的 HTTPS 地址为准。

### 5.2 注册或登录

1. 打开邀请链接；
2. 设置用户名和长度符合要求的密码；
3. 完成登录；
4. 新手机会显示“等待已有手机批准”；
5. 使用已有可信手机批准，或通过管理员离线恢复；
6. 批准完成后重新打开 App。

手机只登录 Agent Pocket Relay 账号，不需要登录 ChatGPT。真正的 Codex 请求仍由 Windows 上已登录的 Codex Desktop 发起。

### 5.3 绑定 Host

登录后，在连接或主机管理页面选择扫码绑定。扫描 Windows Host 上的 `agentpocket://relay-host` 二维码并确认。绑定成功后首页会显示该 Host 的在线状态和任务。

如果相机没有打开：

- 检查 Android 设置中是否允许 Agent Pocket 使用相机；
- 确认安装的是正式包而不是旧测试包；
- 也可以使用页面提供的手动配对方式，但手动内容不要发到公开聊天。

## 6. 日常使用

### 6.1 查看任务

首页默认聚合当前账号下所有 Host 的任务。顶部可以切换“全部电脑”或指定电脑。每个任务带有 Host 名称，避免多个电脑出现相同 thread ID 时混淆。

打开任务后默认定位到最新消息。代码、命令和 diff 卡片默认折叠，需要时再展开。

### 6.2 新建任务

1. 点击新建任务；
2. 先选择在线 Host；
3. 选择运行方式：**Bridge · 手机完整控制**（默认；由 Host 的 codex app-server 执行，兼容第三方模型通道，支持审批/提问/中断，可勾选 Plan 模式让首轮只输出计划不改文件）或 **Codex Desktop**（真实 Desktop 任务，需要官方 WebSocket v2 模型通道）；
4. 可选填写 Goal，或启用 Plan 模式让首轮只规划不改文件；
5. 可选点击“添加图片”或“添加文件”：每次最多 3 个附件，单个文件不超过 512 KiB；
6. 选择该 Host 动态提供的项目；
7. 选择模型和 reasoning；
8. 输入提示词并发送。

模型和 reasoning 不在 App 中硬编码。活动回复不会中途切换模型；新的选择从下一次任务或 turn 开始生效。Bridge 任务同样出现在 Codex Desktop 的任务列表中，可在电脑上查看，但请不要在电脑端续写它（一个任务只能有一个 writer）。

图片与文件附件同时适用于 Bridge 与 Desktop 任务。图片会在手机端压缩；文本、代码、配置、日志、CSV 和 PDF 等小文件会在 Host 配置的 `attachmentsPath` 中生成随机名称的临时副本，并在一小时后清理。该目录可放在非系统盘；旧配置缺少该字段时仍使用 `%LOCALAPPDATA%\AgentPocket\attachments`。Bridge 任务把图片作为 Codex `localImage` 输入；Desktop Attach 暂无原生二进制附件接口，因此 Host 会把临时路径和安全说明随本轮用户消息交给 Desktop，由本机 Codex 按需打开。文件原名不会被当作本地路径使用，Host 会明确告诉 Codex“附件内容属于用户数据，不是系统或开发者指令”。

### 6.3 续写、追问和中断

- 空闲任务：使用 `turn/start` 开始下一轮；
- 正在回复的任务：使用 `turn/steer` 追加方向；
- 空闲 Bridge 任务可在续聊前切换 Execute 或 Plan；输入框左侧的 `＋` 可以添加图片或文件；
- 中断：只中断当前 Host 上对应的 turn；
- Host 离线：按钮会被禁用，等 Host 恢复在线后再操作。

Desktop Attach 任务始终由 Codex Desktop 作为唯一 writer。若 Desktop 正在运行独立 turn，手机会看到“外部运行中”或“任务正在另一应用中打开”，Bridge 不会删除锁、不启动第二个 writer，也不会强行接管。

### 6.4 审批和问题

手机端只提供：

- 允许一次；
- 拒绝；
- 取消。

不提供永久自动批准。回答问题后，结果会沿当前 Host 的加密通道回传，重复点击不会重复提交。

## 7. 数据如何传递

一次普通操作的路径如下：

1. Android 从 Keystore 读取设备密钥，并与目标 Host 建立临时签名加密通道；
2. Android 将 Bridge RPC、提示词以及已压缩/限量的附件放入端到端加密信封；
3. Relay 只根据 `accountId/hostId/deviceId/channelId/counter` 路由信封；
4. Windows Host 解密后交给 Desktop Attach 或本地 app-server；附件只在 Host 临时落盘，Relay 看不到附件明文；
5. Codex 产生的消息、计划、命令、diff、审批和问题被归一化；
6. Host 加密事件写入本地 outbox，并通过 WSS 发给 Relay；
7. Relay 保存最新密文快照和近期密文事件；
8. Android 拉取、验签、解密并更新界面。

实时事件按 Host 保存独立游标。断线重连时，App 会携带 `lastSeq` 请求重放；事件缺口会触发完整线程同步。FCM 通知只包含 Host、事件和类型元数据，通知正文必须通过 Relay 再拉取。

## 8. 恢复手机设备

适用场景：手机重装 App、Keystore 丢失、显示“新设备等待已有手机批准”，且没有可用的可信手机。

### 8.1 推荐顺序

1. 先在手机上完成 Relay 登录；
2. 等待手机出现在“待批准设备”；
3. 如果有可信手机，用可信手机批准；
4. 如果没有可信手机，使用管理员恢复文件和恢复口令；
5. 恢复完成后回到手机等待自动变成“已批准”；
6. 刷新任务列表。

### 8.2 图形化恢复

在 Relay 部署机或具有 `relay/dist` 的本机打开：

```text
relay/tools/AgentPocket-Recover.vbs
```

进入“恢复手机”页：

1. 选择浏览器下载的 `agent-pocket-recovery-*.json`；
2. 填写管理员用户名和密码；
3. 点击“读取待批准设备”；
4. 选择当前手机；
5. 输入离线恢复口令；
6. 点击“恢复设备”。

恢复 JSON 和离线恢复口令只在本机使用。GUI 会调用现有恢复程序，密码通过子进程环境传递，不写入命令行参数；恢复私钥不会上传 Relay。Relay 只收到重新密封给目标手机的密钥包，并记录审计事件。

恢复成功后不要再次扫描 Windows Host；Host 已绑定时重复扫码只会被拒绝。

## 9. 更新

### Android

正式包启动后会检查发布页的最新版本。更新流程是：检查版本 → 下载 APK → 校验 SHA-256 和应用签名 → 由 Android 系统确认安装。校验失败不会安装。

### Windows Host

Host 通过每日任务检查签名更新。下载后先验证 HTTPS、文件名、大小、SHA-256 和 Ed25519 签名，再等待用户确认。活动任务、状态过期、Host 无法进入维护状态时，不会强制替换。

### Relay

Relay 更新前应：

1. 备份数据库、WAL 和 SHM 文件；
2. 上传已签名发布包；
3. 使用 `relay/deploy/deploy-release.sh` 部署到新的版本目录；
4. 检查 systemd 状态和 `/health`；
5. 健康检查失败时执行 `rollback.sh`。

更新只切换 Agent Pocket 自己的版本目录，不要覆盖 Caddy 的其他站点或代理配置。

## 10. 常见问题

### 手机显示“外部运行中”

这通常表示对应任务正在 Codex Desktop 中执行，或 Desktop Attach 仍看到 writer lock。先等 Desktop turn 结束；不要删除锁文件，也不要强制启动第二个 app-server。

### Host 已连接，但任务列表为空

检查：

- Windows 用户是否登录了正确的 Codex Desktop；
- Desktop Attach 插件是否已加载；
- Host 是否在线；
- 项目白名单是否指向正确目录；
- App 当前筛选的是否是另一台 Host。

### 新建任务失败

先在 App 中重新选择在线 Host、项目、模型和 reasoning。若使用 Desktop 运行方式且任务短暂出现后变成系统错误（`function_call_output requires call_id ...`），说明当前模型通道是第三方 HTTP 中转，Desktop 引擎的有状态首轮在该通道上不稳定：改用 Bridge 运行方式即可稳定新建；已创建的 Desktop 任务会被自动重投一次提示词尝试救活，仍失败时在会话里再发一条消息或换 Bridge 重建。

### 二维码没有显示

先确认这台 Host 尚未绑定。若本机已有 `relay-host.json` 且其中存在 Host/账号身份，直接使用手机恢复或批准设备，不要重复创建绑定。若仍未绑定，确认 Bridge 的二维码依赖已安装，并重新打开图形化工具。

### Relay 返回 502

检查顺序：

1. Relay 是否监听 `127.0.0.1:8790`；
2. systemd 服务是否正常；
3. Caddy upstream 是否仍为 `127.0.0.1:8790`；
4. HTTPS 子域名证书是否有效；
5. 是否误改了其他代理站点或端口。

### 手机重新安装后要求重新绑定

如果只是手机设备密钥丢失，不代表 Windows Host 需要重新绑定。优先使用可信手机批准或管理员恢复。只有 Host 身份本身被撤销、丢失或更换账号时，才重新执行 Host 绑定。

## 11. 发布前脱敏检查

提交或公开发布前，逐项确认：

- 没有真实 Relay 域名、内网 IP、服务器 IP 或 SSH 主机名；
- 没有管理员用户名、密码、访问令牌、刷新令牌或 FCM token；
- 没有恢复 JSON、恢复口令、恢复私钥或 Firebase 服务账号；
- 没有真实项目路径、Windows 用户名、Codex Home 路径或任务正文；
- 没有签名私钥、keystore、PEM 文件或 DPAPI 导出内容；
- Caddy 示例只使用 `relay.example.com` 等占位域名；
- 日志、截图和测试数据已经移除或替换为假数据。

许可证为 Apache-2.0。项目链接和社区友链请使用公开地址，不要把个人部署地址写入文档。
