# 手机端模型控制

打开对话，点击输入框上方的 **模型 · 沿用会话**，选择模型和推理强度后发送下一条消息。选择保存在当前任务的草稿中，关闭面板不会应用到电脑；发送失败会保留文本与选择。选择“沿用会话设置”可以清除待应用的覆盖参数。

| 执行方式 | 续聊控制 |
| --- | --- |
| Codex Host | 支持。参数随下一次 `turn/start` 传给原任务，保留上下文。运行中的 `turn/steer` 不切换模型。 |
| Grok CLI | 支持模型和推理档位。使用同一个原生 session ID，设置也对连接该会话的电脑客户端生效。 |
| Codex Desktop | 支持。新版 Desktop Attach 把选择作为下一条队列消息的 `model`/`effort` 覆盖传给原任务；不重启任务，也不丢失上下文。 |
| 旧 Host | 没有声明 `model-control-v1` 时不启用选择，请配套更新 Host。 |
| 旧 Desktop Attach | 没有声明 `thread/send-model-v1` 时不启用 Desktop 任务选择，并提示更新后新建一个电脑任务，不会悄悄忽略选择。 |

模型目录从任务所属的 Host 读取，不依赖首页当前选中的电脑。Codex 目录来自 `model/list` 与电脑的有效配置；Grok 目录来自 CLI 握手。代码不写死生产模型名称，推理档位随模型变化。模型服务是否接受目录中的某个模型，仍由电脑当前连接的服务决定。

`thread/model-options` 是读取接口，返回 `data`、`currentModel`、`currentEffort`、`controlScope` 和可选的 `reason`/`warning`。读取不会恢复或认领任务 writer，也不会加载 Grok 用户会话。Grok 当前值来自原生 summary；Codex 优先使用原生任务元数据，否则使用本次 Host 运行中已确认的设置。当前值缺失时显示“当前设置由会话保留”，不会把全局默认值冒充当前任务模型。

只有用户明确选择后，发送参数才包含 `model`/`effort`。运行状态变化使请求变成 steer 时，手机与 Host 都拒绝模型覆盖；参数不会被静默丢弃。Codex Desktop 任务由 Host 重新校验模型目录，再由具备 `thread/send-model-v1` 的插件映射为 `codex queue --model` 与 `model_reasoning_effort`；旧插件按能力协商失败关闭。Grok 会先恢复会话、校验目录、调用 `session/set_model` 并等待真实设置确认，成功后才发送提示词。CLI 响应与模型变化通知可能先后乱序，不能只用第一次通知或空成功响应判定设置生效。

Grok 的设置属于整个共享会话，不提供队列中逐条消息独立的模型覆盖；两端同时更改时遵循 CLI 自身的最后一次修改。该能力不切换 Agent、账号、模型提供商或全局配置。

同一版还补充了[手机问答与审批同步](MOBILE-INTERACTIONS.md)。Desktop 的异步问题可以在手机回答；执行审批仍受 Desktop 对外接口限制。
