package com.agentpocket.app.data

import android.net.Uri
import com.agentpocket.app.data.model.ApprovalDecision
import com.agentpocket.app.data.model.CommandStatus
import com.agentpocket.app.data.model.ConnectionState
import com.agentpocket.app.data.model.Device
import com.agentpocket.app.data.model.DiffFile
import com.agentpocket.app.data.model.DiffFileStatus
import com.agentpocket.app.data.model.DiffHunk
import com.agentpocket.app.data.model.DiffLine
import com.agentpocket.app.data.model.DiffLineKind
import com.agentpocket.app.data.model.Host
import com.agentpocket.app.data.model.HostRuntime
import com.agentpocket.app.data.model.DesktopRuntimeState
import com.agentpocket.app.data.model.MessageStatus
import com.agentpocket.app.data.model.ModelOption
import com.agentpocket.app.data.model.PlanStatus
import com.agentpocket.app.data.model.PlanStep
import com.agentpocket.app.data.model.Project
import com.agentpocket.app.data.model.ReasoningOption
import com.agentpocket.app.data.model.Role
import com.agentpocket.app.data.model.StepStatus
import com.agentpocket.app.data.model.ThreadDetail
import com.agentpocket.app.data.model.ThreadStatus
import com.agentpocket.app.data.model.ThreadSummary
import com.agentpocket.app.data.model.TimelineItem
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Offline in-memory repository with deterministic data. Used by Compose previews
 * and as the temporary composition root in MainActivity until Codex wires in
 * RpcPocketRepository. Nothing here talks to a network.
 */
object MockPocketRepository : PocketRepository {

    private val _host = MutableStateFlow(
        Host(
            id = "host-desktop-01",
            name = "TEST-DESKTOP（Windows）",
            wssUrl = "wss://agent.example.com/high-entropy-path",
            connectionState = ConnectionState.Connected,
            lastSeen = "刚刚",
            relayName = "东京中继",
        ),
    )
    override val host: StateFlow<Host> = _host.asStateFlow()
    override val hosts: StateFlow<List<Host>> = MutableStateFlow(listOf(_host.value)).asStateFlow()
    override val hostRuntimes: StateFlow<Map<String, HostRuntime>> = MutableStateFlow(
        mapOf(
            _host.value.id to HostRuntime(
                hostId = _host.value.id,
                desktopState = DesktopRuntimeState.Ready,
                attachReady = true,
                processRunning = true,
                canWake = false,
            ),
        ),
    ).asStateFlow()
    override val selectedHostId: StateFlow<String?> = MutableStateFlow<String?>(_host.value.id).asStateFlow()

    private val _device = MutableStateFlow(
        Device(
            id = "dev-pixel-01",
            name = "Pixel 8 Pro（本机）",
            pairedAt = "2026-08-20 21:14",
            notificationEnabled = true,
        ),
    )
    override val device: StateFlow<Device> = _device.asStateFlow()
    override val accountDevices: StateFlow<List<Device>> = MutableStateFlow(listOf(_device.value)).asStateFlow()

    private val _isPaired = MutableStateFlow(true)
    override val isPaired: StateFlow<Boolean> = _isPaired.asStateFlow()
    override val authStatus: StateFlow<String> = MutableStateFlow("已登录").asStateFlow()

    override val actionError: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()
    override val creatingTask: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()
    override val syncing: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()
    override val syncStatus: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()
    override val refreshingThreads: StateFlow<Set<String>> = MutableStateFlow(emptySet<String>()).asStateFlow()

    override val projects: StateFlow<List<Project>> = MutableStateFlow(listOf(
        Project("proj-agent-pocket", "agent-pocket", "C:\\workspace\\agent-pocket"),
        Project("proj-bridge", "codex-bridge", "C:\\workspace\\codex-bridge"),
        Project("proj-notes", "notes-api", "C:\\workspace\\notes-api"),
    )).asStateFlow()
    override val projectsLoading: StateFlow<Boolean> = MutableStateFlow(false).asStateFlow()
    override val projectsError: StateFlow<String?> = MutableStateFlow<String?>(null).asStateFlow()

