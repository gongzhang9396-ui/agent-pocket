# Agent Pocket Host 绑定持久化与升级说明

最后更新：2026-09-01

本文说明为什么更新或重装后可能再次出现“绑定 Windows Host”，以及如何避免丢失 Host 身份。本文不包含真实 Relay 地址、内网地址、密码、设备 ID、令牌或恢复密钥。

## 1. 先区分两种“绑定”

Agent Pocket 有两套独立身份，提示看起来相似，但处理方式不同：

| 提示或现象 | 实际对象 | 正常处理方式 |
| --- | --- | --- |
| “新设备等待已有手机批准” | Android 手机设备身份 | 用已有可信手机批准，或使用管理员离线恢复 |
| Windows 显示二维码并要求手机扫描 | Windows Host 身份 | 只有 Host 身份确实丢失、被撤销或更换账号时才重新绑定 |

重新安装 Android App 后，通常只需要恢复手机设备，不应该连带重新绑定 Windows Host。

## 2. Windows Host 身份保存在哪里

Host 身份不保存在安装目录中，而是保存在当前 Windows 用户的本地状态目录：

```text
%LOCALAPPDATA%\AgentPocket\host-config.json
%LOCALAPPDATA%\AgentPocket\relay-host.json
%LOCALAPPDATA%\AgentPocket\bridge.db
%LOCALAPPDATA%\AgentPocket\desktop-attach.json
```

其中：

- `host-config.json` 保存 Relay 地址、项目白名单和 Host 名称；
- `relay-host.json` 保存 Host 的公钥、私钥、Host 凭据和事件游标；
- `bridge.db` 保存 Bridge 本地事件、请求和运行状态；
- `desktop-attach.json` 保存 Desktop Attach 的本地连接状态。

`relay-host.json` 的私钥和 Host 凭据使用 Windows DPAPI 的 `CurrentUser` 范围加密。也就是说，它只能由原来的 Windows 用户解密。即使文件被复制到另一台电脑，或复制给另一个 Windows 账户，也不能直接使用。

## 3. 为什么更新后会要求重新绑定

最常见的原因是安装器把这次安装当成了新的 Host：

1. 使用了另一份测试版、便携版或其他助手制作的安装包；
2. 新旧安装包的 Inno Setup 应用标识或状态目录不同；
3. 安装前卸载并清理了 `%LOCALAPPDATA%\AgentPocket`；
4. 这次安装或计划任务使用了不同的 Windows 用户；
5. 手工删除了 `relay-host.json`，或该文件损坏；
6. 原来的 Host 已经在 Relay 后台被撤销；
7. 只保留了 `host-config.json`，但没有保留真正的 Host 身份文件。

当 `relay-host.json` 不存在时，Bridge 会生成一组新的 Ed25519/X25519 密钥。Relay 会把它识别为一台全新的 Host，因此必须重新扫码确认归属。

当前正式安装器的设计是：

- 按当前 Windows 用户安装到 `%LOCALAPPDATA%\Programs\Agent Pocket Host`；
- 使用固定的安装器标识识别覆盖升级；
- 升级时跳过首次配置和绑定流程；
- Windows“已安装的应用”和开始菜单都提供卸载入口；
- 默认卸载会删除程序、计划任务和 Desktop Attach 注册，但保留 `%LOCALAPPDATA%\AgentPocket` 状态目录；
- 交互卸载可以选择删除这台电脑上的本地账号与绑定数据；该选择只清理本机状态，不会删除 Relay 云端账号、手机或其他 Host，也不会递归删除配置在其他磁盘的附件目录。

因此，使用同一正式安装器进行覆盖升级时，不应重新绑定。

## 4. 正确的 Windows 升级流程

### 升级前

1. 确认当前登录的是原来绑定 Host 的 Windows 用户；
2. 确认当前没有正在执行的重要 Codex 任务；
3. 备份整个状态目录到安全位置：

   ```text
   %LOCALAPPDATA%\AgentPocket
   ```

4. 不要把备份上传到公开仓库、论坛、网盘分享链接或工单附件。

### 安装时

1. 直接运行新版本正式安装包；
2. 选择覆盖现有安装，不要先卸载旧版；
3. 不要删除 `%LOCALAPPDATA%\AgentPocket`；
4. 如果先卸载再重装，请在卸载确认中选择默认的“否”，不要删除本地账号与绑定数据；
5. 如果安装器再次出现首次配置或绑定二维码，先取消并检查状态，不要立即重新扫码。

### 升级后

