# Agent Pocket 移动端 · Flutter

Android 0.4.0 起使用的独立 Flutter 工程，当前 Dart 版本为 0.4.1+401。界面、账号会话、加密协议、任务和文件业务由 Dart 实现；平台层提供安全存储和系统接口。原 `android/` 工程保留，作为升级兼容对照和回退源码。

## iOS 测试版

`ios/` 现提供 Flutter Runner 和 Swift 平台通道，最低 iOS 17。使用 Flutter 3.44.4 / Dart 3.12.2，沿用锁定依赖，sodium 由 build hooks 随应用打包。应用采用 UIScene 生命周期，AppDelegate 持有唯一 Flutter 引擎，SceneDelegate 创建窗口，系统 UILaunchScreen 提供启动页。

首版按用户选择与仓库根目录的旧 iOS 网页外壳并存，使用独立 Bundle ID，显示名为 Agent Pocket Flutter。登录后沿用新设备批准流程，旧版及其加密记录继续保留。扫码和粘贴支持原配对码，测试版不注册与旧版冲突的 URL scheme。

Swift 使用 device-only Keychain 原子保存凭据、失效屏障和本地加密密钥，操作日志以 AES-GCM 保存在受保护的私有目录。非秘密初始化哨兵随备份保留；已有哨兵/密文而 Keychain 缺失或不可用时进入恢复提示，保留数据。

文件选择、原始字节分块复制、SHA-256、保存和系统分享/打开均通过 iOS 系统窗口完成。iOS 暂不常驻后台，返回前台后沿用 Dart 事件补齐；任务提醒由用户授权本地通知。版本页通过电脑安装测试版本，关闭 Android APK 更新入口。

Mac 构建使用 `scripts/build-ios-on-mac.sh`。需设置 `POCKET_IOS_TEAM`、独立的 `POCKET_IOS_BUNDLE_ID`、`POCKET_IOS_DEVICE_UDID`、`POCKET_RELAY_ORIGIN`，可用 `POCKET_FLUTTER_SDK` 指定固定 SDK。脚本锁定依赖、核对源码摘要，使用现有 Apple 开发者账号签名并执行原严格描述文件/目标手机验证，生成私有开发 IPA。真实手机验收记录与尚未完成项目另行记录。

当前 Mac 的 Simulator 运行组件签名损坏，开发测试工程暂用普通 PNG 主图标资源。后续 App Store 发布需恢复 Asset Catalog 并重新验证，系统签名校验保持原设置。

## 开发

固定 Flutter 3.44.4 / Dart 3.12.2，使用提交的 `pubspec.lock`，sodium 固定 4.0.4。Android 最低 8.0（API 26），target 36。Windows 构建需要 JDK 21 和对应 Android SDK / NDK；本机工具、Gradle、Pub 与临时缓存均已迁至 F 盘。若中文目录使工具失败，可通过指向本工程的 ASCII junction 构建。

```powershell
flutter pub get --enforce-lockfile
flutter analyze
flutter build apk --debug
```

debug 包名为 `com.agentpocket.app.debug`。默认入口为 `lib/main.dart`；`lib/preview.dart` 是只含合成数据的独立视觉预览入口，不接入真实账号。

## 功能

- 旧账号与已批准设备身份继承、已有设备重新登录、共享单次续期；首次激活、邀请、新设备核对与批准、撤销设备、扫码绑定电脑和修改密码。
- 多电脑、任务分组与搜索、Codex/Grok 筛选、未读、分页历史、流式消息、模型及推理档位、Plan/Goal、问题/审批、Diff、Desktop 唤起及任务交接。可用操作由实际 Host 和任务能力决定。
- 白色阅读区、灰色用户气泡、底部风景和输入框小角色；纸间/像素/画室同时适配字体、控件和弹窗。
- Markdown、代码复制、表格、链接，Host 授权的图片缩略图/放大、文本预览、其他文件保存/分享/系统打开。返回文件上限 32 MiB，按块落盘。
- 最多 3 个附件，单个 20 MiB、总计 60 MiB；图片、文本/代码和 PDF。支持进度、停止、显式重试续传、SHA-256。旧 Host 仍使用原小附件限制，超限明确提示升级，不压缩或截断。
- 后台常驻通知与一个应用级 Flutter 引擎；系统停止或超时后退出连接，恢复前台重新同步。未配置 FCM，不承诺进程被终止后持续推送。
- 有签名的应用更新清单、同源 HTTPS 下载、流式摘要验证、原 APK 签名与版本核验、系统安装确认。

