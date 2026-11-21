# 外观与远程启动 Codex Desktop

## 远程启动

远程启动只适用于已开机、联网且已登录 Windows 用户会话的电脑。该电脑上的 Agent Pocket Host 必须在线、启用 Desktop 集成并运行支持 `desktop-wake-safe-v2` 的版本。它不能打开关机电脑，也不能代替 Windows 登录。

在 Android 首页选择目标电脑，在电脑状态卡里使用“启动 Codex Desktop”。在 iPhone 或网页端选择电脑后，状态卡会在任务列表上方显示相同入口。旧 Host 不提供安全启动能力时，界面会提示先更新电脑端。

启动请求只会启动本机固定的 Codex Desktop 应用；它不会创建或重启任务。状态显示“已连接”需要 Desktop Attach 实际就绪，而不仅是提交了启动请求。若程序打开后长时间未连接，需要在电脑端检查 Desktop 集成和插件状态；不同 Codex Desktop 版本可能需要先打开或恢复一个任务才能建立 Attach。启动结果不确定时客户端不会自动重试。

## 外观

设置中可选“原色”“像素暮色”和“海岸油画”。每台设备分别保存选择，不与账号密钥、任务数据混合。像素和油画素材用于装饰，正文与操作区使用清晰的背景；不依赖图片表达状态或权限。

iPhone App 目前使用服务器的网页界面，网页更新后重新打开 App 即可使用新外观。Android 需要安装包含该功能的更新包。系统启动屏和 iPhone 原生外壳暂不随网页外观切换。

设计参考：[VoltAgent 设计文档库](https://github.com/SqlCoop/VoltAgent-awesome-disign-md) 用明确的视觉原则和组件状态描述设计；[Nielsen Norman Group 对 AI 原型的观察](https://www.nngroup.com/articles/ai-prototyping/) 提醒设计仍需结合产品任务、可用性与状态校验。这里参考其方法，不复制其他产品的品牌素材。