    override val models: StateFlow<List<ModelOption>> = MutableStateFlow(listOf(
        ModelOption(
            id = "gpt-5.3-codex",
            label = "GPT-5.3 Codex",
            description = "默认编程模型，适合大多数重构与调试任务。",
            reasoningOptions = listOf(
                ReasoningOption("low", "低", "快速响应，适合小改动"),
                ReasoningOption("medium", "中", "速度与深度的平衡"),
                ReasoningOption("high", "高", "复杂任务的多步推理"),
            ),
        ),
        ModelOption(
            id = "gpt-5.3-codex-max",
            label = "GPT-5.3 Codex Max",
            description = "最高推理档位，适合跨模块的大型改动。",
            reasoningOptions = listOf(
                ReasoningOption("medium", "中", "较长的思考预算"),
                ReasoningOption("high", "高", "深度推理"),
                ReasoningOption("xhigh", "极高", "最长思考预算，耗时显著增加"),
            ),
        ),
        ModelOption(
            id = "codex-mini",
            label = "Codex Mini",
            description = "轻量快速，适合格式化、重命名等小任务。",
            reasoningOptions = listOf(
                ReasoningOption("low", "低", "几乎无额外推理开销"),
                ReasoningOption("medium", "中", "轻度推理"),
            ),
        ),
    )).asStateFlow()

    // region Inbox

    private val _threads = MutableStateFlow(
        listOf(
            ThreadSummary(
                id = "t-refactor-login",
                title = "重构登录模块的错误处理",
                cwd = "C:\\workspace\\agent-pocket",
                status = ThreadStatus.Active,
                updatedAt = "2 分钟前",
                lastMessage = "正在替换 AuthError 的分支逻辑，接下来会运行受影响的测试。",
                unreadCount = 0,
            ),
            ThreadSummary(
                id = "t-payment-tests",
                title = "为支付回调补充单元测试",
                cwd = "C:\\workspace\\notes-api",
                status = ThreadStatus.NeedsAttention,
                updatedAt = "18 分钟前",
                lastMessage = "需要审批：在沙箱外执行 cargo test --package billing",
                unreadCount = 2,
            ),
            ThreadSummary(
                id = "t-theme-flicker",
                title = "修复设置页深色模式闪烁",
                cwd = "C:\\workspace\\agent-pocket",
                status = ThreadStatus.Completed,
                updatedAt = "1 小时前",
                lastMessage = "已定位到主题重组问题，改动 3 个文件，全部测试通过。",
                unreadCount = 1,
            ),
            ThreadSummary(
                id = "t-gradle-cache",
                title = "同步 Gradle 依赖缓存",
                cwd = "C:\\workspace\\codex-bridge",
                status = ThreadStatus.Idle,
                updatedAt = "昨天 23:40",
                lastMessage = "主机连接中断，恢复后可继续。",
                unreadCount = 0,
            ),
            ThreadSummary(
                id = "t-desktop-session",
                title = "重构会话存储层",
                cwd = "C:\\workspace\\codex-bridge",
                status = ThreadStatus.ExternalBusy,
                updatedAt = "35 分钟前",
                lastMessage = "该会话正在桌面端 Codex 中运行，移动端仅可查看。",
                unreadCount = 0,
            ),
        ),
    )
    override val threads: StateFlow<List<ThreadSummary>> = _threads.asStateFlow()

    // endregion

    // region Thread details

    private val details = mutableMapOf<String, MutableStateFlow<ThreadDetail>>()