## 升级和发送约束

正式包继续使用 `com.agentpocket.app`、原发布证书、Keystore alias `agent-pocket-relay-v2` 与 `relay_v2` 的 AES/GCM 存储；支持 `credentials:iv` 和旧 `iv`。继承设备密钥、令牌、各电脑游标、安装 ID、待绑定电脑、外观及通知偏好。读取失败保留原数据并显示恢复提示，不自动清空或创建另一台设备。

聊天、后台连接和更新检查共用 `SessionManager`。旧请求不能覆盖新登录；迟到的 401 不使新凭据失效。刷新结果未知时保留设备身份，要求重新登录，不重复消耗 refresh token。

任务写入前持久保存 operationId；结果未知只查询 `operation/get`，不自动重发。未确定的同任务操作会阻止再次发送。附件上传完成后才写任务操作记录；中断上传保留草稿，下次明确发送时先查续传状态。恢复新建回执会打开已创建的原任务。

首次登录的设备密钥在联网前加密保存。新 Relay 的 `deviceLoginRecovery: 1` 支持密码加设备签名证明找回同一设备；旧 Relay 遇到未知登录结果会要求升级，避免重复注册。

## 检验

`integration_test/` 在 Android 上运行真实 sodium 与平台接口。`test_support/channel_host.mjs` 仅监听本机 49322，使用实际 Node Host 加密和附件实现，数据均为合成内容。模拟器通过 `adb reverse tcp:49322 tcp:49322` 访问。运行迁移测试必须先安装旧 Kotlin debug 包、通过其 debug-only `LegacyMigrationActivity` 写入受限合成身份，再覆盖 Flutter debug 包；测试命令需加 `--no-uninstall`，以保留该测试身份。

纯 Dart 契约测试可用 `dart --enable-asserts test/<name>_smoke.dart` 运行。Windows 缺少 Visual Studio C++ 时，不在本机执行 sodium 原生 hook；加密测试在 Android 上运行。

最终验收及未完成的真机项目见 `../docs/ANDROID-FLUTTER-ACCEPTANCE.md`。模拟器结果不能代替真实手机验收。

已在原 Redmi K70E 上验证 0.3.5 覆盖到 0.4.0 后保留批准身份与239个任务，后台服务/前台恢复和检查更新正常。真机发现的扫码初始化错误已修复：精确保留三个 ML Kit Registrar 的无参构造，release 脚本检查 R8 seeds，规则文件纳入源码摘要；修复包已实际识别二维码并返回绑定页。

## 正式打包

`scripts/build-release.ps1` 要求当前候选源码摘要、此前发布的参考 APK、服务器最大已发布版本码、默认 Relay HTTPS 地址及 Ed25519 更新公钥 SPKI。版本固定 0.4.0，版本码取 `max(400, published + 1)`；Host/Relay 版本不联动修改。

脚本读取原 `android/keystore.properties` 和本机 DPAPI 密码文件，绝不生成替代证书。校验包名、版本、minSdk、参考 APK 证书、三种 ABI 的 Flutter/sodium 库，再输出 APK、SHA-256 和 `reviewStatus: pending / published: false` 的构建记录。源码变更后必须重新打包复核。打包成功不代表已发布：需对具体候选产物完成独立发布复核，先部署兼容 Host，再完成原版覆盖、后台和更新检查，最后登记现有服务器更新渠道。
