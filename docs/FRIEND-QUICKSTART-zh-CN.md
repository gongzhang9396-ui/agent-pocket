# Agent Pocket 0.3.2 朋友测试安装说明

> 这是一份小范围测试说明。Agent Pocket 仍处于实验阶段，请只在你信任的电脑、手机和项目目录上使用。

## 你会拿到什么

压缩包中包含：

- `Agent-Pocket-0.3.2-release.apk`：Android 手机端；
- `AgentPocketHost-0.3.2-windows-x64.exe`：Windows Host 安装器；
- 对应的 `.sha256`、`.sig` 和 `SHA256SUMS.txt`：完整性校验文件；
- 本安装说明的 Markdown 和 PDF 版本。

本测试包已经预填 Relay 地址，一般无需手工填写；升级安装也不会覆盖已保存的地址。账号、密码和设备身份均不包含在安装包中。

## 安装前准备

- Android 8.0 或更高版本的手机；
- Windows 10/11 x64 电脑；
- Windows 上已安装最新版 ChatGPT Desktop，并已经登录可使用 Codex 的账号；
- 一个已经存在的项目目录，例如 `D:\Projects`；
- 管理员单独发给你的 Agent Pocket 用户名和初始密码；
- 手机与电脑都能访问互联网，不要求处在同一 Wi-Fi 或 VPN。

ChatGPT Desktop 的官方安装与登录说明：<https://learn.chatgpt.com/docs/app>

## 第一步：校验安装文件

解压后，在该目录打开 PowerShell：

```powershell
Get-FileHash .\Agent-Pocket-0.3.2-release.apk -Algorithm SHA256
Get-FileHash .\AgentPocketHost-0.3.2-windows-x64.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

屏幕上的哈希应与 `SHA256SUMS.txt` 对应条目一致。若不一致，不要安装，重新向发送者索取文件。

Windows Host 目前没有商业 Authenticode 证书，SmartScreen 可能显示“Windows 已保护你的电脑”。只有在确认文件来自测试包且 SHA-256 完全一致后，才选择“更多信息”继续运行。

## 第二步：准备 Windows 上的 Codex

1. 安装并打开 ChatGPT Desktop；
2. 登录 ChatGPT 账号，切换到 Codex；
3. 在 Codex 中打开至少一个本地项目目录；
4. 保持当前 Windows 用户的登录会话，不要用另一 Windows 账号安装 Host。

Agent Pocket 不会替你登录 ChatGPT，也不会把模型调用放到手机或 Relay 上。真正的 Codex 任务仍在这台 Windows 电脑上执行。

## 第三步：安装 Android App

1. 把 `Agent-Pocket-0.3.2-release.apk` 发送到手机并打开；
2. Android 如提示“允许安装未知应用”，只为当前文件来源临时授权；
3. 安装并打开 Agent Pocket；
4. 先停留在“扫描电脑二维码”页面，不需要提前注册，也不需要邀请链接。

密码长度为 12-128 个字符。用户名和密码只应通过可信渠道接收，不要截图或转发到公开群聊。

## 第四步：安装 Windows Host

1. 运行 `AgentPocketHost-0.3.2-windows-x64.exe`；
2. Relay 地址已经预填，一般不需要修改；
3. “项目白名单”填写允许手机操作的项目根目录。多个目录用英文分号分隔，例如：

   ```text
   D:\Projects;G:\Work
   ```

4. “附件临时目录”建议选择空间充足的本地磁盘，例如 `D:\AgentPocketData\attachments`；
5. 完成安装。安装器按当前 Windows 用户安装，不要求管理员权限；
6. 安装完成后“Agent Pocket 配对助手”会自动打开。如果没有出现，从开始菜单打开“Agent Pocket > 绑定这台 Windows 电脑”。

Host 不会修改系统代理、防火墙或休眠设置。附件只在 Host 上临时落盘，默认一小时后清理。

## 第五步：绑定电脑

1. Windows 配对助手生成二维码；二维码默认有效 5 分钟；
2. Android Agent Pocket 点击“扫描电脑二维码”，允许相机权限并扫码；
3. Relay 地址会自动填写。输入管理员发给你的用户名和密码；
4. 如果这是该账号的第一台手机，Relay 会自动激活手机并绑定电脑；无需管理员批准，也无需再次扫码；
5. Windows 显示“绑定成功”后，手机会自动进入任务列表并显示 Host 在线。

密码错误时修正后重试即可；Host 暂时离线时不要退出登录，重新打开配对助手或刷新二维码后可继续。二维码过期时点击 Windows 助手中的“刷新二维码”。成功绑定、取消配对或退出账号后，手机会清除暂存的二维码密钥。

如果账号已经激活过，新增手机仍会进入“等待批准”，必须由该账号的已有可信手机或管理员处理。这条限制不会因为再次扫描 Host 二维码而绕过。

Desktop Attach 插件由安装器一并安装。新建或恢复 Codex 任务时会自动探测 Attach 通道；如当前 Codex 版本仍显示 `SessionStart` Hook 信任提示，请阅读内容后，只信任 Agent Pocket 提供的这一条 Hook，不要顺便信任来源不明的其他 Hook。

## 第六步：做一次最小测试

建议依次完成：

1. 手机首页能看到 Windows 上的任务；
2. 打开一条任务并读取最新消息；
3. 用“Bridge · 手机完整控制”新建一个简单任务；
4. 选择模型和 reasoning，发送一句不会修改文件的测试指令；
5. 测试续写，再测试一张小图片或一个小文本文件；
6. 确认回复能持续同步，且 Windows Codex 中也能看到对应任务。

需要 Plan 模式、审批、问题回答或中断时，请使用 Bridge 运行方式。Desktop 运行方式用于接入真实 Codex Desktop 任务，但暂不支持从手机完成所有原生交互。

## 常见问题

### 手机一直显示 Host 离线

- 确认 Windows 没有退出登录或休眠；
- 确认手机和电脑都能访问 Relay；
- 在“任务计划程序”中确认名称以 `Agent Pocket Host v2` 开头的任务正在运行；
- 关闭再打开 Agent Pocket，点击刷新。

### 显示 `sent ping but didn't receive pong`

