package com.agentpocket.app.data

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import com.agentpocket.app.BridgeSyncService
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
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.net.URI
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient

private const val MAX_COMMAND_OUTPUT_CHARS = 256 * 1024
private data class QueuedBridgeEvent(val generation: Long, val event: JsonObject)

class RpcPocketRepository(private val context: Context) : PocketRepository {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val secure = SecurePrefs(context)
    private val http = OkHttpClient.Builder().pingInterval(20, TimeUnit.SECONDS).build()
    private val details = mutableMapOf<String, MutableStateFlow<ThreadDetail>>()
    private val diffs = mutableMapOf<String, MutableStateFlow<List<DiffFile>>>()
    private val ownedTurns = mutableMapOf<String, String>()
    private val questionCounts = mutableMapOf<String, Int>()
    private val pendingAnswers = mutableMapOf<String, MutableMap<String, String>>()
    private val eventChannel = Channel<QueuedBridgeEvent>(Channel.UNLIMITED)
    private val deltaBuffers = mutableMapOf<Pair<String, String>, StringBuilder>()
    private val deltaJobs = mutableMapOf<Pair<String, String>, Job>()
    private val threadReadGenerations = mutableMapOf<String, Long>()
    private var threadListGeneration = 0L
    private var rpc: BridgeRpcClient? = null
    private var connectionJob: Job? = null
    private var fcmToken: String? = null
    private var pausedForLimit = false
    private val connectionGeneration = AtomicLong(0)

    private val _host = MutableStateFlow(
        Host("", "Windows Codex", secure.load()?.endpoint.orEmpty(), ConnectionState.Disconnected, "尚未连接", "东京中继"),
    )
    override val host: StateFlow<Host> = _host.asStateFlow()

    private val settings = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val _device = MutableStateFlow(Device(secure.load()?.deviceId.orEmpty(), Build.MODEL, "", settings.getBoolean("notifications", true)))
    override val device: StateFlow<Device> = _device.asStateFlow()

    private val _isPaired = MutableStateFlow(secure.load() != null)
    override val isPaired: StateFlow<Boolean> = _isPaired.asStateFlow()

    private val _threads = MutableStateFlow<List<ThreadSummary>>(emptyList())
    override val threads: StateFlow<List<ThreadSummary>> = _threads.asStateFlow()

    private val _projects = MutableStateFlow<List<Project>>(emptyList())
    override val projects: StateFlow<List<Project>> = _projects.asStateFlow()

    private val _models = MutableStateFlow<List<ModelOption>>(emptyList())
    override val models: StateFlow<List<ModelOption>> = _models.asStateFlow()

    private val _actionError = MutableStateFlow<String?>(null)
    override val actionError: StateFlow<String?> = _actionError.asStateFlow()

    private val _creatingTask = MutableStateFlow(false)
    override val creatingTask: StateFlow<Boolean> = _creatingTask.asStateFlow()