1. 打开 Host 状态或图形化工具；
2. 确认显示已绑定、Relay 地址正确、Host 名称正确；
3. 确认 Host 在线后，再从手机刷新主机列表；
4. 最后用一个低风险任务验证 Desktop Attach 和实时事件。

## 5. Android App 的正确升级流程

Android 更新也分为“覆盖更新”和“卸载重装”：

- 覆盖安装：通常保留 Android Keystore 中的设备密钥和应用数据；
- 卸载 App：会删除应用私有数据，设备密钥可能丢失；
- 清除应用数据：效果与重新安装接近；
- 使用不同签名的测试包：可能无法覆盖正式包，系统会把它当成另一套 App。

如果手机显示“新设备等待已有手机批准”：

1. 不要先重新绑定 Windows Host；
2. 优先使用仍然可信的旧手机批准新设备；
3. 如果没有可信手机，使用管理员恢复流程；
4. 手机设备恢复完成后，再刷新 Host 和任务列表。

## 6. 发现再次要求绑定时的检查顺序

先退出绑定页面，不要立即扫描二维码。用原来的 Windows 用户执行只读检查：

```powershell
$state = Join-Path $env:LOCALAPPDATA 'AgentPocket'
Get-ChildItem -LiteralPath $state -Force |
  Select-Object Name, Length, LastWriteTime
```

至少应看到：

```text
host-config.json
relay-host.json
```

然后检查：

- 是否换了 Windows 用户；
- 是否从另一个安装目录启动了 Bridge；
- 是否安装了测试包而不是正式包；
- 是否刚刚执行过卸载或清理；
- Relay 后台中的 Host 是否被撤销；
- `relay-host.json` 是否仍然可以由原用户读取。

如果两个状态文件都存在，优先使用图形化工具中的“已绑定 Host 检测”或 Host 状态检查，不要重复创建绑定。

## 7. 哪些情况无法靠普通复制恢复

以下情况可能必须重新绑定，或需要专门的恢复工具：

- 原 Windows 用户账户已经删除并重新创建；
- Windows 用户 SID 已经变化；
- DPAPI 主密钥损坏；
- `relay-host.json` 被删除且没有备份；
- Relay 后台已经撤销了旧 Host；
- 需要把 Host 迁移到另一台电脑或另一个 Windows 用户。

这是 DPAPI 的安全边界：它防止别人拿到状态文件后直接冒充 Host，但也意味着 Host 身份不是跨电脑、跨用户可随意搬运的普通配置文件。

## 8. 不要执行的操作

- 不要在升级前手工删除 `%LOCALAPPDATA%\AgentPocket`；
- 不要先卸载再安装，除非确实要清理整套 Host；
- 不要用管理员账户替普通用户安装或启动 Host；
- 不要把 `relay-host.json` 提交到 GitHub；
- 不要把 Host 备份放入安装包或公开压缩包；
- 不要删除 Relay 后台旧 Host 后再尝试“恢复”；
- 不要同时运行多个不同版本的 Host 计划任务。

## 9. 当前实现的保护与已知缺口

当前实现已经具备：

- 固定 Inno Setup 应用标识，用于识别覆盖升级；
- 每个 Windows 用户独立的 Host 状态目录；
- 卸载默认保留 Host 身份、Bridge 数据库和 Codex 历史，同时提供明确的本机数据删除选项；
- 卸载会清理当前用户的 Host/更新任务和该安装目录对应的 Desktop Attach 注册，不会按进程名误杀其他 Node.js 进程；
- Host 私钥和凭据使用 DPAPI 加密；
- 已绑定 Host 再次执行绑定时会拒绝重复绑定；
- 图形化工具会检测已有 Host 身份，并提示不要重复扫码。

仍建议补强以下逻辑：

1. 安装器同时校验 `host-config.json` 和 `relay-host.json`，不能只根据单个配置文件判断是否为升级；
2. 每次覆盖升级前自动创建带时间戳的本地状态备份；
3. 发现状态文件不完整时进入“修复/恢复”页面，而不是直接启动绑定流程；
4. 兼容旧版本或其他安装包可能使用的状态目录，并提供明确的迁移提示；
5. 在 GUI 中明确区分“恢复手机设备”和“重新绑定 Windows Host”；
6. 发布时只提供一个正式 Host 安装包，避免测试包和正式包混用。

## 10. 一句话原则

**更新程序可以换，Host 身份不能丢；同一 Windows 用户、同一状态目录、覆盖安装、不清理数据，就不需要重新绑定。**
