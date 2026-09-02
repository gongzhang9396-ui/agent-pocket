# Agent Pocket

Agent Pocket 是一个 Android 远程 Codex 控制台。Codex Desktop、源码和执行环境留在自己的 Windows 电脑；手机通过自托管 Relay 查看并继续真实 Desktop 任务，不占用 Android 的 VPN 槽位，也不要求手机登录 ChatGPT。

当前 v2 是邀请制、多用户、多主机架构，适合个人、家庭或小团队自托管。项目仍处于实验阶段：Desktop Attach 依赖 Codex Desktop 的内部本地能力，Desktop 更新后可能需要适配。

完整的部署、绑定、日常使用、恢复、更新和脱敏说明见 [使用说明](docs/USAGE.md)。

## 直接安装

在 [GitHub Releases](https://github.com/gongzhang9396-ui/agent-pocket/releases/latest) 下载两个文件（Android 与 Host 版本号可能不同，Android 迭代更快，均以 latest 页面为准）：

- `Agent-Pocket-<版本>-release.apk`：安装到 Android 手机；
- `AgentPocketHost-<版本>-windows-x64.exe`：安装到每台需要远程控制的 Windows 电脑。

Relay 管理员先在后台创建用户邀请。用户通过邀请在 Android 登录后，在 Windows 安装器中填写 Relay 地址和项目白名单，再从开始菜单打开“绑定这台 Windows 电脑”，用 Android 扫描二维码即可。安装器不要求管理员权限；当前未购买 Authenticode 证书，Windows 首次安装可能显示 SmartScreen 提示，请同时核对 Release 中的 SHA-256 文件。

## 能力

- 一个 Relay 账号可绑定多台 Windows Host 和多部 Android 手机。
- 首页聚合全部电脑的 Codex 任务，也可按电脑筛选在线状态和任务。
- 读取历史、创建任务、续写原任务、实时同步回复（Markdown 渲染）和查看原生 diff；收件箱按项目分组并支持未读角标。
- 新建任务默认走 Bridge 模式（Host 的 codex app-server 执行）：兼容 cc-switch 等第三方模型通道，支持从手机审批、回答提问、中断，可选原生 Plan 模式（先规划不动文件）、持久任务目标，以及端到端加密的图片/小文件附件；任务同样出现在 Codex Desktop 列表中。也可选择创建真实 Desktop 任务（需要官方模型通道），并通过 Host 临时文件路径附加图片或小文件。
- 首页显示 Host 与 Codex Desktop 的真实运行状态；Desktop 未启动时可从手机请求 Windows Host 唤起固定的 Codex Desktop 应用。
- 新手机需要可信手机批准；Host 使用五分钟二维码绑定。
- 任务正文、提示词、代码和命令使用端到端加密，Relay 只保存路由元数据和密文。
- Android 和 Windows Host 都支持签名更新；Host 有活动任务时不会强制替换。

Desktop 原生任务的硬中断、原生审批响应和结构化问题回答目前没有稳定插件接口。Agent Pocket 不会启动第二个 writer、删除锁或模拟坐标点击来强抢任务。

Android v0.3 的界面方向和附件交互见 [视觉原型](docs/prototypes/agent-pocket-v03-overview.png)。Codex 已接入；Grok 与 Kimi Code 目前只展示能力边界，不会伪装成可用状态。

## 架构

当前实现的组件职责、加密边界、Desktop/Bridge 两条任务路径和完整消息时序，见 [v0.2.9 架构与信息流](docs/ARCHITECTURE-v0.2.9.md)。

```text
Android App (用户/设备密钥)
        │  HTTPS + WSS / Relay protocol v2
        │  X25519 signed channel + XChaCha20-Poly1305 secretstream
        ▼
Self-hosted Relay / Caddy / TCP 443
        │  只见 accountId/hostId/deviceId/channelId/counter/kind + 密文
        │  SQLite WAL：账户、设备、Host、密文快照、近期密文事件、审计
        ▼
Windows Host Connector (主动 WSS 出站)
        │
        ├─ Desktop Attach plugin → 真实 Codex Desktop 任务
        └─ codex app-server --stdio → Bridge 自建任务
```

Relay 只监听 `127.0.0.1:8790`，由独立子域名的 Caddy 站点暴露。Windows Host 主动连接 Relay，不需要 SSH 反向隧道、Windows 入站端口或公网防火墙规则。

## 加密与身份

- 用户名不区分大小写；密码使用独立 salt 的 scrypt 摘要。
- 访问令牌 15 分钟、刷新令牌 30 天；数据库只保存令牌哈希，设备、Host 和刷新令牌可独立撤销。
- 账户拥有 Ed25519 签名身份和 X25519 加密身份；每台设备和 Host 另有独立密钥。
- 手机与 Host 通过双方签名的临时 X25519 通道通信；外层信封作为 AEAD associated data，严格 counter 拒绝重放和乱序注入。
- Windows Host 私钥、Host token 和内容密钥使用当前 Windows 用户的 DPAPI 加密落盘；通道握手 ID 会持久化以阻止 Relay 在有效期内跨重启重放。
- Host 事件与快照使用持久 outbox；确认丢失时重发完全相同的密文，Relay 只对完全相同的重复信封返回幂等成功。
- Relay 最多保留每台 Host 最近 24 小时或 20,000 条密文事件和最新密文任务快照；完整历史和所有写操作仍要求 Host 在线。
- FCM 只包含 `hostId/eventId/type`，通知打开后再从 Relay 拉取并解密内容。

这是“管理员托管的端到端加密”，不是绝对零知识。首次管理员初始化时，浏览器生成离线恢复私钥；Relay 只保存恢复公钥和密封数据。持有恢复私钥及口令的管理员可以显式恢复设备，并最终获得读取该用户数据的能力。每次恢复都会写入审计记录。

## 组件与技术

| 组件 | 技术 |
|---|---|
| Android | Kotlin、Jetpack Compose Material 3、OkHttp、kotlinx.serialization、CameraX/ML Kit、Firebase Messaging、libsodium |
| Windows Host | Node.js 24、TypeScript、`ws`、Node 内置 SQLite、libsodium、PowerShell、Task Scheduler、Inno Setup |
| Desktop Attach | Codex 插件、Windows named pipe、随机本地令牌、Codex Desktop 任务工具 |
| Relay | Node.js 24、TypeScript、`ws`、Node 内置 SQLite WAL、firebase-admin、libsodium |
| 管理后台 | React、TypeScript、Vite、Lucide；HttpOnly/Secure/SameSite=Strict Cookie 与 CSRF |

Android 要求 Android 8.0 或更高版本，`minSdk 26`、`compileSdk/targetSdk 36`。Windows Host 是每 Windows 用户安装；同一电脑的不同 Windows 用户会显示为不同 Host。

## 快速开始

### 1. Relay

```bash
cd relay
npm ci
npm test
npm run build
```

生产配置和 systemd/Caddy 步骤见 [Relay 部署说明](relay/deploy/README.md)。Relay 必须放在独立 HTTPS 子域名后，loopback 端口不得开放公网。首次启动后执行：

```bash
node dist/cli.js bootstrap
```

在 15 分钟内打开一次性链接，创建管理员账号，并把浏览器下载的加密恢复文件离线保存。恢复文件和口令不得上传到 Relay 或提交 Git。

### 2. Windows Host

推荐使用每用户 Inno Setup 安装器。首次安装填写 Relay HTTPS 地址和项目白名单，再用已登录 Android 扫描五分钟 Host 二维码。Codex Desktop 必须由同一 Windows 用户自行登录。

源码开发：

```powershell
cd bridge
npm ci
npm test
npm run relay-enroll -- https://relay.example.com
npm start
```

安装器构建、Ed25519 发布签名和覆盖升级说明见 [Windows Host 安装说明](installer/windows/README.md)。安装器不修改系统代理、Windows 防火墙或其他代理服务。

### 3. Android

```powershell
cd android
.\gradlew.bat --no-daemon --no-configuration-cache :app:testDebugUnitTest :app:assembleDebug :app:assembleDebugAndroidTest
```

正式 APK 使用仓库外 keystore 构建。手机只登录 Relay 账号；模型请求仍由 Windows 上已登录的 Codex 发起。

## v1 迁移

1. 备份旧 Bridge 数据和 Relay/Caddy 配置。
2. 部署新的 Relay 子域名和 `127.0.0.1:8790` 服务，不改已有代理站点。
3. 每台 Windows 安装 Host v2 并扫码绑定，验证任务列表、Desktop Attach 和实时事件。
4. 安装 Android v2 并登录 Relay；v2 不读取旧直连凭据。
5. 全部 Host 验证后，再停用旧 SSH Tunnel、撤销旧 Bridge 设备令牌并移除旧 Caddy 路由。

不要删除本地 Bridge DB 或 Codex 历史。v1 与 v2 的手机凭据不兼容，这是一次明确切换。

## 安全边界

- Relay 与 Bridge 只监听 loopback；Host 只主动出站连接。
- 所有数据库查询必须带 `account_id`，Host 归单一用户独占。
- 所有 `cwd` 必须是白名单内已存在的绝对真实路径。
- 手机审批不提供永久允许；Desktop owner 与 writer lock 不可绕过。
- Host 更新必须同时通过固定 Ed25519 公钥、签名声明、文件大小和 SHA-256 校验。
- 任何完整 Relay 凭据、令牌、私钥、恢复文件、Firebase 配置、签名材料、任务正文和运维交接都不得提交。

公开部署前请阅读 [SECURITY.md](SECURITY.md)。

## 项目结构

```text
android/                 Android 原生客户端
bridge/                  Windows Bridge 与 Relay Connector
desktop-attach-plugin/   Codex Desktop Attach 实验性插件
installer/windows/       每用户 Host 安装器与签名更新
protocol/                跨端密码固定向量
relay/                   多用户 Relay、管理后台和部署脚本
```

## License

Apache License 2.0。参见 [LICENSE](LICENSE)。

## 友情链接

- [LINUX DO](https://linux.do/)