    init {
        details["t-refactor-login"] = MutableStateFlow(
            ThreadDetail(
                id = "t-refactor-login",
                title = "重构登录模块的错误处理",
                cwd = "C:\\workspace\\agent-pocket",
                status = ThreadStatus.Active,
                activeTurnId = "turn-41",
                items = listOf(
                    TimelineItem.Message(
                        id = "m1",
                        role = Role.User,
                        text = "登录模块现在把网络错误和凭据错误混在一起处理，帮我拆开，并保持现有 UI 行为不变。",
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Plan(
                        id = "p1",
                        status = PlanStatus.InProgress,
                        steps = listOf(
                            PlanStep(1, "梳理 AuthError 的所有分支与调用点", StepStatus.Done),
                            PlanStep(2, "引入 NetworkError / CredentialError 细分类型", StepStatus.Done),
                            PlanStep(3, "替换 LoginViewModel 中的分发逻辑", StepStatus.InProgress),
                            PlanStep(4, "运行受影响的单元测试", StepStatus.Pending),
                        ),
                    ),
                    TimelineItem.Command(
                        id = "c1",
                        label = "rg \"AuthError\" app/src/main",
                        cwd = "C:\\workspace\\agent-pocket",
                        status = CommandStatus.Succeeded,
                        output = "app/src/main/auth/LoginViewModel.kt:47: when (e) {\n" +
                            "app/src/main/auth/LoginViewModel.kt:52: is AuthError ->\n" +
                            "app/src/main/auth/SessionStore.kt:18: throw AuthError.Expired\n" +
                            "app/src/test/auth/LoginViewModelTest.kt:33: AuthError.Invalid",
                        truncated = false,
                    ),
                    TimelineItem.Message(
                        id = "m2",
                        role = Role.Assistant,
                        text = "已确认 AuthError 只在三处被真正消费。我将新增细分类型的同时保留 AuthError 作为公共父类，" +
                            "这样 UI 层的 when 分支不需要改动。现在正在改写 LoginViewModel 的分发逻辑",
                        status = MessageStatus.Streaming,
                    ),
                ),
            ),
        )

        details["t-payment-tests"] = MutableStateFlow(
            ThreadDetail(
                id = "t-payment-tests",
                title = "为支付回调补充单元测试",
                cwd = "C:\\workspace\\notes-api",
                status = ThreadStatus.NeedsAttention,
                activeTurnId = null,
                items = listOf(
                    TimelineItem.Message(
                        id = "m1",
                        role = Role.User,
                        text = "billing 包的回调处理没有任何测试，补一组覆盖签名验证失败、重复通知、金额不一致的单测。",
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Plan(
                        id = "p1",
                        status = PlanStatus.InProgress,
                        steps = listOf(
                            PlanStep(1, "阅读 billing 包回调入口", StepStatus.Done),
                            PlanStep(2, "搭建测试夹具与假签名器", StepStatus.Done),
                            PlanStep(3, "编写三类失败场景用例", StepStatus.Done),
                            PlanStep(4, "运行 billing 包测试并修复失败", StepStatus.InProgress),
                        ),
                    ),
                    TimelineItem.Command(
                        id = "c1",
                        label = "cargo test --package billing",
                        cwd = "C:\\workspace\\notes-api",
                        status = CommandStatus.Failed,
                        output = "running 6 tests\n" +
                            "test callback::rejects_bad_signature ... ok\n" +
                            "test callback::rejects_amount_mismatch ... ok\n" +
                            "test callback::dedupes_repeated_notify ... FAILED\n" +
                            "test callback::accepts_valid_notify ... ok\n" +
                            "test callback::retries_on_timeout ... ok\n" +
                            "test callback::logs_unknown_event ... ok\n" +
                            "\n" +
                            "failures:\n" +
                            "---- callback::dedupes_repeated_notify stdout ----\n" +
                            "thread 'callback::dedupes_repeated_notify' panicked at\n" +
                            "'assertion failed: store.seen_count(\"n_123\") == 1',\n" +
                            "src/billing/callback.rs:214:9\n" +
                            "note: run with `RUST_BACKTRACE=1` for a backtrace\n" +
                            "\n" +
                            "test result: FAILED. 5 passed; 1 failed; 0 ignored",
                        truncated = true,
                    ),
                    TimelineItem.Message(
                        id = "m2",
                        role = Role.Assistant,
                        text = "去重用例失败：重复通知被计了两次。根因是 seen_count 在落库前先自增。" +
                            "我需要调整 callback.rs 中的写入顺序，并重新运行测试。",
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Question(
                        id = "q1",
                        requestId = "req-q-9",
                        questionId = "callback-semantics",
                        prompt = "重复通知应该返回 200（幂等确认）还是 409（冲突）？",
                        options = listOf("返回 200，保持幂等", "返回 409，明确冲突", "由你按现有代码风格决定"),
                    ),
                    TimelineItem.Approval(
                        id = "a1",
                        requestId = "req-a-4",
                        summary = "需要在沙箱外执行测试以访问本地数据库容器。",
                        command = "cargo test --package billing -- --nocapture",
                        cwd = "C:\\workspace\\notes-api",
                    ),
                ),
            ),
        )

        details["t-theme-flicker"] = MutableStateFlow(
            ThreadDetail(
                id = "t-theme-flicker",
                title = "修复设置页深色模式闪烁",
                cwd = "C:\\workspace\\agent-pocket",
                status = ThreadStatus.Completed,
                activeTurnId = null,
                items = listOf(
                    TimelineItem.Message(
                        id = "m1",
                        role = Role.User,
                        text = "设置页切换深色模式时会闪一下浅色背景，帮我修掉。",
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Message(
                        id = "m2",
                        role = Role.Assistant,
                        text = "根因是主题状态在 Activity 重建期间回退到了默认值。我把主题读取改为从" +
                            " DataStore 冷启动，并在重组前阻塞首帧。改动 3 个文件，测试全部通过。",
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Command(
                        id = "c1",
                        label = "gradlew :app:testDebugUnitTest",
                        cwd = "C:\\workspace\\agent-pocket",
                        status = CommandStatus.Succeeded,
                        output = "BUILD SUCCESSFUL in 41s\n87 tests completed, 0 failed",
                        truncated = false,
                    ),
                ),
            ),
        )

        details["t-gradle-cache"] = MutableStateFlow(
            ThreadDetail(
                id = "t-gradle-cache",
                title = "同步 Gradle 依赖缓存",
                cwd = "C:\\workspace\\codex-bridge",
                status = ThreadStatus.Idle,
                activeTurnId = null,
                items = listOf(
                    TimelineItem.Message(
                        id = "m1",
                        role = Role.System,
                        text = "主机连接已断开。中继恢复后，该会话可继续。",
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Message(
                        id = "m2",
                        role = Role.Assistant,
                        text = "已比对本地与远程缓存清单，剩余 12 个构件待同步。",
                        status = MessageStatus.Interrupted,
                    ),
                ),
            ),
        )

        details["t-desktop-session"] = MutableStateFlow(
            ThreadDetail(
                id = "t-desktop-session",
                title = "重构会话存储层",
                cwd = "C:\\workspace\\codex-bridge",
                status = ThreadStatus.ExternalBusy,
                activeTurnId = "turn-desktop-7",
                items = listOf(
                    TimelineItem.Message(
                        id = "m1",
                        role = Role.System,
                        text = "该会话正在桌面端 Codex 中运行。移动端仅可查看，操作请在桌面端完成。",
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Message(
                        id = "m2",
                        role = Role.User,
                        text = "把会话存储从 JSON 文件迁移到 SQLite，保留导入旧数据的脚本。",
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Message(
                        id = "m3",
                        role = Role.Assistant,
                        text = "迁移脚本已完成，正在桌面端执行全量回归",
                        status = MessageStatus.Streaming,
                    ),
                ),
            ),
        )
    }

    override fun threadDetail(threadId: String): StateFlow<ThreadDetail> =
        details.getOrPut(threadId) {
            MutableStateFlow(
                ThreadDetail(
                    id = threadId,
                    title = "新任务",
                    cwd = "",
                    status = ThreadStatus.Active,
                    items = emptyList(),
                    activeTurnId = null,
                ),
            )
        }.asStateFlow()

    // endregion

    // region Diffs

    private val diffs: Map<String, List<DiffFile>> = mapOf(
        "t-theme-flicker" to themeFlickerDiff(),
        "t-payment-tests" to paymentTestsDiff(),
    )

    override fun threadDiff(threadId: String): StateFlow<List<DiffFile>> =
        MutableStateFlow(diffs[threadId] ?: themeFlickerDiff()).asStateFlow()

    override fun openNotification(hostId: String, eventId: String, onResolved: (String?) -> Unit) = onResolved(null)

    private fun themeFlickerDiff(): List<DiffFile> = listOf(
        DiffFile(
            path = "app/src/main/java/com/agentpocket/app/ui/theme/Theme.kt",
            status = DiffFileStatus.Modified,
            additions = 14,
            deletions = 3,
            truncated = false,
            hunks = listOf(
                DiffHunk(
                    header = "@@ -18,7 +18,17 @@ fun AgentPocketTheme(",
                    lines = listOf(
                        DiffLine(DiffLineKind.Context, "fun AgentPocketTheme("),
                        DiffLine(DiffLineKind.Context, "    content: @Composable () -> Unit,"),
                        DiffLine(DiffLineKind.Context, ") {"),
                        DiffLine(DiffLineKind.Delete, "    val darkTheme = isSystemInDarkTheme()"),
                        DiffLine(DiffLineKind.Delete, "    val scheme = if (darkTheme) DarkScheme else LightScheme"),
                        DiffLine(DiffLineKind.Add, "    val themeState by ThemeController.state.collectAsState()"),
                        DiffLine(DiffLineKind.Add, "    // 冷启动期间阻塞首帧，避免主题切换闪烁"),
                        DiffLine(DiffLineKind.Add, "    if (!themeState.ready) {"),
                        DiffLine(DiffLineKind.Add, "        Box(Modifier.fillMaxSize().background(DarkScheme.background))"),
                        DiffLine(DiffLineKind.Add, "        return"),
                        DiffLine(DiffLineKind.Add, "    }"),
                        DiffLine(DiffLineKind.Add, "    val scheme = if (themeState.dark) DarkScheme else LightScheme"),
                        DiffLine(DiffLineKind.Context, "    MaterialTheme(colorScheme = scheme, content = content)"),
                        DiffLine(DiffLineKind.Context, "}"),
                    ),
                ),
            ),
        ),
        DiffFile(
            path = "app/src/main/java/com/agentpocket/app/ui/theme/ThemeController.kt",
            status = DiffFileStatus.Added,
            additions = 32,
            deletions = 0,
            truncated = false,
            hunks = listOf(
                DiffHunk(
                    header = "@@ -0,0 +1,32 @@",
                    lines = listOf(
                        DiffLine(DiffLineKind.Add, "package com.agentpocket.app.ui.theme"),
                        DiffLine(DiffLineKind.Add, ""),
                        DiffLine(DiffLineKind.Add, "object ThemeController {"),
                        DiffLine(DiffLineKind.Add, "    private val _state = MutableStateFlow(ThemeState(ready = false))"),
                        DiffLine(DiffLineKind.Add, "    val state: StateFlow<ThemeState> = _state.asStateFlow()"),
                        DiffLine(DiffLineKind.Add, ""),
                        DiffLine(DiffLineKind.Add, "    suspend fun warmUp(store: DataStore<Preferences>) {"),
                        DiffLine(DiffLineKind.Add, "        val dark = store.data.first()[KEY_DARK] ?: true"),
                        DiffLine(DiffLineKind.Add, "        _state.value = ThemeState(ready = true, dark = dark)"),
                        DiffLine(DiffLineKind.Add, "    }"),
                        DiffLine(DiffLineKind.Add, "}"),
                    ),
                ),
            ),
        ),
        DiffFile(
            path = "app/src/main/java/com/agentpocket/app/legacy/LegacyThemeBridge.kt",
            status = DiffFileStatus.Deleted,
            additions = 0,
            deletions = 48,
            truncated = false,
            hunks = listOf(
                DiffHunk(
                    header = "@@ -1,48 +0,0 @@",
                    lines = listOf(
                        DiffLine(DiffLineKind.Delete, "package com.agentpocket.app.legacy"),
                        DiffLine(DiffLineKind.Delete, ""),
                        DiffLine(DiffLineKind.Delete, "// 已被 ThemeController 取代"),
                        DiffLine(DiffLineKind.Delete, "object LegacyThemeBridge {"),
                        DiffLine(DiffLineKind.Delete, "    fun apply(activity: Activity) { /* ... */ }"),
                        DiffLine(DiffLineKind.Delete, "}"),
                    ),
                ),
            ),
        ),
        DiffFile(
            path = "app/src/test/java/com/agentpocket/app/ui/theme/ThemeControllerTest.kt",
            status = DiffFileStatus.Renamed,
            additions = 128,
            deletions = 12,
            truncated = true,
            hunks = listOf(
                DiffHunk(
                    header = "@@ -1,12 +1,40 @@ class ThemeControllerTest",
                    lines = listOf(
                        DiffLine(DiffLineKind.Context, "class ThemeControllerTest {"),
                        DiffLine(DiffLineKind.Delete, "    @Test fun togglesTheme() { /* ... */ }"),
                        DiffLine(DiffLineKind.Add, "    @Test fun `冷启动时保持深色直到 DataStore 就绪`() { /* ... */ }"),
                        DiffLine(DiffLineKind.Add, "    @Test fun `切换主题不再触发 Activity 重建`() { /* ... */ }"),
                        DiffLine(DiffLineKind.Add, "    // ... 其余 124 行新增用例 ..."),
                        DiffLine(DiffLineKind.Context, "}"),
                    ),
                ),
            ),
        ),
    )

    private fun paymentTestsDiff(): List<DiffFile> = listOf(
        DiffFile(
            path = "src/billing/callback.rs",
            status = DiffFileStatus.Modified,
            additions = 22,
            deletions = 6,
            truncated = false,
            hunks = listOf(
                DiffHunk(
                    header = "@@ -198,9 +198,25 @@ pub async fn handle_notify(",
                    lines = listOf(
                        DiffLine(DiffLineKind.Context, "    let seen = store.seen_count(&notify.id);"),
                        DiffLine(DiffLineKind.Delete, "    store.mark_seen(&notify.id).await?;"),
                        DiffLine(DiffLineKind.Delete, "    if seen > 0 {"),
                        DiffLine(DiffLineKind.Delete, "        return Ok(StatusCode::OK);"),
                        DiffLine(DiffLineKind.Add, "    if seen > 0 {"),
                        DiffLine(DiffLineKind.Add, "        // 幂等确认：重复通知直接返回 200，不再重复计数"),
                        DiffLine(DiffLineKind.Add, "        metrics::increment!(\"billing.duplicate_notify\");"),
                        DiffLine(DiffLineKind.Add, "        return Ok(StatusCode::OK);"),
                        DiffLine(DiffLineKind.Context, "    }"),
                        DiffLine(DiffLineKind.Add, "    store.mark_seen(&notify.id).await?;"),
                        DiffLine(DiffLineKind.Add, "    store.persist(&notify).await?;"),
                        DiffLine(DiffLineKind.Context, "    Ok(StatusCode::OK)"),
                    ),
                ),
            ),
        ),
        DiffFile(
            path = "src/billing/callback_test.rs",
            status = DiffFileStatus.Added,
            additions = 96,
            deletions = 0,
            truncated = true,
            hunks = listOf(
                DiffHunk(
                    header = "@@ -0,0 +1,96 @@",
                    lines = listOf(
                        DiffLine(DiffLineKind.Add, "#[tokio::test]"),
                        DiffLine(DiffLineKind.Add, "async fn dedupes_repeated_notify() {"),
                        DiffLine(DiffLineKind.Add, "    let store = FakeStore::default();"),
                        DiffLine(DiffLineKind.Add, "    let notify = signed_notify(\"n_123\", 4096);"),
                        DiffLine(DiffLineKind.Add, "    handle_notify(&store, notify.clone()).await.unwrap();"),
                        DiffLine(DiffLineKind.Add, "    handle_notify(&store, notify).await.unwrap();"),
                        DiffLine(DiffLineKind.Add, "    assert_eq!(store.seen_count(\"n_123\"), 1);"),
                        DiffLine(DiffLineKind.Add, "}"),
                        DiffLine(DiffLineKind.Add, "// ... 其余 88 行已省略"),
                    ),
                ),
            ),
        ),
    )

    // endregion

    // region Actions

    private var createdCount = 0

    override fun refreshProjects() = Unit
    override fun refreshHostRuntime(hostId: String) = Unit
    override fun launchDesktop(hostId: String) = Unit
    override fun hostSupports(capability: String, hostId: String?): Boolean = true
    override fun refreshAll() = Unit
    override fun refreshThread(threadId: String) = Unit
    override fun setActiveThread(threadId: String?) = Unit
    override fun threadGoal(threadId: String, onResult: (String?) -> Unit) = onResult(null)
    override fun setThreadGoal(threadId: String, objective: String, onResult: (String?) -> Unit) = onResult(objective)
    override fun clearThreadGoal(threadId: String, onResult: (String?) -> Unit) = onResult(null)
    override fun selectHost(hostId: String?) = Unit
    override fun lastTaskTarget(): String = "bridge"

    override fun createTask(
        projectId: String,
        modelId: String,
        reasoningId: String,
        prompt: String,
        target: String,
        planMode: Boolean,
        goal: String?,
        images: List<Uri>,
        files: List<Uri>,
        onCreated: (String) -> Unit,
    ) {
        createdCount += 1
        val id = "t-created-$createdCount"
        val project = projects.value.firstOrNull { it.id == projectId } ?: projects.value.first()
        val model = models.value.firstOrNull { it.id == modelId } ?: models.value.first()
        val reasoning = model.reasoningOptions.firstOrNull { it.id == reasoningId }
            ?: model.reasoningOptions.first()

        val summary = ThreadSummary(
            id = id,
            title = prompt.lineSequence().first().take(24).ifBlank { "新任务" },
            cwd = project.cwd,
            status = ThreadStatus.Active,
            updatedAt = "刚刚",
            lastMessage = "任务已创建，Codex 正在分析需求。",
            unreadCount = 0,
        )
        _threads.value = listOf(summary) + _threads.value

        details[id] = MutableStateFlow(
            ThreadDetail(
                id = id,
                title = summary.title,
                cwd = project.cwd,
                status = ThreadStatus.Active,
                activeTurnId = "turn-new-$createdCount",
                items = listOf(
                    TimelineItem.Message(
                        id = "m1",
                        role = Role.User,
                        text = prompt,
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Message(
                        id = "m2",
                        role = Role.System,
                        text = "模型 ${model.label} · 推理强度「${reasoning.label}」 · 工作目录 ${project.cwd}",
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Message(
                        id = "m3",
                        role = Role.Assistant,
                        text = "任务已接收，正在分析需求…",
                        status = MessageStatus.Streaming,
                    ),
                ),
            ),
        )
        onCreated(id)
    }

    override fun sendSteer(threadId: String, text: String, planMode: Boolean, images: List<Uri>, files: List<Uri>) {
        updateDetail(threadId) { detail ->
            val n = detail.items.size
            detail.copy(
                items = detail.items + listOf(
                    TimelineItem.Message(
                        id = "steer-u-$n",
                        role = Role.User,
                        text = text,
                        status = MessageStatus.Done,
                    ),
                    TimelineItem.Message(
                        id = "steer-a-$n",
                        role = Role.Assistant,
                        text = "已收到调整指令，将在当前任务中纳入该约束。",
                        status = MessageStatus.Streaming,
                    ),
                ),
            )
        }
    }

    override fun interruptTurn(threadId: String) {
        updateDetail(threadId) { detail ->
            detail.copy(
                activeTurnId = null,
                items = detail.items.map { item ->
                    if (item is TimelineItem.Message && item.status == MessageStatus.Streaming) {
                        item.copy(status = MessageStatus.Interrupted)
                    } else {
                        item
                    }
                } + TimelineItem.Message(
                    id = "interrupt-${detail.items.size}",
                    role = Role.System,
                    text = "已中断当前执行。",
                    status = MessageStatus.Done,
                ),
            )
        }
    }

    override fun resolveApproval(threadId: String, requestId: String, decision: ApprovalDecision) {
        updateDetail(threadId) { detail ->
            detail.copy(
                items = detail.items.map { item ->
                    if (item is TimelineItem.Approval && item.requestId == requestId) {
                        item.copy(decision = decision)
                    } else {
                        item
                    }
                },
            )
        }
    }

    override fun answerQuestion(threadId: String, requestId: String, questionId: String, option: String) {
        updateDetail(threadId) { detail ->
            detail.copy(
                items = detail.items.map { item ->
                    if (item is TimelineItem.Question && item.requestId == requestId && item.questionId == questionId) {
                        item.copy(selectedOption = option)
                    } else {
                        item
                    }
                },
            )
        }
    }

    override fun pairManually(wssUrl: String, pairingCode: String) {
        if (wssUrl.isBlank() || pairingCode.isBlank()) return
        _host.value = _host.value.copy(
            wssUrl = wssUrl.trim(),
            connectionState = ConnectionState.Connected,
            lastSeen = "刚刚",
        )
        _isPaired.value = true
    }

    override fun pairFromQr(payload: String) = pairManually("wss://agent.example.com/high-entropy-path", payload)
    override fun login(relayUrl: String, username: String, password: String) = pairManually(relayUrl, password)
    override fun claimInvite(inviteUrl: String, relayUrl: String, username: String, displayName: String, password: String) = pairManually(relayUrl, inviteUrl)
    override fun approveHostFromQr(payload: String, name: String?) = Unit
    override fun approveDevice(deviceId: String) = Unit
    override fun revokeAccountDevice(deviceId: String) = Unit

    override fun resetPairing() {
        _isPaired.value = false
    }

    override fun setNotificationsEnabled(enabled: Boolean) {
        _device.value = _device.value.copy(notificationEnabled = enabled)
    }

    override fun clearActionError() = Unit

    private inline fun updateDetail(threadId: String, transform: (ThreadDetail) -> ThreadDetail) {
        val flow = details[threadId] ?: return
        flow.value = transform(flow.value)
    }

    // endregion
}
