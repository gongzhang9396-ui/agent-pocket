# Windows Bridge

运行时依赖 Node.js 24、`ws` 和可选的 `firebase-admin`；状态使用 Node 内置 SQLite。

`qrcode` 和 `qrcode-terminal` 是可选的本地 CLI 依赖。`pair` 会优先在 `%LOCALAPPDATA%\AgentPocket\pairing-<id>.png` 生成 1024px PNG 并尝试用 Windows 图片查看器打开，同时在终端绘制二维码；二维码内容不会上传到第三方服务。依赖缺失时会回退到系统 `qrencode`，再没有则使用手动配对码。

```powershell
npm install --ignore-scripts
npm test
npm run desktop-probe
npm start
```

`desktop-probe` 是 Desktop Attach 的只读诊断命令。它读取 `%LOCALAPPDATA%\AgentPocket\desktop-attach.json`，通过随机 Windows named pipe 和随机令牌连接已运行的插件，并仅调用 `attach/probe` 与 `thread/list`。输出只包含能力名称和结果项数量，不打印任务正文或本地令牌。Desktop-owned 任务的 `thread/list`、`thread/read` 和续写全部走 Codex Desktop 原生工具；Bridge-owned 任务才会交给独立 app-server，二者不会互相回退。

隧道部署后，`pair` 会自动读取 `%LOCALAPPDATA%\AgentPocket\tunnel\tunnel.json` 中保存的 WSS endpoint；也可以显式传入 endpoint 覆盖它。

Bridge 固定监听 `127.0.0.1:8787`。外部连接必须经过 OCI Caddy 与 Windows 主动建立的 SSH reverse tunnel；不要把 Bridge 改为 `0.0.0.0`，也不要直接开放 Windows 防火墙端口。协议不兼容时 Bridge 自动进入只读状态，不会更新 Codex 或批准写操作。

中继相关脚本：

- `new-oci-tunnel-key.ps1`：创建 Agent Pocket 专用 Ed25519 密钥。
- `deploy-oci-relay.ps1`：钉扎 OCI 主机指纹、部署受限账号和 Caddy 精确路径、安装隧道计划任务。
- `install-oci-tunnel.ps1`：只安装 Windows SSH tunnel 任务。
- `run-oci-tunnel.ps1`：由计划任务调用，保持 SSH reverse tunnel 并在断开后自动重连。
- `uninstall-oci-tunnel.ps1`：移除隧道任务，保留密钥以便恢复。
- `provision-oci-relay.sh`：只管理 OCI 上 Agent Pocket 自己的用户、密钥和 Caddy 标记 block。

完整 WSS 地址包含高熵路径，等同于敏感配置。`pair` 会把它放入五分钟二维码；Android 会将 endpoint、deviceId 和设备令牌一起用 Keystore AES-GCM 加密保存。

Firebase 服务账号是可选项。未配置时仅关闭 FCM；WSS 实时功能不受影响。FCM 发送前会强制裁剪为 `hostId/sessionId/eventId/type`。
