# Agent Pocket

Agent Pocket 是一个面向 Android 的远程 Codex 控制台。Codex、源码和 Bridge 都留在自己的 Windows 电脑；手机通过自己管理的 TLS 中继和 SSH reverse tunnel 查看任务、继续会话和接收实时状态，不需要占用 Android 的 VPN 槽位，也不需要在手机登录 ChatGPT。TLS 在中继终止，因此链路是分段加密，不是端到端加密。

> 当前项目仍处于实验阶段。Desktop Attach 依赖 Codex Desktop 的内部本地接口，Desktop 更新后可能需要适配。

## 能力

- Android 原生应用：任务收件箱、会话详情、新任务、流式消息、diff、二维码配对和断线重放。
- Windows Bridge：JSON-RPC、五分钟一次性配对、设备令牌、SQLite 事件重放、项目目录白名单和可选 FCM。
- 独立 Codex app-server：创建任务、steer、中断、审批和结构化问题回答。
- Desktop Attach：读取真实 Codex Desktop 任务、向原任务追加消息并等待状态变化。
- 公网中继：TLS 入口加 Windows 主动建立的 SSH reverse tunnel；Windows 不需要开放入站端口。

Desktop 原生 turn 的硬中断、原生审批响应和结构化问题回答目前没有稳定插件接口，因此不会通过第二个 app-server、删除 writer lock 或模拟坐标点击来强行实现。

## 架构

```text
Android App
  │  WSS + JSON-RPC 2.0 + device token
  ▼
Public Linux relay / Caddy / TCP 443
  │  TLS termination + exact high-entropy route
  ▼
Relay loopback port
  │  Windows-initiated SSH reverse tunnel
  ▼
Windows Bridge 127.0.0.1:8787
  ├─ Desktop Attach plugin → Codex Desktop-owned tasks
  └─ codex app-server --stdio → Bridge-owned tasks
```

公网中继是 TLS 终止点，因此这是分段加密，不是端到端加密。完整 WSS 地址中的高熵路径属于敏感配置；真正的身份认证仍由独立设备令牌完成。

## 环境要求

- Windows 10/11，Node.js 24，OpenSSH Client 和 Codex Desktop。
- Android 8.0 或更高版本；构建需要 JDK 17、Android SDK Platform 36 和对应的 Build Tools。Gradle Wrapper 会下载项目声明的 Gradle/Android Gradle Plugin 依赖。
- 一台具有公网 TCP 443 的 Linux 中继服务器，以及指向它的域名。
- Caddy 或等价的 WebSocket 反向代理。
- Windows、Bridge 和 Desktop Attach 使用同一个已登录的 Windows 用户。

手机不需要 ChatGPT 账号。真正的模型请求由 Windows 上的 Codex 发起，因此 Windows Codex 仍需使用 ChatGPT 登录、OpenAI API Key 或兼容的模型提供商配置。

## 快速开始

### Bridge

```powershell
cd bridge
Copy-Item .\bridge.env.example.ps1 .\bridge.env.ps1
# 编辑 bridge.env.ps1，设置自己的项目根目录和公开 WSS 地址。
npm ci
npm test
npm start
```

Bridge 固定监听 `127.0.0.1:8787`。不要将其改为 `0.0.0.0`，也不要直接开放 Windows 防火墙端口。

生成配对二维码：

```powershell
npm run pair
```

列出和撤销设备：

```powershell
npm run devices
npm run revoke -- <deviceId>
```

### OCI + Caddy 参考中继

仓库脚本提供的是 OCI/Linux + Caddy + systemd 的参考部署，需要远端管理员权限、可用的 Caddy 配置和公网 TCP 443。其他 Linux 或反向代理也可以使用，但必须实现同样的边界：WSS 在中继终止、只转发一条高熵路径到中继 loopback 端口，再由 Windows 主动建立的 SSH remote forward 接回 `127.0.0.1:8787`。不要让 Bridge 直接监听公网。

先通过可信渠道核验服务器的 ED25519 主机指纹，再执行：

```powershell
cd bridge
.\scripts\new-oci-tunnel-key.ps1
.\scripts\deploy-oci-relay.ps1 `
  -Domain "relay.example.com" `
  -HostName "203.0.113.10" `
  -AdminUser "cloud-user" `
  -AdminKey "C:\secure\relay-admin.key" `
  -HostKeySha256 "SHA256:<verified-fingerprint>"
```

`203.0.113.10` 是文档示例地址。不要把真实域名、IP、私钥路径、主机指纹或生成后的 WSS 路径提交到 Git。

### Desktop Attach 插件

插件源码位于 [`desktop-attach-plugin`](desktop-attach-plugin)。它通过随机 Windows named pipe 与 Bridge 通信，不监听 TCP。安装后需新建 Codex Desktop 任务才能加载新版本。

当前仓库按源码方式分发该实验性插件，尚未提供一键公共 Marketplace 安装。开发安装时，请在 Codex Desktop 中打开本仓库，让 Codex 使用内置 `plugin-creator` 把 `desktop-attach-plugin` 安装到本机 personal marketplace；不要手工编辑 `marketplace.json`。安装后可用 `codex plugin list` 核对，再新建一个任务加载插件。相关命令以 [Codex 官方插件命令文档](https://developers.openai.com/codex/developer-commands#plugins) 为准。

插件依赖 Codex Desktop 提供的内部 `CODEX_APP_TOOLS_PIPE_PATH`。该接口不是公开兼容契约；能力缺失或协议变化时，插件会失败关闭写入，不会切换到第二 writer。

### Android

```powershell
cd android
.\gradlew.bat --no-daemon :app:assembleDebug
```

Release 构建使用本机独立签名材料：

```powershell
.\scripts\build-release.ps1
```

相机只用于本地识别配对二维码。未配置 Firebase 时，前台 WSS 功能仍可使用，只有后台 FCM 提醒不可用。

## 安全设计

- Bridge 仅绑定 localhost；公网只能经过 TLS 中继和 SSH 隧道。
- 配对 secret 五分钟过期且只能使用一次。
- 设备令牌随机生成，服务端只保存 SHA-256 哈希。
- Android 使用 Keystore AES-GCM 保存 endpoint、deviceId 和设备令牌。
- 所有任务工作目录必须位于配置的真实路径白名单内。
- Desktop 与 Bridge 任务具有持久 owner，禁止两个 app-server 同时写同一任务。
- FCM 只允许发送 `hostId/sessionId/eventId/type`，不发送代码、提示词或输出。
- 手机审批不提供“永久允许”。

请阅读 [SECURITY.md](SECURITY.md) 后再公开部署。

## 永远不要提交

- 完整 WSS 地址或高熵路径；
- Bridge 设备令牌、配对二维码或 SQLite 数据库；
- SSH 私钥、`known_hosts`、真实服务器 IP 和管理员账号；
- Firebase 服务账号及 `google-services.json`；
- Android release keystore、密码文件和 `keystore.properties`；
- Codex 会话正文、日志、崩溃转储或本机运维交接文档。

## 项目结构

```text
android/                 Android 原生客户端
bridge/                  Windows Bridge、协议和部署脚本
desktop-attach-plugin/   Codex Desktop Attach 实验性插件
```

Android、Bridge 和 Desktop Attach 分别维护组件版本，版本号不要求同步。

## License

Apache License 2.0。参见 [LICENSE](LICENSE)。

## 友情链接

- [LINUX DO](https://linux.do/)
