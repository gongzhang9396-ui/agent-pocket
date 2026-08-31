# Agent Pocket Relay v2

Relay 是 Agent Pocket 的多用户、多主机路由层。它接收 Android 和 Windows Host 的主动 WSS 连接，保存加密任务快照与近期加密事件，并提供无任务正文的管理后台。

## 本地开发

```bash
npm ci
npm test
npm run build
npm run dev
```

默认只监听 `127.0.0.1:8790`。本机开发可用 `http://127.0.0.1:8790`；任何非 loopback 部署都必须把 `AGENT_POCKET_RELAY_URL` 配成 HTTPS。

生产只运行编译后的 JavaScript：

```bash
node dist/cli.js serve
```

## 首次初始化

空数据库启动后，在服务器上执行：

```bash
node dist/cli.js bootstrap
```

命令输出 15 分钟有效、只能使用一次的管理员初始化链接。浏览器初始化过程会：

1. 在浏览器本地生成恢复密钥；
2. 用恢复口令加密私钥并下载恢复文件；
3. 只把恢复公钥上传 Relay；
4. 创建首个管理员账户和可信设备。

恢复文件与口令必须分开离线保管。Relay 无法替你重新生成丢失的恢复私钥。

## 数据边界

SQLite 使用 WAL，保存账户、邀请、令牌哈希、设备、Host、路由 counter、密文快照、密文事件、FCM token 和审计记录。Relay 不持有日常解密密钥，正常运行时看不到 thread ID、提示词、代码、命令或输出。

管理员恢复属于显式托管能力：本地恢复工具用离线私钥解开账户托管包，再只上传给目标设备重新密封的 key package。操作写入 `device.recover` 审计记录。

```bash
node dist/cli.js recover-device \
  https://relay.example.com \
  <account-id> \
  <pending-device-id> \
  /offline/path/recovery-file.json
```

默认交互读取管理员密码和恢复口令；自动化变量含秘密，不应写入 shell history、systemd unit 或仓库。

## 网络接口

- `/ws/device`：Android 设备 WSS。
- `/ws/host`：Windows Host WSS。
- `/api/auth/*`：设备登录、刷新和退出。
- `/api/host/enroll/*`：五分钟 Host 绑定。
- `/api/admin/*`：管理后台 API。
- `/health`：无敏感信息的健康检查。

外层 JSON-RPC v2 只路由 `relay/hello`、Host/设备管理、密文快照/事件和 `channel/*` 信封。Bridge 原有的 `thread/*`、`turn/*`、审批和问题协议全部位于端到端加密通道内。

详细生产部署见 [deploy/README.md](deploy/README.md)。
