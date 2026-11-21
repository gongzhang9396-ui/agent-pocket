# Android Flutter 0.4.0 验收记录

工程：`mobile/`。2026-11-05 完成首个候选，随后在用户原手机继续验收。当前状态：已通过真实旧版身份继承、短时后台恢复、更新检查和扫码实测；尚未登记正式更新渠道。以下区分实际结果与待测项目，不用模拟器结果替代真机。

## 已通过

| 项目 | 证据及范围 |
| --- | --- |
| Host 回归 | Bridge 177/177；包含实际 RPC dispatch、20 MiB 边界、配额、目标/设备绑定、重复块、哈希、断点/重启续传、链接与清理、Desktop 丢回执不重复执行。日志 `output/flutter-rewrite-20261105/bridge-final.log`。 |
| Relay 回归 | 72/72；包括设备签名证明恢复、旧登录兼容、分页事件回放。日志 `relay-final.log`。 |
| Dart 基础契约 | 12 组 smoke 均通过；会话续期/迟到 401、退出后迟到响应、未知回执不重发、磁盘记录失败、编码、分页和事件回放。日志 `dart-smoke-final.log`。 |
| 代码分析 | Flutter analyze 无问题，日志 `analyze-final.log`。 |
| Android 核心集成 | 同一轮 20 项通过：旧版迁移、实际 Node/Dart Host 通道、发送/上传续传、签名更新与并发 401、模型/Plan/审批/问答、Markdown/文件预览和界面。日志 `final-integration.log`。更新安装回调在此轮为 mock，不能当成系统安装通过。 |
| Android 互通与恢复 | 补充一轮 14 项（加密向量、通道、控制器、外观）和复核专项 4 项（含成功响应后切换登录、保留原回执并恢复原任务）通过；各轮有重合，不相加计数。日志 `final-compat-integration.log`、`review-fix-integration.log`。 |
| 原生后台超时 | 任务专用 Android 模拟器中启动真实 dataSync 服务，切后台并触发系统三秒测试超时；连接正常停止、同一 Flutter 引擎保留。测试后恢复系统原超时配置。日志 `background-integration.log`。 |
| 三皮肤布局 | 纸间/像素/画室分别检查 320×640、390×844 和 640×360，真实控件无布局溢出，保存三张对话截图。此前另有横屏、大字体及键盘组合检查。日志 `visual-matrix.log`、`chat-plain/pixel/oil.png`；属于模拟器布局检查，不是帧率结论。 |
| 旧存储覆盖升级 | 真实旧 Kotlin debug APK（code302）写入受限合成身份，`adb install -r` 覆盖 Flutter debug（code400）。实际 Keystore 解密成功；credentials、旧 IV、pendingHost、安装 ID、游标7429、像素皮肤及通知关闭继承，账户密钥可完成 sodium 往返。前后凭据与待绑定密文、IV、安装 ID 不变，firstInstallTime 不变。日志/快照 `legacy-*`。 |
| 原证书正式包覆盖 | 任务专用 PocketFlutterQA 模拟器安装此前发布的 0.3.5（305）后覆盖本次正式 0.4.0（400），成功。appId=10235、dataDir、firstInstallTime 不变。该独立正式包测试未登录真实账号，不能代替批准身份迁移真机验收。证据 `release-upgrade-before/after.txt`。 |
| 正式包启动 | 实际 Release 入口显示预填 `agent.jttlkj.net` 的账号登录页，未要求先输入服务器；无 sodium/原生库启动错误。证据 `release-first-launch.png`。 |
| 原手机身份继承 | Redmi K70E（2311DRK48C，Android 16/API36）真实 0.3.5/code305→0.4.0/code400 原签名覆盖成功。appId10514、dataDir、首次安装时间 2026-08-30 15:58:59 保留，无需重新登录/批准；ZGSY9682 的 239 个任务（Codex204/Grok35）保持一致。证据 `output/flutter-device-20261105/package-before/after.txt`、`device-verification.json`。 |
| 原手机后台与更新 | 真实 PocketSyncService 为 dataSync 前台服务，切后台后仍在，返回前台恢复同一进程并保持连接；设置“检查更新”返回“已是当前版本”，未出现401。此项是短时前后台检查，不代表长期OEM保活或真实更新安装器流程通过。 |
| 原手机扫码修复 | 初始正式候选扫描页复现空引用错误；日志/旧R8输出定位为三个 ML Kit Registrar 无参构造被移除。增加三个精确保留规则及 release seeds 校验后重新原签名覆盖；相机正常打开，用户确认测试码识别并返回绑定页。未提交电脑绑定或更改设备批准。证据 `camera.xml`、`scanfix-camera.xml`、`app-log.txt`、`scanfix-app-log.txt`、`device-verification.json`。 |

