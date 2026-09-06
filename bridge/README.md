# Windows Host / Bridge

Host 连接本机 Codex CLI 与 Relay。运行时需要 Node.js 24；安装包自带 Node，状态使用内置 SQLite。源码开发：

```powershell
npm ci --ignore-scripts
npm test
npm start
```

启动前配置 `AGENT_POCKET_PROJECT_ROOTS`（Windows 以分号分隔的绝对目录）、`AGENT_POCKET_RELAY_URL` 与本机身份。完整安装、扫码绑定和恢复步骤见 [使用说明](../docs/USAGE.md)。v2 Host 主动连接 Relay，不需要每台电脑的 SSH 反向隧道。安装器将本机监听限制在 loopback 的随机端口；独立 CLI 开发默认端口为 8787。

Codex 可以使用本机已配置的兼容模型 API，不要求 GPT 账户。安装器识别原生 CLI、npm 的 Windows 启动脚本对应的原生程序，以及 Desktop 附带的 CLI。Desktop Attach 是可选集成，安装失败不会阻止 API 模式的 Host 启动；安装状态记录在本机 `desktop-integration-status.json`。

任务身份和历史来自原生 Codex 存储。catalog 只调用读取接口，按项目白名单过滤，查询所有 provider 的顶层任务。详情用 `thread/turns/list` 分页；只在 CLI 明确不支持该方法时退回完整读取。浏览不会创建 worker 或登记 owner。Desktop Attach 作为读取兼容路径。

写入路由单独记录：Bridge 根任务各有一个 app-server worker，Desktop 任务交由 Attach 写入。读取后端与写入路由没有绑定关系；不会因为 Attach 写入失败而自动启动另一个 writer。显式交接需要任务空闲和 worker 正常退出证据。协议与验证边界见 [Host 基础契约](../docs/HOST-FOUNDATION.md) 和 [接续改造记录](../docs/CONTINUITY-REDESIGN.md)。

`npm run desktop-probe` 是可选的只读 Attach 诊断，输出能力和数量，不输出任务正文或令牌。FCM 也是可选项，关闭它不影响 WSS 实时连接；通知仅含定位信息。

隔离验证（临时 CODEX_HOME、loopback Responses 服务，无真实模型或账户）：

```powershell
node --experimental-strip-types scripts/probe-thread-sharing.mjs --pool
```

本页 catalog、执行池、可选 Desktop 安装等描述对应当前开发代码，尚未发布到已安装的 0.3.2。
