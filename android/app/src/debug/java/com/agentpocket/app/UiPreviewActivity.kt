package com.agentpocket.app

import android.os.Bundle
import android.net.Uri
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.lifecycleScope
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.data.model.MessageStatus
import com.agentpocket.app.data.model.Role
import com.agentpocket.app.data.model.ThreadStatus
import com.agentpocket.app.data.model.ThreadExecution
import com.agentpocket.app.data.model.ModelOption
import com.agentpocket.app.data.model.AgentAvailability
import com.agentpocket.app.data.model.HostRuntime
import com.agentpocket.app.data.model.DesktopRuntimeState
import com.agentpocket.app.data.model.TimelineItem
import com.agentpocket.app.ui.screens.InboxScreen
import com.agentpocket.app.ui.screens.NewTaskScreen
import com.agentpocket.app.ui.screens.SessionDetailScreen
import com.agentpocket.app.ui.theme.AgentPocketTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/** Uses only synthetic in-memory conversations. Never included in the release APK. */
class UiPreviewActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge(statusBarStyle = SystemBarStyle.light(0, 0), navigationBarStyle = SystemBarStyle.light(0, 0))
        val streaming = intent.getStringExtra("screen") == "stream"
        val apiPreview = intent.getStringExtra("screen") == "api"
        val grokPreview = intent.getStringExtra("screen") == "grok"
        val grokInboxPreview = intent.getStringExtra("screen") == "grok-inbox"
        val repository = if (streaming) StreamingPreviewRepository(lifecycleScope) else if (grokPreview || grokInboxPreview) GrokPreviewRepository else if (apiPreview) ApiPreviewRepository else MockPocketRepository
        setContent {
            var selectedAgentId by remember { mutableStateOf<String?>(null) }
            var newTaskAgentId by remember { mutableStateOf<String?>(null) }
            var thread by remember {
                mutableStateOf(if (streaming || intent.getStringExtra("screen") == "chat") "t-payment-tests" else null)
            }
            BackHandler(enabled = thread != null || newTaskAgentId != null) {
                if (newTaskAgentId != null) newTaskAgentId = null else thread = null
            }
            AgentPocketTheme {
                if (apiPreview || grokPreview || newTaskAgentId != null) {
                    NewTaskScreen(
                        repo = repository,
                        initialAgentId = newTaskAgentId ?: if (grokPreview) "grok" else "codex",
                        onBack = { newTaskAgentId = null },
                        onCreated = { id, agent -> newTaskAgentId = null; selectedAgentId = agent; thread = id },
                    )
                } else if (thread == null) {
                    InboxScreen(
                        repo = repository,
                        selectedAgentId = selectedAgentId,
                        onSelectAgent = { selectedAgentId = it },
                        onOpenThread = { thread = it.substringAfter('\u001f') },
                        onNewTask = { newTaskAgentId = it },
                        onOpenSettings = {},
                    )
                } else {
                    SessionDetailScreen(
                        repo = repository,
                        threadId = thread!!,
                        onBack = { thread = null },
                        onOpenDiff = {},
                    )
                }
            }
        }
    }
}

private object ApiPreviewRepository : PocketRepository by MockPocketRepository {
    override val models = MutableStateFlow(listOf(ModelOption("vendor-model", "自定义 API 模型", "使用电脑当前配置的模型", emptyList())))
    override val hostRuntimes = MutableStateFlow(mapOf(MockPocketRepository.host.value.id to HostRuntime(
        hostId = MockPocketRepository.host.value.id, desktopState = DesktopRuntimeState.Closed, bridgeReady = true,
    )))
}