早期合成迁移测试前后包名都是 `com.agentpocket.app.debug`，验证旧序列化/Keystore/AES 格式；正式包空账号覆盖另在模拟器通过。随后在用户原手机完成了真实已批准身份覆盖，239个任务可见，未要求再次登录或批准。没有替用户发送生产模型提示词、批准或撤销真实设备。

## 候选 APK 与复核

产物：`output/flutter-release-0.4.0/Agent-Pocket-0.4.0-release.apk`，79,505,608 字节，版本 0.4.0 / code400，包名 `com.agentpocket.app`，min26 / target36。三种 ABI（armeabi-v7a、arm64-v8a、x86_64）均包含 Flutter 和 sodium 原生库。

- APK SHA-256：`849d44b1f7ab530ed911faa7847359c50256ee83239d2261c827a72e5f2a7297`
- 原证书 SHA-256：`b1570de194ee3a771b65f18d1a02540c5806602a3b57875dad59d12a3579b58b`
- 最终源码摘要：`a4652dac5fe0e0929039d6ea508d5d12d03a57ccfbedd42fe52e5d8795ef7ca6`（81 个发布输入，包含扫码保留规则；精确排除 Flutter 生成的 Registrant，锁文件和手写平台层全部纳入）

用户明确授权追加一次 Sol 最终复核。其独立验证代码、全套 Host/Relay/Dart 测试、APK 签名/身份/ABI/摘要及升级证据后给出“源码/候选 APK 条件批准”。要求继续保持 `reviewStatus=pending`、`published=false`，待真机验收与实际部署条件满足后再公开发布。

Sol 复核基线为源码 `6f67e6e928446fedc0bc413ce745accf1c3e5ded181565ccd350ca43c97f4533`、APK `195bed33f87895702943b13392959dd323d7da96a7b7f4a8534a686138696914`，保存在 `reviewed-source-inventory.json` / `reviewed-candidate-6f67.apk`。此后主代理作窄屏标题间距/单行省略、身份恢复提示文案调整，并修复本轮真机发现的扫码打包问题；未改认证/协议/存储控制逻辑。扫码修复另经只读代理核验旧映射/usage与设备日志，新增精确构造保留规则、摘要输入和构建保护。最新候选已经重新签名并在原手机识码通过。最终产物以上述新摘要为准，保持待发布状态。

复核修复了：已确定失败的旧任务附件无限占配额；附件及普通写入在完整通道返回前过早清除回执；Desktop 写入丢回执误记失败；ASCII 构建与原签名路径；自动生成文件造成打包摘要漂移；Host 启动验证失败后维护闸门过早撤除。均有定向验证，最终 Bridge 177/177。

## 实现范围

账号登录/激活/邀请、原身份继承、设备批准/撤销、电脑绑定、密码修改、多电脑、任务分组/搜索/未读、历史分页/流式消息、Codex/Grok 与 Desktop/Host 能力差异、模型/推理档位、Plan/Goal、问题/审批、Diff、唤起/交接、三种外观、文件上传/预览/保存/分享/打开、后台连接、应用更新均已接入生产入口。

未知写入结果由持久 journal 和原 operationId 回执恢复。读取失败保留身份；应用不自动清空凭据、生成另一设备、重复发送写操作、压缩或截断附件。未配置 FCM；后台服务终止后需回前台恢复，不承诺无限在线。

## 发布前仍需完成

- 兼容 Host 更新及 Relay 设备恢复/分页回放代码部署；必须空闲维护、精确进程校验、备份和回滚。最近只读状态 Host 仍有活动任务，尚未中断它。
- 完成其余真机功能、实际应用内更新安装与性能验收后再登记服务器更新渠道。原手机覆盖/短时后台恢复/检查更新已通过；APK 登记前仍须重新读取服务器最大版本码。

## 真机待验

- 真实 Keystore 异常恢复故障注入；正常原设备覆盖无需重新批准已通过。
- 实际 Codex/Grok/Desktop 模型选择生效、问题/审批回传和未知结果恢复。
- 真机三附件/20 MiB、断网/重启续传、磁盘不足、取消、图片显示、保存、分享和系统打开；相机扫码已通过。
- 320/390 宽、横屏、大字体/键盘的三种皮肤视觉核验；长对话/流式回复/图片列表在 Profile 或 Release、真实 60 Hz 设备上的帧表现。
- 长时后台/OEM限制、任务通知及点击进入对应任务、实际应用内更新安装器。ADB原签名覆盖已通过。不能根据短时、debug或模拟器结果宣称性能及全部设备项目通过。

原 Kotlin 源码和签名材料保留。没有清除用户应用数据，没有联动修改 Host/Relay 版本，没有更改已上线 Web 界面或 iOS 工程。
