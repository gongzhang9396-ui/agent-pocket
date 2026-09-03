# Windows Host 安装器

Inno Setup 安装器按 Windows 用户安装到 `%LOCALAPPDATA%\Programs\Agent Pocket Host`，不需要管理员权限。每个 Windows SID 使用独立的 Host 和更新计划任务，因此同一电脑的不同 Windows 用户可分别绑定到自己的 Relay 账户。

安装器包含：

- 固定版本的 Node.js 24 x64 运行时；
- Bridge、Relay Connector 和 Desktop Attach 插件；
- 本地稳定 Marketplace；
- 登录启动任务和每日签名更新任务；
- 安装时生成的 `update-policy.json` 公钥策略。

它不会修改系统代理、Windows 防火墙、休眠策略或旧 Tunnel，也不会自动登录 Codex。

## 首次安装

首次安装向导要求：

1. Relay 的完整 `https://` 地址；
2. 一个或多个项目白名单根目录；
3. 手机附件在 Host 上的临时存储目录；
4. 当前 Windows 用户已安装并登录 Codex Desktop。

配置写入 `%LOCALAPPDATA%\AgentPocket\host-config.json`。`attachmentsPath` 可以指向空间充足的其他本地磁盘；缺少该字段的旧配置仍使用 `%LOCALAPPDATA%\AgentPocket\attachments`。也可以直接为 Bridge 设置 `AGENT_POCKET_ATTACHMENTS_DIR`。附件是一小时有效的临时副本。Relay Host 身份、Bridge SQLite 和 Codex 历史仍保存在原状态目录。

安装完成后会自动打开“Agent Pocket 配对助手”；开始菜单也保留重复打开入口。助手只显示二维码文件、五分钟倒计时、刷新和连接结果，不把 enrollment secret 写入日志。Android 可以在未登录状态先扫码，登录或首次激活成功后会自动继续 Host inspect/approve；绑定成功后 Host 任务重启以加载新身份。

覆盖升级检测到现有 `host-config.json` 后会跳过 Relay/白名单页面，不重写配置、不删除 Host 身份；安装器会重新安装随版本附带的 Desktop Attach 插件，避免 Codex 继续加载旧版插件。首次安装禁止静默模式，避免用示例配置误装。

## 卸载与重装

可从 Windows“设置 → 应用 → 已安装的应用”或开始菜单“Agent Pocket → 卸载 Agent Pocket Host”启动卸载。卸载器会停止并删除当前 Windows 用户的 Host/更新计划任务，终止经过安装路径校验的 Host 与 Desktop Attach 进程，并移除该安装目录注册的 Desktop Attach 插件和本地 Marketplace；不会影响其他 Node.js 或 Codex 插件。

交互卸载时可以选择是否删除这台电脑上的本地账号与绑定数据：

- 选择“否”（默认、推荐）只卸载程序，保留 `%LOCALAPPDATA%\AgentPocket` 中的 Host 身份、配置、Bridge 数据库和默认附件，之后用同一 Windows 用户重装即可继续原绑定；
- 选择“是”会删除上述本地状态，相当于让这台电脑退出 Agent Pocket。Relay 云端账号、手机和其他 Host 不会被删除，下次安装必须重新扫码绑定；配置到其他磁盘的外置附件目录不会自动删除。

静默卸载始终采用安全默认值并保留本地账号数据。卸载日志写入 `%TEMP%\AgentPocket-uninstall.log`。如果要删除 Relay 上的整个用户账号，必须在 Relay 管理端单独处理，不能由一台 Windows Host 的卸载器代替。

## 构建签名安装包

需要 Inno Setup 6 和仓库外 Ed25519 私钥。私钥可通过明确文件提供：

```powershell
.\build-installer.ps1 `
  -AppVersion 0.3.2 `
  -DefaultRelayUrl https://relay.example.com `
  -UpdateApiUrl https://relay.example.com/api/updates/host/latest `
  -SigningKeyFile C:\secure\agent-pocket-host-update-ed25519-private.pem
