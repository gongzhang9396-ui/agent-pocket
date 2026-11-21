# Agent Pocket iOS 开发版

`ios/AgentPocket.xcodeproj` 是 iPhone / iPad 共用的 iOS 18+ 工程。第一版以 SwiftUI 承载现有 Relay 的 HTTPS `/app/` 网页，让已有的登录、加密通道、任务、续聊、附件上传和审批逻辑在独立 App 内运行；它不是 Android 全功能的 SwiftUI 移植。

## 运行

1. 在 Mac 用 Xcode 打开 `ios/AgentPocket.xcodeproj`，选择 `AgentPocket` scheme。
2. 如需安装到真机，在 Signing & Capabilities 选择自己的 Team；必要时换一个唯一的 Bundle ID。源码不包含 Team、证书、设备或服务器信息。
3. 选择已配对且启用开发者模式的 iPhone / iPad，点击 Run。
4. 预配置的安装包首次打开直接进入登录页，无需填写服务器地址。自行构建时可通过 `AGENT_POCKET_DEFAULT_RELAY_ORIGIN=https://relay.example.com` 指定默认服务；未配置时才显示地址设置。服务器须启用网页功能，并提供 `/app/`。
5. 使用现有网页账号流程登录。旧 Android 账号首次使用网页设备时，按网页提示在 Android 的账号设备列表批准一次。

应用有自己的 WebKit 设备记录，与 Safari 分开；Safari 已登录不代表 App 已登录。换服务器使用独立的数据配置，返回旧服务器会保留它原有的加密记录。原生设置仅保存服务器地址，不读取网页密码、令牌、密钥或任务内容。

默认地址由构建设置写入安装包，并通过同一 HTTPS 地址校验。升级不会覆盖用户此前主动选择的服务器；已保存但无效的地址也不会静默切到其他服务。真实部署地址只放在私有构建配置中，公开源码保持通用。

## 本机构建校验

在已安装 Xcode 和 iOS SDK 的 Mac 运行：

```bash
bash ios/Tools/validate-on-mac.sh
```

脚本校验 URL/同源策略、plist，并执行禁用签名的完整 iOS arm64 Debug 构建。产物在 `ios/build/DerivedData/Build/Products/Debug-iphoneos/AgentPocket.app`。**未签名 `.app` 不能直接安装到普通 iPhone；构建成功不代表已签名、已安装或真机功能验收完成。**

开发签名沿用 Xcode 的正常流程。Personal Team 的有效期、可用设备和应用数量由 Apple 账号实际状态决定；不要将临时签名当作长期分发。TestFlight / App Store 分发需要另行准备，不在本工程自动执行。

已经用 Xcode 完成开发签名的 App，可以生成供授权设备使用的私有 IPA：

```bash
python3 ios/Tools/package-development.py /path/to/AgentPocket.app \
  --output /path/to/AgentPocket-development.ipa
```

可增加 `--device-udid <目标设备UDID>` 校验具体目标。工具先复制到隔离目录，再验证最终副本的 Apple 证书链、证书有效期、证书在描述文件中的授权、App 标识、团队、entitlement、设备列表和到期时间，最后生成 IPA 与 SHA-256 报告。输出必须是不存在的新文件。IPA 仍须通过 Xcode/开发设备工具安装到描述文件授权的设备；不能在任意 iPhone 上点开安装。

2026-10-26 已在 Xcode 26.6 / iOS 26.5 SDK 上通过 URL 策略测试及 iOS arm64 完整构建（Swift 严格并发检查、编译警告视作错误），并完成一次 Apple Development 签名构建。签名包和真机使用结果分别以实际校验报告与设备记录为准。

## 行为与边界

- 主 WebView 仅允许配置的 HTTPS 同源 `/app/`；外部 HTTPS 文档、邮件链接或 TOTP 验证器由用户明确点击并确认后交给系统。HTTP 文档链接不会打开。没有忽略 TLS 错误、ATS 例外、原生 JavaScript 权限桥或自动审批。
- 每个 Relay 使用独立持久 WebKit profile。设备私钥、账户包、刷新凭据仍由既有网页流程加密存入 IndexedDB，访问令牌及解密内容依旧只在网页内存使用。继承网页安全模型，需信任部署网页的 Relay 与 HTTPS 终止端。
- 回前台使用网页已有恢复路径，不自动 reload 或重发写入。页面进程被 iOS 回收时明确提示手动重新打开；草稿只在内存，不能保证存活。
- iOS 应用切换预览由原生遮罩覆盖。它不等于销毁网页密钥或锁定账号，账号锁定/退出仍在页面设置中完成。
- 新建任务与续聊附件使用 WebKit 系统选择器，继承网页大小和类型限制。支持读取 Codex 回复明确链接的任务文件：图片和小型文本可在页内预览，保存优先使用 Web Share 系统分享面板。旧外壳不允许跳转到 `blob:`；若系统不支持该文件的分享，页面提示使用 Safari 下载，不绕过导航限制。此保存路径仍需 iPhone 真机验收；没有新增后台上传、相册读取或全盘访问。
- 暂无 APNs、后台实时连接、原生扫码、Universal Links、系统分享扩展或离线任务读写。配对可在网页中粘贴现有链接。
- 模型选择、Plan/Goal 等以服务器实际部署的网页版能力为准；当前网页尚不等同 Android 的全部模型控制功能。
- 网页更新随服务器部署生效；App 没有内置或缓存一套不同版本的密码协议。

实际 Mac 构建和设备验证结果应另附私有操作记录；不要把真实服务器、Apple Team、证书、设备标识、账号或日志写入公开源码。
