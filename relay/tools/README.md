# Agent Pocket 恢复工具

双击 `AgentPocket-Recover.vbs` 打开 Agent Pocket 图形化工具，不需要手动拼接 PowerShell 命令。

窗口内有两个页面：

- `绑定 Windows Host`：点击“生成二维码并等待扫码”，二维码会直接显示在窗口中。用手机 Agent Pocket 的“绑定 Windows Host”扫一扫，手机确认后窗口会自动提示绑定完成；不需要再打开终端或手动找 PNG 文件。若本机已经绑定过，窗口会直接提示无需再次扫码。
- `恢复手机`：用于手机显示“新设备等待已有手机批准”且旧手机无法批准时，读取离线恢复 JSON，选择待批准设备并完成恢复。

恢复手机使用顺序：

1. 选择浏览器下载的 `agent-pocket-recovery-*.json`；
2. 填写管理员用户名和密码；
3. 点击“读取待批准设备”，选择当前手机；
4. 填写离线恢复口令，点击“恢复设备”。

工具只在本机读取恢复 JSON，并调用现有 `relay/dist/cli.js recover-device`。恢复私钥不会上传 Relay；Relay 只接收重新密封给当前手机的密钥包。

## 前置条件

- Windows PowerShell 5.1 或更高版本；
- Node.js 24 在 PATH 中，或仓库 `relay/node/` 下有 `node.exe`；
- 当前目录包含已构建的 `relay/dist/cli.js` 和 `relay/node_modules`；
- 管理员账号可以访问 Relay 管理 API。