```

或只在当前进程环境提供 PEM：

```powershell
$env:AGENT_POCKET_HOST_UPDATE_SIGNING_KEY = Get-Content -Raw C:\secure\agent-pocket-host-update-ed25519-private.pem
try {
  .\build-installer.ps1 -AppVersion 0.3.2 `
    -DefaultRelayUrl https://relay.example.com `
    -UpdateApiUrl https://relay.example.com/api/updates/host/latest
}
finally { Remove-Item Env:AGENT_POCKET_HOST_UPDATE_SIGNING_KEY }
```

构建脚本：

1. 下载固定 Node.js 版本并核对官方 SHA-256 清单；
2. 只按显式文件白名单复制 Bridge、Desktop Attach 和运行脚本，未跟踪或额外文件不会进入 payload；
3. 用 lockfile 安装 Bridge 生产依赖；
4. 从私钥派生 Ed25519 SPKI 公钥并生成安装包内策略；
5. 编译 `AgentPocketHost-<version>-windows-x64.exe`；
6. 对规范更新声明签名并输出同名 `.sha256` 与 `.sig`；
7. 把公开的 `update-policy.json` 复制到输出目录。

私钥文件、PEM 环境值和任何真实 Relay 配置都不会写入 payload。没有签名私钥时构建会直接失败。

`-DefaultRelayUrl` 只把一个可编辑的初始值编译进首次安装向导，不会包含账号、密码或 Host 身份。省略时仍使用公开占位值 `https://relay.example.com`；私有正式分发通过参数或当前进程的 `AGENT_POCKET_DEFAULT_RELAY_URL` 注入实际 HTTPS 地址，避免把私人部署地址提交到公开 Git。

0.3.1 的迁移兼容仍识别以下三个 GitHub Release 资产名：

```text
AgentPocketHost-<version>-windows-x64.exe
AgentPocketHost-<version>-windows-x64.exe.sha256
AgentPocketHost-<version>-windows-x64.exe.sig
```

签名内容是以下 UTF-8 JSON 规范字符串：

```json
["agent-pocket-host-update-v1","<version>","<filename>","<sha256-lowercase>",<size>]
```

## 私有 Relay 自动更新

0.3.2 的私有构建把 `UpdateApiUrl` 指向 `https://<relay>/api/updates/host/latest`。Host 从 DPAPI 身份文件取得 Host token，Relay 只向匹配 Host 返回签名 manifest 和白名单资产；匿名、Android token 和任意 URL 均不能下载 Host 安装包。

每日兜底任务和 Relay 的 `update_available` 通知都会启动同一检查器，要求：

- API 和安装包使用同一 HTTPS Relay origin，且下载路径必须精确匹配 manifest；
- 版本严格高于安装包内的当前版本；
- manifest 签名、文件名、声明大小、SHA-256 和固定 Ed25519 公钥全部匹配；
- 下载与响应大小不超过策略上限。

校验失败会删除 `.part`。Relay 通知和每日任务在后台静默运行；开始菜单手动检查时才显示确认与错误。脚本写入五分钟维护锁，等待 Bridge 心跳确认维护模式，并再次确认运行状态新鲜且 `activeTaskCount == 0`。只有满足这些条件才会停止 Host 并执行静默覆盖安装。

活动任务、状态未知、状态陈旧、Bridge 未确认维护或 Host 无法停止时都不会强制升级。安装前会对回滚副本逐文件计算 SHA-256；失败时先恢复到同级暂存目录，再切换回安装目录。所有失败路径都会删除维护锁并恢复 Host 计划任务。中断命令在维护阶段仍可用。

完整双平台构建、私有 GitHub Release 和固定 SSH 指纹上传由根目录 `scripts/publish-private-release.ps1` 完成。公开仓库的构建默认值始终是占位域名；真实 Relay 和离线 Ed25519 私钥只在发布环境提供。

当前没有 Authenticode 证书，Windows 可能显示 SmartScreen 提示。发布页必须同时提供源码版本、SHA-256 和 Ed25519 签名；不要暗示已经获得系统级代码签名信誉。