private object GrokPreviewRepository : PocketRepository by MockPocketRepository {
    override val agents = MutableStateFlow(listOf(AgentAvailability("codex", true), AgentAvailability("grok", true, version = "fixture")))
    override val models = MutableStateFlow(MockPocketRepository.models.value + ModelOption("grok-fixture", "Grok 测试模型", "界面假数据，不会调用模型", emptyList(), "grok"))
    private val grokThread = MockPocketRepository.threads.value.first().copy(
        id = "grok:preview",
        title = "Grok 项目入口验证",
        status = ThreadStatus.Completed,
        lastMessage = "与 Codex 使用同一项目目录，检查分类与返回位置。",
        updatedAtEpoch = 1,
        execution = ThreadExecution(backend = "grok", owner = "host", plan = false, goal = false, handoff = false, steer = false, attachments = false),
    )
    override val threads = MutableStateFlow(listOf(grokThread) + MockPocketRepository.threads.value)
    private val grokDetail = MutableStateFlow(MockPocketRepository.threadDetail("t-payment-tests").value.copy(
        id = grokThread.id, title = grokThread.title, cwd = grokThread.cwd,
        status = ThreadStatus.Completed, activeTurnId = null, execution = grokThread.execution,
        items = listOf(TimelineItem.Message("grok-preview-reply", Role.Assistant, "Grok 项目与对话入口可用。这是本地界面预览。", MessageStatus.Done)),
    ))
    override fun threadDetail(threadId: String) = if (threadId.substringAfter('\u001f') == grokThread.id) grokDetail else MockPocketRepository.threadDetail(threadId)
}

/** Controlled layout exercise: delayed history reads and one growing Markdown reply. */
private class StreamingPreviewRepository(private val scope: CoroutineScope) : PocketRepository by MockPocketRepository {
    private val state = MutableStateFlow(MockPocketRepository.threadDetail("t-payment-tests").value.copy(
        title = "消息刷新与滚动预览", status = ThreadStatus.Idle, activeTurnId = null,
        hasEarlierMessages = true,
        items = (1..20).map { index ->
            TimelineItem.Message("history-$index", Role.Assistant, "历史消息 $index\n这一条用于检查刷新前后的阅读位置。", MessageStatus.Done)
        },
    ))
    override val refreshingThreads = MutableStateFlow<Set<String>>(emptySet())
    override fun threadDetail(threadId: String) = state
    override fun refreshThread(threadId: String) {
        scope.launch {
            refreshingThreads.value = setOf(threadId)
            delay(800)
            refreshingThreads.value = emptySet()
        }
    }
    override fun loadEarlierMessages(threadId: String) {
        scope.launch {
            state.value = state.value.copy(loadingEarlier = true)
            delay(800)
            state.value = state.value.copy(
                loadingEarlier = false, hasEarlierMessages = false,
                items = (-9..0).map { TimelineItem.Message("history-$it", Role.Assistant, "更早的消息 $it", MessageStatus.Done) } + state.value.items,
            )
        }
    }
    override fun handoffThread(threadId: String, onResult: (Boolean) -> Unit) {
        state.value = state.value.copy(execution = ThreadExecution.desktop("desktop"))
        onResult(true)
    }
    override fun sendSteer(threadId: String, text: String, planMode: Boolean, images: List<Uri>, files: List<Uri>) {
        if (state.value.activeTurnId != null) return
        scope.launch {
            val replyId = "reply-${state.value.items.size}"
            state.value = state.value.copy(status = ThreadStatus.Active, activeTurnId = "preview-turn", items = state.value.items + listOf(
                TimelineItem.Message("user-$replyId", Role.User, text, MessageStatus.Done),
                TimelineItem.Message(replyId, Role.Assistant, "正在逐段回复。\n", MessageStatus.Streaming),
            ))
            repeat(60) { index ->
                delay(400)
                state.value = state.value.copy(items = state.value.items.map {
                    if (it is TimelineItem.Message && it.id == replyId) it.copy(text = it.text + "\n${index + 1}. **流式内容**：检查自动跟随与上翻阅读互不干扰。\n") else it
                })
            }
            state.value = state.value.copy(status = ThreadStatus.Completed, activeTurnId = null, items = state.value.items.map {
                if (it is TimelineItem.Message && it.id == replyId) it.copy(status = MessageStatus.Done) else it
            })
        }
    }
}