这通常是网络切换或 Host 连接重启造成的。先点击“重新加载”；仍失败时重启 `Agent Pocket Host v2` 计划任务，再回到手机刷新。不要删除 `%LOCALAPPDATA%\AgentPocket` 或重新绑定 Host。

### Host 在线，但看不到 Desktop 任务

- 确认 ChatGPT Desktop 已登录并打开过 Codex 项目；
- 新建一个 Codex 任务，留意 Agent Pocket Hook 的信任提示；
- 重启 ChatGPT Desktop 后再次刷新；
- 确认安装 Host 和登录 Codex 使用的是同一个 Windows 用户。

### 新建任务失败或 Plan 不可用

优先选择“Bridge · 手机完整控制”。重新选择在线 Host、项目、模型和 reasoning 后再发送。Desktop 路径使用第三方模型中转时，首轮任务可能不稳定。

### 登录提示账号不存在、等待激活或尝试过多

- 确认用户名、密码来自管理员，并且没有多余空格；
- 确认扫码后自动填写的是管理员提供服务所用的 Relay；
- 账号必须由管理员提前创建，首次正确登录才会自动激活；
- 连续输错会触发持久限流，请按提示的等待时间后再试，不要反复刷新；
- 忘记密码时让管理员重置。重置不会删除已绑定的电脑和设备，但所有现有会话会退出。

### 管理员只给了旧邀请链接

0.3.2 普通流程不需要邀请。旧邀请 API 和 Android 深链只为旧客户端兼容；请优先让管理员直接创建账号并提供用户名、初始密码。

### Windows 安全软件提示未知发布者

这是因为测试包尚未购买 Authenticode 证书，不代表可以忽略任何警告。请先核对 SHA-256；若哈希不一致或文件来源不明，立即停止安装。

## 后续更新

从 0.3.2 开始，Android 和 Windows Host 登录后通过同一 Relay 鉴权检查更新，不提供匿名下载。Android 下载并验签后仍由系统弹出安装确认；Host 只有在没有活动任务时才静默覆盖升级，有任务会延后。首次 0.3.2 APK/EXE 仍由管理员手工发送和安装。

## 隐私与卸载

- Relay 负责鉴权、路由和近期密文缓存，正常运行时不读取任务正文；
- 手机附件会先加密传输，再在选中的 Windows Host 上生成临时副本；
- Windows“已安装的应用”或开始菜单都能卸载 Host；默认保留 `%LOCALAPPDATA%\AgentPocket` 中的本机账号、Host 身份和本地状态，方便之后重装；
- 卸载时也可以选择“删除这台电脑上的本地账号与绑定数据”，让本机退出并清除默认附件和历史；Relay 云端账号、手机和其他电脑不会受影响，下次安装需要重新扫码；
- 如果附件目录改到了其他磁盘，卸载器不会自动删除那个外置目录；如果要删除 Relay 上的整个账号，请联系管理员单独处理；
- 测试中请不要发送密码、私钥、恢复文件或其他不应进入 Codex 任务的敏感数据。

出现问题时，请提供：问题发生时间、手机页面截图、Host 在线状态和复现步骤。不要发送邀请链接、密码、Token、二维码原图或恢复文件。