    init {
        scope.launch {
            for (queued in eventChannel) {
                if (queued.generation != connectionGeneration.get()) continue
                runCatching { processEvent(queued.event) }
                    .onFailure { _actionError.value = "收到一条无法解析的任务更新，已忽略：${it.message ?: "格式不兼容"}" }
            }
        }
        val connectivity = context.getSystemService(ConnectivityManager::class.java)
        connectivity.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) { if (!pausedForLimit) reconnect() }
            override fun onLost(network: Network) { rpc?.close() }
        })
        if (_isPaired.value) reconnect()
    }

    fun resume() {
        pausedForLimit = false
        if (_isPaired.value) {
            BridgeSyncService.start(context)
            reconnect()
        }
    }

    fun pauseForBackgroundLimit() {
        pausedForLimit = true
        connectionGeneration.incrementAndGet()
        connectionJob?.cancel()
        rpc?.close()
        setConnection(ConnectionState.Disconnected, "后台长连接已暂停，将通过通知提醒")
    }

    fun registerFcmToken(token: String) {
        fcmToken = token
        scope.launch { runCatching { rpc?.call("push/register", obj("fcmToken" to token)) } }
    }

    override fun threadDetail(threadId: String): StateFlow<ThreadDetail> {
        val flow = details.getOrPut(threadId) { MutableStateFlow(emptyDetail(threadId)) }
        scope.launch { fetchThread(threadId) }
        return flow.asStateFlow()
    }

    override fun threadDiff(threadId: String): StateFlow<List<DiffFile>> =
        diffs.getOrPut(threadId) { MutableStateFlow(emptyList()) }.asStateFlow()

    override fun createTask(
        projectId: String,
        modelId: String,
        reasoningId: String,
        prompt: String,
        onCreated: (String) -> Unit,
    ) {
        if (_creatingTask.value) return
        val project = _projects.value.firstOrNull { it.id == projectId }
        if (project == null) {
            _actionError.value = "所选项目已不可用，请返回后重试"
            return
        }
        _actionError.value = null
        _creatingTask.value = true
        scope.launch {
            try {
                val result = call(
                    "thread/start",
                    obj("cwd" to project.cwd, "text" to prompt, "model" to modelId, "effort" to reasoningId),
                ).requireObject("新建任务")
                val startedThread = result.obj("thread")
                    ?: throw BridgeRpcException("Bridge 返回的新任务缺少 thread")
                val threadId = startedThread.string("id")
                    ?: throw BridgeRpcException("Bridge 返回的新任务缺少 thread.id")
                val turnId = result.obj("turn")?.string("id")
                if (turnId != null) ownedTurns[threadId] = turnId

                val title = startedThread.string("name")
                    ?: prompt.lineSequence().firstOrNull()?.take(40).orEmpty().ifBlank { "新任务" }
                val userMessage = TimelineItem.Message(
                    id = "user-created-${System.currentTimeMillis()}",
                    role = Role.User,
                    text = prompt,
                    status = MessageStatus.Done,
                )
                details.getOrPut(threadId) { MutableStateFlow(emptyDetail(threadId)) }.value = ThreadDetail(
                    id = threadId,
                    title = title,
                    cwd = project.cwd,
                    status = ThreadStatus.Active,
                    items = listOf(userMessage),
                    activeTurnId = turnId,
                )
                _threads.value = listOf(
                    ThreadSummary(threadId, title, project.cwd, ThreadStatus.Active, "刚刚", prompt.take(120), 0),
                ) + _threads.value.filterNot { it.id == threadId }
                onCreated(threadId)
                runCatching { syncThreads() }
                fetchThread(threadId)
            } catch (error: Throwable) {
                _actionError.value = actionError("创建任务", error)
            } finally {
                _creatingTask.value = false
            }
        }
    }

    override fun sendSteer(threadId: String, text: String) {
        _actionError.value = null
        val messageId = "user-${System.currentTimeMillis()}"
        upsert(threadId, TimelineItem.Message(messageId, Role.User, text, MessageStatus.Streaming))
        scope.launch {
            val turnId = details[threadId]?.value?.activeTurnId
            try {
                val response =
                if (turnId != null) {
                    call("turn/steer", obj("threadId" to threadId, "expectedTurnId" to turnId, "text" to text))
                } else {
                    call("turn/start", obj("threadId" to threadId, "text" to text))
                }
                val result = response.asObject()
                if (result?.string("source") == "desktop") {
                    ownedTurns.remove(threadId)
                    setThreadStatus(threadId, ThreadStatus.DesktopOwned)
                } else {
                    (result?.obj("turn")?.string("id") ?: result?.string("turnId"))?.let {
                        ownedTurns[threadId] = it
                    }
                }
                updateMessageStatus(threadId, messageId, MessageStatus.Done)
                if (result?.string("source") == "desktop" && result.boolean("liveSync") != true) {
                    for (waitMs in listOf(750L, 1_500L, 3_000L)) {
                        delay(waitMs)
                        fetchThread(threadId)
                    }
                }
            } catch (error: Throwable) {
                updateMessageStatus(threadId, messageId, MessageStatus.Failed)
                _actionError.value = actionError("发送", error)
            }
        }
    }

    override fun interruptTurn(threadId: String) {
        if (isDesktopOwned(threadId)) {
            _actionError.value = "Desktop 任务暂不支持从手机中断，请在电脑端处理"
            return
        }
        val turnId = details[threadId]?.value?.activeTurnId ?: return
        scope.launch { runCatching { call("turn/interrupt", obj("threadId" to threadId, "turnId" to turnId)) } }
    }

    override fun resolveApproval(threadId: String, requestId: String, decision: ApprovalDecision) {
        if (isDesktopOwned(threadId)) {
            _actionError.value = "Desktop 任务的审批暂时需要在电脑端处理"
            return
        }
        val value = when (decision) {
            ApprovalDecision.AllowOnce -> "allowOnce"
            ApprovalDecision.Deny -> "deny"
            ApprovalDecision.Cancel -> "cancel"
        }
        scope.launch {
            runCatching { call("approval/respond", obj("requestId" to requestId, "decision" to value)) }
                .onSuccess { updateItem(threadId, requestId) { (it as TimelineItem.Approval).copy(decision = decision) } }
        }
    }

    override fun answerQuestion(threadId: String, requestId: String, questionId: String, option: String) {
        if (isDesktopOwned(threadId)) {
            _actionError.value = "Desktop 任务的问题暂时需要在电脑端回答"
            return
        }
        val collected = pendingAnswers.getOrPut(requestId) { mutableMapOf() }
        collected[questionId] = option
        val flow = details[threadId]
        if (flow != null) flow.value = flow.value.copy(items = flow.value.items.map {
            if (it is TimelineItem.Question && it.requestId == requestId && it.questionId == questionId) it.copy(selectedOption = option) else it
        })
        if (collected.size < (questionCounts[requestId] ?: 1)) return
        val answers = buildJsonObject {
            collected.forEach { (id, answer) -> put(id, buildJsonObject { put("answers", buildJsonArray { add(JsonPrimitive(answer)) }) }) }
        }
        scope.launch {
            runCatching { call("question/respond", buildJsonObject { put("requestId", requestId); put("answers", answers) }) }
                .onSuccess { pendingAnswers.remove(requestId); questionCounts.remove(requestId) }
        }
    }

    override fun pairManually(wssUrl: String, pairingCode: String) {
        val raw = pairingCode.trim()
        if (raw.startsWith("agentpocket://", ignoreCase = true)) {
            return pairFromQr(raw)
        }
        val normalized = raw
            .removePrefix("手动配对码：")
            .removePrefix("手动配对码:")
            .trim()
        val split = normalized.indexOf('.')
        if (split <= 0 || split == normalized.lastIndex) return setConnection(ConnectionState.Disconnected, "配对码格式不正确，应为 pairingId.secret")
        pair(wssUrl.trim(), normalized.substring(0, split), normalized.substring(split + 1))
    }

    override fun pairFromQr(payload: String) {
        val uri = runCatching { Uri.parse(payload) }.getOrNull() ?: return
        if (uri.scheme != "agentpocket" || uri.host != "pair") return setConnection(ConnectionState.Disconnected, "二维码不是 Agent Pocket 配对码")
        pair(
            uri.getQueryParameter("endpoint").orEmpty(),
            uri.getQueryParameter("pairingId").orEmpty(),
            uri.getQueryParameter("secret").orEmpty(),
        )
    }

    override fun resetPairing() {
        connectionGeneration.incrementAndGet()
        connectionJob?.cancel()
        rpc?.close()
        threadReadGenerations.clear()
        secure.clear()
        _isPaired.value = false
        _threads.value = emptyList()
        _projects.value = emptyList()
        _models.value = emptyList()
        setConnection(ConnectionState.Disconnected, "设备配对已清除")
    }

    override fun setNotificationsEnabled(enabled: Boolean) {
        _device.value = _device.value.copy(notificationEnabled = enabled)
        settings.edit().putBoolean("notifications", enabled).apply()
    }

    override fun clearActionError() {
        _actionError.value = null
    }

    private fun pair(endpoint: String, pairingId: String, secret: String) {
        if (!isSecureEndpoint(endpoint) || pairingId.isBlank() || secret.isBlank()) {
            return setConnection(ConnectionState.Disconnected, "Bridge 地址或配对码无效")
        }
        scope.launch {
            setConnection(ConnectionState.Connecting, "正在配对…")
            val client = BridgeRpcClient(http, endpoint, null) {}
            runCatching {
                client.connect()
                withTimeout(15_000) { client.awaitOpen() }
                client.call("pair/claim", obj("pairingId" to pairingId, "secret" to secret, "deviceName" to Build.MODEL))
                    .requireObject("配对")
            }.mapCatching { result ->
                BridgeCredentials(endpoint, result.string("deviceId").orEmpty(), result.string("token").orEmpty()).also {
                    if (it.deviceId.isBlank() || it.token.isBlank()) throw BridgeRpcException("Bridge 返回的配对凭据不完整")
                }
            }.onSuccess { credentials ->
                secure.save(credentials)
                secure.lastSeq = 0
                _device.value = _device.value.copy(id = credentials.deviceId, pairedAt = "刚刚")
                _isPaired.value = true
                BridgeSyncService.start(context)
                reconnect()
            }.onFailure { setConnection(ConnectionState.Disconnected, it.message ?: "配对失败") }
            client.close()
        }
    }

    private fun isSecureEndpoint(endpoint: String): Boolean = runCatching {
        URI(endpoint).let {
            it.scheme.equals("wss", ignoreCase = true) &&
                !it.host.isNullOrBlank() &&
                it.userInfo == null &&
                it.fragment == null
        }
    }.getOrDefault(false)

    private fun reconnect() {
        if (pausedForLimit || secure.load() == null) return
        val generation = connectionGeneration.incrementAndGet()
        connectionJob?.cancel()
        rpc?.close()
        connectionJob = scope.launch { connectLoop(generation) }
    }

    private suspend fun connectLoop(initialGeneration: Long) {
        var backoff = 1_000L
        var generation = initialGeneration
        while (currentCoroutineContext().isActive && !pausedForLimit) {
            val credentials = secure.load() ?: return
            val clientGeneration = generation
            val client = BridgeRpcClient(http, credentials.endpoint, credentials.token) { event ->
                eventChannel.trySend(QueuedBridgeEvent(clientGeneration, event))
            }
            rpc = client
            try {
                setConnection(ConnectionState.Connecting, "正在连接…")
                client.connect()
                withTimeout(15_000) { client.awaitOpen() }
                val hello = try {
                    client.call("bridge/hello", obj("protocolVersion" to 1, "deviceId" to credentials.deviceId, "lastSeq" to secure.lastSeq))
                        .requireObject("Bridge 握手")
                } catch (error: BridgeRpcException) {
                    if (error.nameCode != "EVENT_GAP") throw error
                    secure.lastSeq = 0
                    client.call("bridge/hello", obj("protocolVersion" to 1, "deviceId" to credentials.deviceId, "lastSeq" to 0))
                        .requireObject("Bridge 重同步握手")
                }
                _host.value = _host.value.copy(
                    id = hello.string("hostId").orEmpty(),
                    name = hello.string("hostName") ?: "Windows Codex",
                    wssUrl = credentials.endpoint,
                    connectionState = ConnectionState.Connected,
                    lastSeen = if (hello.boolean("readOnly") == true) "Codex 协议只读" else "刚刚",
                )
                syncAll()
                fcmToken?.let { client.call("push/register", obj("fcmToken" to it)) }
                backoff = 1_000
                client.awaitClosed()
            } catch (error: Throwable) {
                if (!currentCoroutineContext().isActive) return
                setConnection(ConnectionState.Disconnected, error.message ?: "连接中断")
            } finally {
                client.close()
                if (rpc === client) rpc = null
            }
            generation = connectionGeneration.incrementAndGet()
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(30_000)
        }
    }

    private suspend fun syncAll() {
        val projectsResult = call("project/list").requireObject("项目列表")
        _projects.value = projectsResult.array("data").mapNotNull { element ->
            element.asObject()?.let { Project(it.string("id").orEmpty(), it.string("name").orEmpty(), it.string("cwd").orEmpty()) }
        }
        val modelsResult = call("model/list").requireObject("模型列表")
        _models.value = modelsResult.array("data").mapNotNull(::modelFromJson)
        syncThreads()
    }

    private suspend fun syncThreads() {
        val client = rpc ?: throw BridgeRpcException("Bridge 尚未连接")
        val requestGeneration = ++threadListGeneration
        val result = client.call("thread/list").requireObject("任务列表")
        if (rpc !== client || requestGeneration != threadListGeneration) return
        _threads.value = result.array("data").mapNotNull { it.asObject()?.let(::summaryFromJson) }
    }

    private suspend fun fetchThread(threadId: String, reportError: Boolean = true): Boolean {
        val client = rpc ?: return false
        val requestGeneration = (threadReadGenerations[threadId] ?: 0L) + 1L
        threadReadGenerations[threadId] = requestGeneration
        var applied = false
        runCatching {
            client.call("thread/read", obj("threadId" to threadId))
                .requireObject("读取任务")
                .obj("thread")
                ?: throw BridgeRpcException("读取任务返回缺少 thread")
        }.onSuccess { thread ->
            if (rpc !== client || threadReadGenerations[threadId] != requestGeneration) return@onSuccess
            details.getOrPut(threadId) { MutableStateFlow(emptyDetail(threadId)) }.value = detailFromJson(thread)
            applied = true
        }.onFailure { error ->
            if (reportError && rpc === client && threadReadGenerations[threadId] == requestGeneration) {
                _actionError.value = actionError("读取任务", error)
            }
        }
        return applied
    }

    private suspend fun refreshThreadFromSync(threadId: String) {
        for (waitMs in listOf(0L, 500L, 1_500L)) {
            if (waitMs > 0) delay(waitMs)
            if (fetchThread(threadId, reportError = false)) {
                runCatching { syncThreads() }
                return
            }
        }
        reconnect()
        throw BridgeRpcException("任务更新读取失败，正在重新连接后重试")
    }

    private suspend fun call(method: String, params: JsonObject = JsonObject(emptyMap())): JsonElement =
        (rpc ?: throw BridgeRpcException("Bridge 尚未连接")).call(method, params)

    private suspend fun processEvent(event: JsonObject) {
        val seq = event.long("seq") ?: return
        if (seq <= secure.lastSeq) return
        if (secure.lastSeq > 0 && seq != secure.lastSeq + 1) {
            secure.lastSeq = 0
            reconnect()
            return
        }
        val type = event.string("type")
            ?: throw BridgeRpcException("事件 $seq 缺少 type")
        val threadId = event.string("threadId")
        val turnId = event.string("turnId")
        val payload = event.obj("payload") ?: JsonObject(emptyMap())
        when (type) {
            "message.delta" -> if (threadId != null) bufferDelta(threadId, payload.string("itemId") ?: "agent-$turnId", payload.string("delta").orEmpty())
            "plan.updated" -> if (threadId != null) applyPlan(threadId, turnId, payload)
            "command.updated" -> if (threadId != null) applyCommand(threadId, payload)
            "diff.updated" -> if (threadId != null) diffs.getOrPut(threadId) { MutableStateFlow(emptyList()) }.value = parseDiff(payload.string("diff").orEmpty(), payload.boolean("truncated") == true)
            "approval.request" -> if (threadId != null) applyApproval(threadId, payload)
            "question.request" -> if (threadId != null) applyQuestion(threadId, payload)
            "turn.status" -> if (threadId != null) applyTurnStatus(threadId, turnId, payload)
            "sync.required" -> if (threadId != null) refreshThreadFromSync(threadId) else reconnect()
        }
        // Only acknowledge an event after its shape has been validated and its
        // state mutation completed, otherwise reconnect replay could skip it.
        secure.lastSeq = seq
        _host.value = _host.value.copy(lastSeen = "刚刚")
    }

    private fun bufferDelta(threadId: String, itemId: String, delta: String) {
        val key = threadId to itemId
        deltaBuffers.getOrPut(key) { StringBuilder() }.append(delta)
        if (deltaJobs[key]?.isActive == true) return
        deltaJobs[key] = scope.launch {
            delay(50)
            flushDelta(key, false)
        }
    }

    private fun flushDelta(key: Pair<String, String>, cancelJob: Boolean = true) {
        if (cancelJob) deltaJobs.remove(key)?.cancel() else deltaJobs.remove(key)
        val text = deltaBuffers.remove(key)?.toString().orEmpty()
        if (text.isEmpty()) return
        val (threadId, itemId) = key
        val flow = details.getOrPut(threadId) { MutableStateFlow(emptyDetail(threadId)) }
        val existing = flow.value.items.filterIsInstance<TimelineItem.Message>().firstOrNull { it.id == itemId }
        flow.value = if (existing == null) {
            flow.value.copy(items = flow.value.items + TimelineItem.Message(itemId, Role.Assistant, text, MessageStatus.Streaming))
        } else {
            flow.value.copy(items = flow.value.items.map { if (it.id == itemId) existing.copy(text = existing.text + text) else it })
        }
    }

    private fun applyPlan(threadId: String, turnId: String?, payload: JsonObject) {
        val steps = payload.array("plan").mapIndexedNotNull { index, element ->
            element.asObject()?.let {
                PlanStep(index, it.string("step").orEmpty(), when (it.string("status")) {
                    "completed" -> StepStatus.Done
                    "inProgress" -> StepStatus.InProgress
                    else -> StepStatus.Pending
                })
            }
        }
        upsert(threadId, TimelineItem.Plan("plan-${turnId ?: "current"}", steps, if (steps.all { it.status == StepStatus.Done }) PlanStatus.Done else PlanStatus.InProgress))
    }

    private fun applyCommand(threadId: String, payload: JsonObject) {
        val item = payload.obj("item") ?: payload
        val id = item.string("id") ?: payload.string("itemId") ?: return
        val current = details[threadId]?.value?.items?.filterIsInstance<TimelineItem.Command>()?.firstOrNull { it.id == id }
        val delta = payload.string("delta")
        val aggregate = item.string("aggregatedOutput")
        val combinedOutput = when {
            delta != null -> current?.output.orEmpty() + delta
            aggregate != null -> aggregate
            else -> current?.output.orEmpty()
        }
        val outputWasTrimmed = combinedOutput.length > MAX_COMMAND_OUTPUT_CHARS
        val output = if (outputWasTrimmed) combinedOutput.takeLast(MAX_COMMAND_OUTPUT_CHARS) else combinedOutput
        val status = when (item.string("status")) {
            "completed" -> CommandStatus.Succeeded
            "failed", "declined" -> CommandStatus.Failed
            else -> current?.status ?: CommandStatus.Running
        }
        upsert(threadId, TimelineItem.Command(id, item.commandText() ?: current?.label ?: "命令", item.string("cwd") ?: current?.cwd.orEmpty(), status, output, outputWasTrimmed || payload.boolean("truncated") == true || current?.truncated == true))
    }

    private fun applyApproval(threadId: String, payload: JsonObject) {
        val requestId = payload.string("requestId") ?: return
        val command = payload.commandText().orEmpty()
        upsert(threadId, TimelineItem.Approval(requestId, requestId, payload.string("reason") ?: "Codex 请求允许一次", command, payload.string("cwd").orEmpty()))
        if (!isDesktopOwned(threadId)) setThreadStatus(threadId, ThreadStatus.NeedsAttention)
    }

    private fun applyQuestion(threadId: String, payload: JsonObject) {
        val requestId = payload.string("requestId") ?: return
        val questions = payload.array("questions").mapNotNull { it.asObject() }
        questionCounts[requestId] = questions.size
        questions.forEach { question ->
            val questionId = question.string("id") ?: return@forEach
            val options = question.array("options").mapNotNull { it.asObject()?.string("label") ?: (it as? JsonPrimitive)?.contentOrNull }
            upsert(threadId, TimelineItem.Question("$requestId:$questionId", requestId, questionId, question.string("question").orEmpty(), options))
        }
        if (!isDesktopOwned(threadId)) setThreadStatus(threadId, ThreadStatus.NeedsAttention)
    }

    private fun applyTurnStatus(threadId: String, turnId: String?, payload: JsonObject) {
        val status = payload.string("status") ?: payload.obj("status")?.string("type")
        val flow = details.getOrPut(threadId) { MutableStateFlow(emptyDetail(threadId)) }
        val desktopOwned = isDesktopOwned(threadId)
        when (status) {
            "started", "active" -> {
                val owned = if (status == "started") turnId != null else ownedTurns.containsKey(threadId)
                if (owned && turnId != null) ownedTurns[threadId] = turnId
                val next = if (desktopOwned) ThreadStatus.DesktopOwned else if (owned) ThreadStatus.Active else ThreadStatus.ExternalBusy
                flow.value = flow.value.copy(status = next, activeTurnId = if (owned) turnId ?: ownedTurns[threadId] else null)
                setThreadStatus(threadId, next)
            }
            "completed", "idle", "failed", "interrupted" -> {
                deltaBuffers.keys.filter { it.first == threadId }.toList().forEach(::flushDelta)
                ownedTurns.remove(threadId)
                flow.value = flow.value.copy(
                    status = if (desktopOwned) ThreadStatus.DesktopOwned else if (status == "failed") ThreadStatus.NeedsAttention else ThreadStatus.Idle,
                    activeTurnId = null,
                    items = flow.value.items.map { if (it is TimelineItem.Message && it.status == MessageStatus.Streaming) it.copy(status = if (status == "interrupted") MessageStatus.Interrupted else MessageStatus.Done) else it },
                )
                setThreadStatus(threadId, if (desktopOwned) ThreadStatus.DesktopOwned else if (status == "failed") ThreadStatus.NeedsAttention else ThreadStatus.Idle)
            }
        }
    }

    private fun upsert(threadId: String, item: TimelineItem) {
        val flow = details.getOrPut(threadId) { MutableStateFlow(emptyDetail(threadId)) }
        flow.value = flow.value.copy(items = if (flow.value.items.any { it.id == item.id }) flow.value.items.map { if (it.id == item.id) item else it } else flow.value.items + item)
    }

    private fun updateItem(threadId: String, requestId: String, transform: (TimelineItem) -> TimelineItem) {
        val flow = details[threadId] ?: return
        flow.value = flow.value.copy(items = flow.value.items.map { item ->
            val matches = when (item) {
                is TimelineItem.Approval -> item.requestId == requestId
                is TimelineItem.Question -> item.requestId == requestId
                else -> false
            }
            if (matches) transform(item) else item
        })
    }

    private fun updateMessageStatus(threadId: String, messageId: String, status: MessageStatus) {
        val flow = details[threadId] ?: return
        flow.value = flow.value.copy(items = flow.value.items.map { item ->
            if (item is TimelineItem.Message && item.id == messageId) item.copy(status = status) else item
        })
    }

    private fun setThreadStatus(threadId: String, status: ThreadStatus) {
        _threads.value = _threads.value.map { if (it.id == threadId) it.copy(status = status) else it }
        details[threadId]?.let { flow -> flow.value = flow.value.copy(status = status) }
    }

    private fun isDesktopOwned(threadId: String): Boolean =
        details[threadId]?.value?.status == ThreadStatus.DesktopOwned ||
            _threads.value.any { it.id == threadId && it.status == ThreadStatus.DesktopOwned }

    private fun summaryFromJson(thread: JsonObject): ThreadSummary {
        val id = thread.string("id").orEmpty()
        val preview = thread.string("preview").orEmpty()
        return ThreadSummary(
            id, thread.string("name") ?: preview.lineSequence().firstOrNull()?.take(40).orEmpty().ifBlank { "未命名任务" },
            thread.string("cwd").orEmpty(), if (thread.string("source") == "desktop") ThreadStatus.DesktopOwned else statusFromJson(id, thread.obj("status")),
            formatTime(thread.long("updatedAt")), preview.take(120), 0,
        )
    }

    private fun detailFromJson(thread: JsonObject): ThreadDetail {
        val id = thread.string("id").orEmpty()
        val items = mutableListOf<TimelineItem>()
        var activeTurn: String? = null
        thread.array("turns").forEach { turnElement ->
            val turn = turnElement.asObject() ?: return@forEach
            if (turn.string("status") == "inProgress") activeTurn = turn.string("id")
            turn.array("items").forEach { itemElement -> itemElement.asObject()?.let { itemFromJson(it)?.let(items::add) } }
        }
        val status = if (thread.string("source") == "desktop") ThreadStatus.DesktopOwned else statusFromJson(id, thread.obj("status"), activeTurn != null)
        if (status == ThreadStatus.Active && activeTurn == null) activeTurn = ownedTurns[id]
        return ThreadDetail(
            id, thread.string("name") ?: thread.string("preview")?.lineSequence()?.firstOrNull()?.take(40).orEmpty().ifBlank { "未命名任务" },
            thread.string("cwd").orEmpty(), status, items.distinctBy { it.id }, activeTurn,
        )
    }

    private fun itemFromJson(item: JsonObject): TimelineItem? = when (item.string("type")) {
        "userMessage" -> TimelineItem.Message(
            item.string("id").orEmpty(),
            Role.User,
            displayUserText(item.array("content").mapNotNull { it.asObject()?.string("text") }.joinToString("\n")),
            MessageStatus.Done,
        )
        "agentMessage" -> TimelineItem.Message(item.string("id").orEmpty(), Role.Assistant, item.string("text").orEmpty(), MessageStatus.Done)
        "plan" -> TimelineItem.Message(item.string("id").orEmpty(), Role.System, item.string("text").orEmpty(), MessageStatus.Done)
        "commandExecution" -> {
            val fullOutput = item.string("aggregatedOutput").orEmpty()
            TimelineItem.Command(
                item.string("id").orEmpty(), item.commandText().orEmpty(), item.string("cwd").orEmpty(),
                when (item.string("status")) { "completed" -> CommandStatus.Succeeded; "failed", "declined" -> CommandStatus.Failed; else -> CommandStatus.Running },
                fullOutput.takeLast(MAX_COMMAND_OUTPUT_CHARS),
                fullOutput.length > MAX_COMMAND_OUTPUT_CHARS,
            )
        }
        else -> null
    }

    private fun displayUserText(raw: String): String {
        if (!raw.contains("<codex_delegation>") || !raw.contains("<input>")) return raw
        val input = raw.substringAfter("<input>", missingDelimiterValue = "")
            .substringBeforeLast("</input>", missingDelimiterValue = "")
            .trim()
        return input.ifBlank { raw }
    }

    private fun statusFromJson(
        threadId: String,
        status: JsonObject?,
        hasInProgressTurn: Boolean? = null,
    ): ThreadStatus = when (status?.string("type")) {
        "active" -> when {
            ownedTurns.containsKey(threadId) -> ThreadStatus.Active
            hasInProgressTurn == true -> ThreadStatus.ExternalBusy
            hasInProgressTurn == false -> ThreadStatus.Idle
            else -> ThreadStatus.ExternalBusy
        }
        "systemError" -> ThreadStatus.NeedsAttention
        "idle" -> ThreadStatus.Idle
        else -> ThreadStatus.Completed
    }

    private fun modelFromJson(element: JsonElement): ModelOption? {
        val model = element.asObject() ?: return null
        val efforts = model.array("supportedReasoningEfforts").mapNotNull { value ->
            value.asObject()?.let { ReasoningOption(it.string("reasoningEffort").orEmpty(), effortLabel(it.string("reasoningEffort").orEmpty()), it.string("description").orEmpty()) }
        }
        if (efforts.isEmpty()) return null
        return ModelOption(model.string("id").orEmpty(), model.string("displayName") ?: model.string("id").orEmpty(), model.string("description").orEmpty(), efforts)
    }

    private fun parseDiff(text: String, truncated: Boolean): List<DiffFile> {
        data class MutableFile(var path: String, var status: DiffFileStatus = DiffFileStatus.Modified, val hunks: MutableList<DiffHunk> = mutableListOf())
        val files = mutableListOf<MutableFile>()
        var file: MutableFile? = null
        var header: String? = null
        var lines = mutableListOf<DiffLine>()
        fun finishHunk() { val f = file; val h = header; if (f != null && h != null) f.hunks += DiffHunk(h, lines); header = null; lines = mutableListOf() }
        text.lineSequence().forEach { line ->
            when {
                line.startsWith("diff --git ") -> {
                    finishHunk()
                    val path = line.substringAfter(" b/").ifBlank { line.substringAfter(" a/") }
                    file = MutableFile(path).also(files::add)
                }
                line.startsWith("new file mode") -> file?.status = DiffFileStatus.Added
                line.startsWith("deleted file mode") -> file?.status = DiffFileStatus.Deleted
                line.startsWith("rename to ") -> { file?.status = DiffFileStatus.Renamed; file?.path = line.removePrefix("rename to ") }
                line.startsWith("@@") -> { finishHunk(); header = line }
                header != null && line.startsWith("+") && !line.startsWith("+++") -> lines += DiffLine(DiffLineKind.Add, line.drop(1))
                header != null && line.startsWith("-") && !line.startsWith("---") -> lines += DiffLine(DiffLineKind.Delete, line.drop(1))
                header != null -> lines += DiffLine(DiffLineKind.Context, line.removePrefix(" "))
            }
        }
        finishHunk()
        return files.map { mutable ->
            val all = mutable.hunks.flatMap { it.lines }
            DiffFile(mutable.path, mutable.status, all.count { it.kind == DiffLineKind.Add }, all.count { it.kind == DiffLineKind.Delete }, mutable.hunks, truncated)
        }
    }

    private fun emptyDetail(threadId: String): ThreadDetail {
        val summary = _threads.value.firstOrNull { it.id == threadId }
        return ThreadDetail(threadId, summary?.title ?: "加载中…", summary?.cwd.orEmpty(), summary?.status ?: ThreadStatus.Idle, emptyList(), null)
    }

    private fun setConnection(state: ConnectionState, text: String) {
        _host.value = _host.value.copy(connectionState = state, lastSeen = text)
    }

    private fun formatTime(epoch: Long?): String = epoch?.let {
        DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochSecond(it))
    } ?: ""

    private fun effortLabel(value: String) = when (value) {
        "none" -> "无"; "minimal" -> "极低"; "low" -> "低"; "medium" -> "中"; "high" -> "高"; "xhigh" -> "极高"; "max" -> "最大"; "ultra" -> "超高"; else -> value
    }

    private fun actionError(action: String, error: Throwable): String {
        val rpcError = error as? BridgeRpcException
        return when (rpcError?.nameCode) {
            "THREAD_BUSY_EXTERNAL" -> "桌面端正在运行这个任务，移动端不能接管"
            "THREAD_BUSY" -> "这个任务正在处理中，请稍后再试"
            "AUTH_FAILED" -> "设备令牌已失效，请在设置中重新配对"
            "VERSION_UNSUPPORTED" -> "Windows 上的 Codex 协议版本暂不兼容"
            else -> "$action 失败：${error.message ?: "未知错误"}"
        }
    }

    private fun obj(vararg values: Pair<String, Any?>) = buildJsonObject {
        values.forEach { (key, value) ->
            when (value) {
                null -> put(key, JsonNull)
                is String -> put(key, value)
                is Number -> put(key, JsonPrimitive(value))
                is Boolean -> put(key, value)
                is JsonElement -> put(key, value)
            }
        }
    }
}

private fun JsonElement.asObject(): JsonObject? = this as? JsonObject
private fun JsonElement.requireObject(context: String): JsonObject =
    this as? JsonObject ?: throw BridgeRpcException("$context 返回格式不兼容")
private fun JsonObject.string(key: String): String? = (this[key] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.long(key: String): Long? = (this[key] as? JsonPrimitive)?.longOrNull
private fun JsonObject.boolean(key: String): Boolean? =
    (this[key] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull()
private fun JsonObject.obj(key: String): JsonObject? = this[key] as? JsonObject
private fun JsonObject.array(key: String): JsonArray = this[key] as? JsonArray ?: JsonArray(emptyList())

private fun JsonObject.commandText(): String? = when (val command = this["command"]) {
    is JsonPrimitive -> command.contentOrNull
    is JsonArray -> command.mapNotNull { part ->
        when (part) {
            is JsonPrimitive -> part.contentOrNull
            is JsonObject -> part.string("text") ?: part.string("command")
            else -> null
        }
    }.joinToString(" ").ifBlank { null }
    is JsonObject -> command.string("text") ?: command.string("command")
    else -> null
}
