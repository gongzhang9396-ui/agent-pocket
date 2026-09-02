package com.agentpocket.app.data

import android.content.Context
import android.graphics.BitmapFactory
import android.net.ConnectivityManager
import android.net.Network
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Base64
import android.webkit.MimeTypeMap
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
import com.agentpocket.app.data.model.ThreadRef
import com.agentpocket.app.data.model.ThreadStatus
import com.agentpocket.app.data.model.ThreadSummary
import com.agentpocket.app.data.model.TimelineItem
import java.net.URI
import java.io.ByteArrayOutputStream
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
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
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

private const val MAX_COMMAND_OUTPUT_CHARS = 256 * 1024
private const val INNER_RPC_TIMEOUT_MS = 30_000L
private const val MAX_ATTACHMENT_COUNT = 3
private const val MAX_ATTACHMENT_TOTAL_BYTES = 800 * 1024
private const val MAX_FILE_ATTACHMENT_BYTES = 512 * 1024

private val SAFE_FILE_EXTENSIONS = setOf(
    "txt", "md", "markdown", "json", "jsonl", "csv", "tsv", "xml", "yaml", "yml", "log",
    "kt", "kts", "java", "js", "jsx", "ts", "tsx", "py", "rs", "go", "c", "cc", "cpp",
    "h", "hpp", "cs", "swift", "rb", "php", "sh", "ps1", "bat", "cmd", "toml", "ini", "conf",
    "cfg", "gradle", "sql", "html", "css", "scss", "vue", "svelte", "properties", "pdf",
)

private data class EncodedAttachments(val images: JsonArray, val files: JsonArray)

private data class ParsedThreadDetail(
    val title: String,
    val cwd: String,
    val source: String?,
    val status: JsonObject?,
    val items: List<TimelineItem>,
    val activeTurnId: String?,
)

internal fun isPendingSessionRejected(error: Throwable): Boolean =
    error is BridgeRpcException && error.nameCode == "AUTH_FAILED"

internal fun shouldMarkSendFailed(currentStatus: MessageStatus?): Boolean =
    currentStatus != MessageStatus.Done

internal fun resolveThreadRef(value: String, fallbackHostId: String?): ThreadRef? =
    runCatching { ThreadRef.parse(value) }.getOrNull()
        ?: fallbackHostId?.takeIf { it.isNotBlank() }?.let { ThreadRef(it, value) }

private data class ChannelState(
    val crypto: PhoneChannel,
    val ready: CompletableDeferred<Unit> = CompletableDeferred(),
)

class RpcPocketRepository(private val context: Context) : PocketRepository {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val secure = SecurePrefs(context)
    private val json = RelayProtocolJson
    // A 20 second pong deadline is too aggressive on mobile/VPN handovers.
    // Thirty seconds still keeps NAT/proxy mappings warm while tolerating a
    // short radio stall; any real disconnect is repaired by connectLoop.
    private val http = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build()
    private val settings = context.getSharedPreferences("settings", Context.MODE_PRIVATE)
    private val connectionGeneration = AtomicLong(0)
    private val innerIds = AtomicLong(1)
    private val hostInfos = mutableMapOf<String, RelayHostInfo>()
    private val capabilitiesByHost = mutableMapOf<String, Set<String>>()
    private val threadLists = mutableMapOf<String, List<ThreadSummary>>()
    private val details = mutableMapOf<String, MutableStateFlow<ThreadDetail>>()
    private val diffs = mutableMapOf<String, MutableStateFlow<List<DiffFile>>>()
    private val projectsByHost = mutableMapOf<String, List<Project>>()
    private val modelsByHost = mutableMapOf<String, List<ModelOption>>()
    private val channels = mutableMapOf<String, ChannelState>()
    private val innerPending = mutableMapOf<Pair<String, Long>, CompletableDeferred<JsonElement>>()
    private val ownedTurns = mutableMapOf<String, String>()
    private val questionCounts = mutableMapOf<String, Int>()
    private val pendingAnswers = mutableMapOf<String, MutableMap<String, String>>()
    private val deltaBuffers = mutableMapOf<Pair<String, String>, StringBuilder>()
    private val deltaJobs = mutableMapOf<Pair<String, String>, Job>()
    private val notificationRefs = mutableMapOf<String, String>()
    private val hostEventMutexes = mutableMapOf<String, Mutex>()
    private val refreshMutex = Mutex()
    private val hostSyncJobs = mutableMapOf<String, Job>()
    private val hostSyncRerun = mutableSetOf<String>()
    private val threadRefreshJobs = mutableMapOf<String, Job>()
    private val pendingThreadRefreshes = mutableSetOf<String>()
    private val unreadCounts = mutableMapOf<String, Int>()
    private var activeThreadKey: String? = null
    private var rpc: BridgeRpcClient? = null
    private var relayReady: CompletableDeferred<Unit>? = null
    private var connectionJob: Job? = null
    private var pendingApprovalJob: Job? = null
    private var fullSyncJob: Job? = null
    private var fullSyncRerun = false
    private var fcmToken: String? = null
    private var pausedForLimit = false

    private val _hosts = MutableStateFlow<List<Host>>(emptyList())
    override val hosts: StateFlow<List<Host>> = _hosts.asStateFlow()
    private val _hostRuntimes = MutableStateFlow<Map<String, HostRuntime>>(emptyMap())
    override val hostRuntimes: StateFlow<Map<String, HostRuntime>> = _hostRuntimes.asStateFlow()
    private val _selectedHostId = MutableStateFlow<String?>(null)
    override val selectedHostId: StateFlow<String?> = _selectedHostId.asStateFlow()
    private val _host = MutableStateFlow(aggregateHost())
    override val host: StateFlow<Host> = _host.asStateFlow()
    private val _device = MutableStateFlow(deviceModel(secure.load()))
    override val device: StateFlow<Device> = _device.asStateFlow()
    private val _accountDevices = MutableStateFlow<List<Device>>(emptyList())
    override val accountDevices: StateFlow<List<Device>> = _accountDevices.asStateFlow()
    private val _isPaired = MutableStateFlow(secure.load()?.approved == true)
    override val isPaired: StateFlow<Boolean> = _isPaired.asStateFlow()
    private val _authStatus = MutableStateFlow(if (secure.load()?.deviceStatus == "pending") "等待已有设备批准" else "")
    override val authStatus: StateFlow<String> = _authStatus.asStateFlow()
    private val _threads = MutableStateFlow<List<ThreadSummary>>(emptyList())
    override val threads: StateFlow<List<ThreadSummary>> = _threads.asStateFlow()
    private val _projects = MutableStateFlow<List<Project>>(emptyList())
    override val projects: StateFlow<List<Project>> = _projects.asStateFlow()
    private val _projectsLoading = MutableStateFlow(false)
    override val projectsLoading: StateFlow<Boolean> = _projectsLoading.asStateFlow()
    private val _projectsError = MutableStateFlow<String?>(null)
    override val projectsError: StateFlow<String?> = _projectsError.asStateFlow()
    private val _models = MutableStateFlow<List<ModelOption>>(emptyList())
    override val models: StateFlow<List<ModelOption>> = _models.asStateFlow()
    private val _actionError = MutableStateFlow<String?>(null)
    override val actionError: StateFlow<String?> = _actionError.asStateFlow()
    private val _creatingTask = MutableStateFlow(false)
    override val creatingTask: StateFlow<Boolean> = _creatingTask.asStateFlow()
    private val _syncing = MutableStateFlow(false)
    override val syncing: StateFlow<Boolean> = _syncing.asStateFlow()
    private val _syncStatus = MutableStateFlow<String?>(null)
    override val syncStatus: StateFlow<String?> = _syncStatus.asStateFlow()
    private val _refreshingThreads = MutableStateFlow<Set<String>>(emptySet())
    override val refreshingThreads: StateFlow<Set<String>> = _refreshingThreads.asStateFlow()

    init {
        context.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(
            object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) { if (!pausedForLimit && _isPaired.value) reconnect() }
                override fun onLost(network: Network) { rpc?.close() }
            },
        )
        when {
            secure.load()?.approved == true -> reconnect()
            secure.load()?.deviceStatus == "pending" -> pollPendingApproval()
        }
    }

    fun resume() {
        pausedForLimit = false
        if (_isPaired.value) {
            BridgeSyncService.start(context)
            reconnect()
        } else if (secure.load()?.deviceStatus == "pending") {
            pollPendingApproval()
        }
    }

    fun pauseForBackgroundLimit() {
        pausedForLimit = true
        connectionGeneration.incrementAndGet()
        connectionJob?.cancel()
        rpc?.close()
        markRelayDisconnected("后台长连接已暂停，将通过通知提醒")
    }

    fun registerFcmToken(token: String) {
        fcmToken = token
        scope.launch { registerPushIfReady() }
    }

    override fun login(relayUrl: String, username: String, password: String) {
        if (!validRelayUrl(relayUrl) || username.isBlank() || password.length !in 12..128) {
            _authStatus.value = "Relay 地址、用户名或密码格式不正确"
            return
        }
        scope.launch {
            _authStatus.value = "正在登录"
            runCatching {
                val existing = secure.load()?.takeIf { sameEndpoint(it.endpoint, relayUrl) && it.username.equals(username, true) }
                val deviceKeys = existing?.deviceKeys() ?: RelayCrypto.generateDevice()
                val result = apiPost(
                    relayUrl,
                    "/api/auth/login",
                    obj(
                        "username" to username,
                        "password" to password,
                        "deviceId" to existing?.deviceId,
                        "deviceName" to Build.MODEL,
                        "deviceSigningPublicKey" to deviceKeys.signingPublicKey,
                        "deviceEncryptionPublicKey" to deviceKeys.encryptionPublicKey,
                    ),
                ).requireObject("登录")
                credentialsFromLogin(relayUrl, username.lowercase(), deviceKeys, result, existing)
            }.onSuccess { credentials ->
                secure.save(credentials)
                _device.value = deviceModel(credentials)
                if (credentials.approved) {
                    _isPaired.value = true
                    _authStatus.value = "已登录"
                    BridgeSyncService.start(context)
                    reconnect()
                } else {
                    _isPaired.value = false
                    _authStatus.value = "新设备等待已有手机批准"
                    pollPendingApproval()
                }
            }.onFailure { _authStatus.value = it.message ?: "登录失败" }
        }
    }

    override fun claimInvite(inviteUrl: String, relayUrl: String, username: String, displayName: String, password: String) {
        val invite = parseInvite(inviteUrl)
        val endpoint = relayUrl.ifBlank { invite?.third.orEmpty() }
        if (invite == null || !validRelayUrl(endpoint) || username.isBlank() || displayName.isBlank() || password.length !in 12..128) {
            _authStatus.value = "邀请链接或注册信息格式不正确"
            return
        }
        scope.launch {
            _authStatus.value = "正在创建加密身份"
            runCatching {
                val publicConfig = apiGet(endpoint, "/api/public/config").requireObject("Relay 配置")
                val recoveryPublicKey = publicConfig.string("recoveryPublicKey") ?: error("Relay 尚未完成管理员初始化")
                val material = withContext(Dispatchers.Default) { RelayCrypto.createRegistration(recoveryPublicKey) }
                val result = apiPost(
                    endpoint,
                    "/api/invites/claim",
                    obj(
                        "inviteId" to invite.first,
                        "secret" to invite.second,
                        "username" to username,
                        "displayName" to displayName,
                        "password" to password,
                        "deviceName" to Build.MODEL,
                        "accountSigningPublicKey" to material.accountSigningPublicKey,
                        "accountEncryptionPublicKey" to material.accountEncryptionPublicKey,
                        "deviceSigningPublicKey" to material.device.signingPublicKey,
                        "deviceEncryptionPublicKey" to material.device.encryptionPublicKey,
                        "escrowCiphertext" to material.escrowCiphertext,
                        "keyPackage" to material.keyPackage,
                    ),
                ).requireObject("接受邀请")
                credentialsFromRegistration(endpoint, username.lowercase(), material, result)
            }.onSuccess { credentials ->
                secure.save(credentials)
                _device.value = deviceModel(credentials)
                _isPaired.value = true
                _authStatus.value = "注册完成"
                BridgeSyncService.start(context)
                reconnect()
            }.onFailure { _authStatus.value = it.message ?: "注册失败" }
        }
    }

    override fun approveHostFromQr(payload: String, name: String?) {
        val credentials = secure.load()?.takeIf { it.approved } ?: return
        val uri = runCatching { Uri.parse(payload) }.getOrNull()
        if (uri?.scheme != "agentpocket" || uri.host != "relay-host") {
            _actionError.value = "二维码不是 Agent Pocket Relay Host 绑定码"
            return
        }
        val relay = uri.getQueryParameter("relay").orEmpty()
        val enrollmentId = uri.getQueryParameter("enrollmentId").orEmpty()
        val secret = uri.getQueryParameter("secret").orEmpty()
        if (!sameEndpoint(credentials.endpoint, relay) || enrollmentId.isBlank() || secret.isBlank()) {
            _actionError.value = "Host 绑定码不属于当前 Relay 或已经损坏"
            return
        }
        scope.launch {
            runCatching {
                val inspected = outerCall("host/enroll/inspect", obj("enrollmentId" to enrollmentId, "secret" to secret)).requireObject("读取 Host")
                val hostKey = inspected.string("encryption_public_key") ?: error("Host 缺少加密公钥")
                val packageValue = RelayCrypto.sealHostContentKey(hostKey, credentials.contentKey!!)
                outerCall(
                    "host/enroll/approve",
                    obj(
                        "enrollmentId" to enrollmentId,
                        "secret" to secret,
                        "name" to (name?.takeIf { it.isNotBlank() } ?: inspected.string("requested_name") ?: "Windows Codex"),
                        "keyPackage" to packageValue,
                    ),
                )
            }.onSuccess {
                _actionError.value = null
                syncHosts()
            }
                .onFailure { _actionError.value = "绑定电脑失败：${it.message}" }
        }
    }

    override fun approveDevice(deviceId: String) {
        val credentials = secure.load()?.takeIf { it.approved } ?: return
        val target = _accountDevices.value.firstOrNull { it.id == deviceId && it.status == "pending" } ?: return
        scope.launch {
            runCatching {
                val keyPackage = RelayCrypto.sealAccountPackage(target.encryptionPublicKey, credentials)
                outerCall("device/approve", obj("deviceId" to deviceId, "keyPackage" to keyPackage))
                reloadDevices()
            }.onFailure { _actionError.value = "批准设备失败：${it.message}" }
        }
    }

    override fun revokeAccountDevice(deviceId: String) {
        scope.launch {
            runCatching { outerCall("device/revoke", obj("deviceId" to deviceId)) }
                .onSuccess { if (deviceId == secure.load()?.deviceId) resetPairing() else reloadDevices() }
                .onFailure { _actionError.value = "撤销设备失败：${it.message}" }
        }
    }

    override fun selectHost(hostId: String?) {
        _selectedHostId.value = hostId?.takeIf { candidate -> _hosts.value.any { it.id == candidate } }
        updateVisibleState()
        _selectedHostId.value?.let { selected -> scheduleHostSync(selected) }
    }

    override fun threadDetail(threadId: String): StateFlow<ThreadDetail> {
        val ref = runCatching { ThreadRef.parse(threadId) }.getOrElse { ThreadRef(_selectedHostId.value.orEmpty(), threadId) }
        val key = ref.encoded()
        val flow = details.getOrPut(key) { MutableStateFlow(emptyDetail(ref)) }
        scheduleThreadRefresh(ref, delayMs = 0)
        return flow.asStateFlow()
    }

    override fun threadDiff(threadId: String): StateFlow<List<DiffFile>> =
        diffs.getOrPut(threadId) { MutableStateFlow(emptyList()) }.asStateFlow()

    override fun openNotification(hostId: String, eventId: String, onResolved: (String?) -> Unit) {
        selectHost(hostId)
        notificationRefs[eventId]?.let { onResolved(it); return }
        scope.launch {
            val resolved = runCatching {
                val stored = outerCall("event/get", obj("hostId" to hostId, "eventId" to eventId)).asObject()
                    ?: return@runCatching null
                val envelope = stored.obj("envelope")?.let(::envelopeFromJson) ?: return@runCatching null
                val credentials = secure.load()?.takeIf { it.approved } ?: return@runCatching null
                val event = json.parseToJsonElement(RelayCrypto.decryptAccountEnvelope(envelope, credentials.contentKey!!)) as? JsonObject
                    ?: return@runCatching null
                event.string("threadId")?.let { ThreadRef(hostId, it).encoded() }
            }.getOrNull()
            if (resolved != null) notificationRefs[eventId] = resolved
            onResolved(resolved)
        }
    }

    override fun refreshProjects() {
        val hostId = _selectedHostId.value
        if (hostId == null) {
            _projectsError.value = "请先选择一台在线电脑"
            return
        }
        scope.launch {
            _projectsError.value = null
            runCatching { syncHostMetadata(hostId) }
                .onFailure { _projectsError.value = actionError("读取项目和模型", it) }
        }
    }

    override fun refreshHostRuntime(hostId: String) {
        if (hostInfos[hostId]?.online != true) {
            _hostRuntimes.value = _hostRuntimes.value + (hostId to HostRuntime(hostId))
            return
        }
        scope.launch {
            runCatching { fetchHostRuntime(hostId) }
                .onFailure { _actionError.value = actionError("读取 Desktop 状态", it) }
        }
    }

    override fun launchDesktop(hostId: String) {
        if (hostInfos[hostId]?.online != true) {
            _actionError.value = "启动失败：目标电脑当前离线"
            return
        }
        _hostRuntimes.value = _hostRuntimes.value + (
            hostId to (_hostRuntimes.value[hostId] ?: HostRuntime(hostId)).copy(
                desktopState = DesktopRuntimeState.Starting,
                canWake = false,
            )
        )
        scope.launch {
            runCatching {
                val result = innerCall(hostId, "desktop/launch").requireObject("启动 Desktop")
                updateHostRuntime(hostId, result)
                delay(2_000)
                fetchHostRuntime(hostId)
            }.onFailure {
                _actionError.value = actionError("启动 Desktop", it)
                fetchHostRuntime(hostId)
            }
        }
    }

    override fun refreshAll() {
        if (secure.load()?.approved != true) return
        if (rpc == null) {
            reconnect()
            return
        }
        startFullSync()
    }

    override fun setActiveThread(threadId: String?) {
        activeThreadKey = threadId?.let { runCatching { ThreadRef.parse(it).encoded() }.getOrDefault(it) }
        activeThreadKey?.let { key -> if (unreadCounts.remove(key) != null) refreshUnread(key) }
    }

    private fun bumpUnread(ref: ThreadRef) {
        val key = ref.encoded()
        if (key == activeThreadKey) return
        unreadCounts[key] = (unreadCounts[key] ?: 0) + 1
        refreshUnread(key)
    }

    private fun refreshUnread(key: String) {
        val ref = runCatching { ThreadRef.parse(key) }.getOrNull() ?: return
        threadLists[ref.hostId] = threadLists[ref.hostId].orEmpty().map {
            if (it.id == ref.threadId) it.copy(unreadCount = unreadCounts[key] ?: 0) else it
        }
        updateVisibleThreads()
    }

    override fun refreshThread(threadId: String) {
        val ref = runCatching { ThreadRef.parse(threadId) }.getOrElse { ThreadRef(_selectedHostId.value.orEmpty(), threadId) }
        scheduleThreadRefresh(ref, delayMs = 0)
    }

    override fun lastTaskTarget(): String = settings.getString("newTaskTarget", "bridge") ?: "bridge"

    override fun hostSupports(capability: String, hostId: String?): Boolean =
        capabilitiesByHost[hostId ?: _selectedHostId.value]?.contains(capability) == true

    override fun createTask(projectId: String, modelId: String, reasoningId: String, prompt: String, target: String, planMode: Boolean, goal: String?, images: List<Uri>, files: List<Uri>, onCreated: (String) -> Unit) {
        val resolvedTarget = if (target == "desktop") "desktop" else "bridge"
        val hostId = _selectedHostId.value
        val project = _projects.value.firstOrNull { it.id == projectId }
        if (hostId == null || project == null || !_hosts.value.any { it.id == hostId && it.connectionState == ConnectionState.Connected }) {
            _actionError.value = "请先选择一台在线电脑和项目"
            return
        }
        if (_creatingTask.value) return
        if ((images.isNotEmpty() || files.isNotEmpty()) && !hostSupports("attachments-v1", hostId)) {
            _actionError.value = "这台 Windows Host 版本过旧，不支持附件；请先覆盖更新 Host"
            return
        }
        if (planMode && resolvedTarget == "bridge" && !hostSupports("plan-v1", hostId)) {
            _actionError.value = "这台 Windows Host 版本过旧，不支持 Plan 模式；请先覆盖更新 Host"
            return
        }
        if (!goal.isNullOrBlank() && resolvedTarget == "bridge" && !hostSupports("goal-v1", hostId)) {
            _actionError.value = "这台 Windows Host 版本过旧，不支持持久 Goal；请先覆盖更新 Host"
            return
        }
        settings.edit().putString("newTaskTarget", resolvedTarget).apply()
        _creatingTask.value = true
        scope.launch {
            runCatching {
                val encoded = encodeAttachments(images, files)
                val result = innerCall(
                    hostId,
                    "thread/start",
                    obj(
                        "cwd" to project.cwd,
                        "text" to prompt,
                        "model" to modelId,
                        "effort" to reasoningId,
                        "target" to resolvedTarget,
                        "mode" to (if (planMode && resolvedTarget == "bridge") "plan" else null),
                        "goal" to goal?.trim()?.takeIf { resolvedTarget == "bridge" && it.isNotBlank() },
                        "workspaceMode" to "local",
                        "clientMessageId" to "mobile-${System.currentTimeMillis()}",
                        "images" to encoded.images,
                        "files" to encoded.files,
                    ),
                ).requireObject("新建任务")
                result
            }.onSuccess { result ->
                val thread = result.obj("thread") ?: return@onSuccess
                val rawId = thread.string("id") ?: return@onSuccess
                val ref = ThreadRef(hostId, rawId)
                val summary = summaryFromJson(hostId, thread).let { base ->
                    // Bridge threads carry no preview yet; fall back to the prompt.
                    val titled = if (base.title != "未命名任务") base
                    else base.copy(
                        title = prompt.lineSequence().firstOrNull()?.take(40).orEmpty().ifBlank { base.title },
                        lastMessage = prompt.take(120),
                    )
                    if (titled.updatedAtEpoch > 0) titled
                    else titled.copy(updatedAtEpoch = System.currentTimeMillis() / 1000, updatedAt = formatTime(System.currentTimeMillis() / 1000))
                }
                threadLists[hostId] = listOf(summary) + threadLists[hostId].orEmpty().filterNot { it.id == rawId }
                updateVisibleThreads()
                onCreated(ref.encoded())
                result.string("warning")?.takeIf { it.isNotBlank() }?.let { _actionError.value = it }
                scheduleThreadRefresh(ref, delayMs = 0)
            }.onFailure { _actionError.value = actionError("创建任务", it) }
            _creatingTask.value = false
        }
    }

    override fun threadGoal(threadId: String, onResult: (String?) -> Unit) {
        goalCall(threadId, "goal/get", null, "读取目标", onResult)
    }

    override fun setThreadGoal(threadId: String, objective: String, onResult: (String?) -> Unit) {
        goalCall(threadId, "goal/set", objective, "设置目标", onResult)
    }

    override fun clearThreadGoal(threadId: String, onResult: (String?) -> Unit) {
        goalCall(threadId, "goal/clear", null, "清除目标", onResult)
    }

    private fun goalCall(threadId: String, method: String, objective: String?, action: String, onResult: (String?) -> Unit) {
        val ref = runCatching { ThreadRef.parse(threadId) }.getOrElse { ThreadRef(_selectedHostId.value.orEmpty(), threadId) }
        scope.launch {
            runCatching {
                innerCall(ref.hostId, method, buildJsonObject {
                    put("threadId", ref.threadId)
                    objective?.let { put("objective", it) }
                }).asObject()?.obj("goal")?.string("objective")
            }.onSuccess(onResult)
                .onFailure { _actionError.value = actionError(action, it); onResult(null) }
        }
    }

    override fun sendSteer(threadId: String, text: String, planMode: Boolean, images: List<Uri>, files: List<Uri>) {
        val ref = resolveThreadRef(threadId, _selectedHostId.value) ?: run {
            _actionError.value = "发送失败：任务缺少电脑上下文，请从任务列表重新打开"
            return
        }
        val key = ref.encoded()
        if ((images.isNotEmpty() || files.isNotEmpty()) && !hostSupports("attachments-v1", ref.hostId)) {
            _actionError.value = "发送失败：这台 Windows Host 版本过旧，不支持附件；请先覆盖更新 Host"
            return
        }
        if (planMode && !hostSupports("plan-v1", ref.hostId)) {
            _actionError.value = "发送失败：这台 Windows Host 版本过旧，不支持 Plan 模式；请先覆盖更新 Host"
            return
        }
        val effectiveText = text.ifBlank {
            when {
                images.isNotEmpty() && files.isNotEmpty() -> "请分析附加的图片和文件。"
                images.isNotEmpty() -> "请分析附加的图片。"
                else -> "请分析附加的文件。"
            }
        }
        val messageId = "user-${System.currentTimeMillis()}"
        upsert(
            ref,
            TimelineItem.Message(
                messageId,
                Role.User,
                buildString {
                    append(effectiveText)
                    val labels = buildList {
                        if (images.isNotEmpty()) add("${images.size} 张图片")
                        if (files.isNotEmpty()) add("${files.size} 个文件")
                    }
                    if (labels.isNotEmpty()) append("\n\n（附带 ${labels.joinToString("、")}）")
                },
                MessageStatus.Streaming,
            ),
        )
        scope.launch {
            runCatching {
                val encoded = encodeAttachments(images, files)
                val turnId = details[key]?.value?.activeTurnId
                if (turnId == null) innerCall(
                    ref.hostId,
                    "turn/start",
                    obj(
                        "threadId" to ref.threadId,
                        "text" to effectiveText,
                        "mode" to (if (planMode) "plan" else null),
                        "images" to encoded.images,
                        "files" to encoded.files,
                        "clientMessageId" to messageId,
                    ),
                )
                else innerCall(
                    ref.hostId,
                    "turn/steer",
                    obj(
                        "threadId" to ref.threadId,
                        "expectedTurnId" to turnId,
                        "text" to effectiveText,
                        "images" to encoded.images,
                        "files" to encoded.files,
                        "clientMessageId" to messageId,
                    ),
                )
            }.onSuccess { updateMessageStatus(ref, messageId, MessageStatus.Done) }
                .onFailure { error ->
                    val currentStatus = details[key]?.value?.items
                        ?.filterIsInstance<TimelineItem.Message>()
                        ?.firstOrNull { it.id == messageId }
                        ?.status
                    if (shouldMarkSendFailed(currentStatus)) {
                        updateMessageStatus(ref, messageId, MessageStatus.Failed)
                        _actionError.value = actionError("发送", error)
                    }
                }
        }
    }

    override fun interruptTurn(threadId: String) {
        val ref = ThreadRef.parse(threadId)
        val turnId = details[ref.encoded()]?.value?.activeTurnId ?: return
        scope.launch { runCatching { innerCall(ref.hostId, "turn/interrupt", obj("threadId" to ref.threadId, "turnId" to turnId)) } }
    }

    override fun resolveApproval(threadId: String, requestId: String, decision: ApprovalDecision) {
        val ref = ThreadRef.parse(threadId)
        val value = when (decision) {
            ApprovalDecision.AllowOnce -> "allowOnce"
            ApprovalDecision.Deny -> "deny"
            ApprovalDecision.Cancel -> "cancel"
        }
        scope.launch {
            runCatching { innerCall(ref.hostId, "approval/respond", obj("requestId" to requestId, "decision" to value)) }
                .onSuccess { updateItem(ref, requestId) { (it as TimelineItem.Approval).copy(decision = decision) } }
        }
    }

    override fun answerQuestion(threadId: String, requestId: String, questionId: String, option: String) {
        val ref = ThreadRef.parse(threadId)
        val answerKey = "${ref.hostId}:$requestId"
        val collected = pendingAnswers.getOrPut(answerKey) { mutableMapOf() }
        collected[questionId] = option
        updateItem(ref, requestId) { item ->
            if (item is TimelineItem.Question && item.questionId == questionId) item.copy(selectedOption = option) else item
        }
        if (collected.size < (questionCounts[answerKey] ?: 1)) return
        val answers = buildJsonObject {
            collected.forEach { (id, answer) -> put(id, buildJsonObject { put("answers", buildJsonArray { add(JsonPrimitive(answer)) }) }) }
        }
        scope.launch { runCatching { innerCall(ref.hostId, "question/respond", buildJsonObject { put("requestId", requestId); put("answers", answers) }) } }
    }

    override fun pairManually(wssUrl: String, pairingCode: String) {
        _authStatus.value = "v2 请使用 Relay 用户名和密码登录"
    }

    override fun pairFromQr(payload: String) = approveHostFromQr(payload)

    override fun resetPairing() {
        connectionGeneration.incrementAndGet()
        connectionJob?.cancel()
        pendingApprovalJob?.cancel()
        fullSyncJob?.cancel()
        fullSyncRerun = false
        val syncJobs = hostSyncJobs.values.toList()
        hostSyncJobs.clear()
        syncJobs.forEach { it.cancel() }
        hostSyncRerun.clear()
        val refreshJobs = threadRefreshJobs.values.toList()
        threadRefreshJobs.clear()
        refreshJobs.forEach { it.cancel() }
        pendingThreadRefreshes.clear()
        unreadCounts.clear()
        activeThreadKey = null
        _syncing.value = false
        _syncStatus.value = null
        _refreshingThreads.value = emptySet()
        rpc?.close()
        channels.clear()
        capabilitiesByHost.clear()
        val pendingCalls = innerPending.values.toList()
        innerPending.clear()
        pendingCalls.forEach { it.cancel() }
        secure.clear()
        _isPaired.value = false
        _authStatus.value = "已退出登录"
        _hosts.value = emptyList()
        _threads.value = emptyList()
        _projects.value = emptyList()
        _models.value = emptyList()
        _accountDevices.value = emptyList()
        _host.value = aggregateHost("尚未登录")
    }

    override fun setNotificationsEnabled(enabled: Boolean) {
        _device.value = _device.value.copy(notificationEnabled = enabled)
        settings.edit().putBoolean("notifications", enabled).apply()
    }

    override fun clearActionError() { _actionError.value = null }

    private fun reconnect() {
        if (pausedForLimit || secure.load()?.approved != true) return
        if (connectionJob?.isActive == true) return
        val generation = connectionGeneration.incrementAndGet()
        rpc?.close()
        connectionJob = scope.launch { connectLoop(generation) }
    }

    private suspend fun connectLoop(initialGeneration: Long) {
        var generation = initialGeneration
        var backoff = 1_000L
        while (currentCoroutineContext().isActive && !pausedForLimit) {
            var credentials = secure.load()?.takeIf { it.approved } ?: return
            var client: BridgeRpcClient? = null
            var connectionReady: CompletableDeferred<Unit>? = null
            try {
                if (credentials.accessExpiresAt < System.currentTimeMillis() + 30_000) credentials = refreshCredentials(credentials)
                markRelayConnecting()
                val clientGeneration = generation
                val nextReady = CompletableDeferred<Unit>()
                val nextClient = BridgeRpcClient(http, websocketUrl(credentials.endpoint), credentials.accessToken) { notification ->
                    if (clientGeneration == connectionGeneration.get()) {
                        scope.launch {
                            if (clientGeneration != connectionGeneration.get()) return@launch
                            runCatching { processOuterNotification(notification) }
                                .onFailure {
                                    if (!isTransientConnectionFailure(it)) {
                                        _actionError.value = actionError("处理 Relay 消息", it)
                                    }
                                }
                        }
                    }
                }
                client = nextClient
                connectionReady = nextReady
                rpc = nextClient
                relayReady = nextReady
                nextClient.connect()
                withTimeout(15_000) { nextClient.awaitOpen() }
                nextClient.call("relay/hello", obj("protocolVersion" to 2, "deviceId" to credentials.deviceId))
                nextReady.complete(Unit)
                backoff = 1_000L
                startFullSync()
                nextClient.awaitClosed()
            } catch (error: Throwable) {
                if (!currentCoroutineContext().isActive) return
            } finally {
                val disconnected = BridgeRpcException("Relay 连接中断，正在自动恢复", CONNECTION_LOST_CODE)
                if (rpc === client) rpc = null
                if (relayReady === connectionReady) relayReady = null
                client?.close()
                connectionReady?.completeExceptionally(disconnected)
                // Completing a deferred resumes its waiter immediately on Main.immediate.
                // Drain the maps first so waiter cleanup cannot mutate a map while it is
                // being iterated (which would crash with ConcurrentModificationException).
                val disconnectedChannels = channels.values.toList()
                channels.clear()
                disconnectedChannels.forEach { it.ready.completeExceptionally(disconnected) }
                val disconnectedCalls = innerPending.values.toList()
                innerPending.clear()
                disconnectedCalls.forEach { it.completeExceptionally(disconnected) }
            }
            if (!currentCoroutineContext().isActive) return
            markRelayDisconnected()
            generation = connectionGeneration.incrementAndGet()
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(30_000)
        }
    }

    private suspend fun syncHosts() {
        val result = outerCall("host/list") as? JsonArray ?: JsonArray(emptyList())
        hostInfos.clear()
        result.mapNotNull { it.asObject() }.forEach { value ->
            val info = RelayHostInfo(
                id = value.string("id") ?: return@forEach,
                name = value.string("name") ?: "Windows Codex",
                signingPublicKey = value.string("signingPublicKey") ?: return@forEach,
                encryptionPublicKey = value.string("encryptionPublicKey") ?: return@forEach,
                online = value.boolean("online") == true,
                lastSeenAt = value.long("lastSeenAt"),
            )
            hostInfos[info.id] = info
        }
        capabilitiesByHost.keys.retainAll(hostInfos.keys)
        updateHosts()
    }

    /** Single-flight full sync; triggers while one is running coalesce into one rerun. */
    private fun startFullSync() {
        if (fullSyncJob?.isActive == true) {
            fullSyncRerun = true
            return
        }
        fullSyncJob = scope.launch {
            do {
                fullSyncRerun = false
                val syncGeneration = connectionGeneration.get()
                try {
                    performFullSync()
                    if (syncGeneration == connectionGeneration.get()) clearActionError("刷新")
                } catch (error: CancellationException) {
                    throw error
                } catch (error: Throwable) {
                    if (
                        syncGeneration == connectionGeneration.get() &&
                        !isTransientConnectionFailure(error) &&
                        rpc != null
                    ) {
                        _actionError.value = actionError("刷新", error)
                    }
                }
            } while (fullSyncRerun)
        }
    }

    private suspend fun performFullSync() {
        _syncing.value = true
        try {
            _syncStatus.value = "正在获取电脑与设备列表…"
            syncHosts()
            reloadDevices()
            registerPushIfReady()
            val ids = hostInfos.keys.toList()
            ids.forEachIndexed { index, hostId ->
                _syncStatus.value = "正在同步 ${hostInfos[hostId]?.name ?: "Windows Codex"}（${index + 1}/${ids.size}）…"
                syncHost(hostId)
            }
        } finally {
            _syncing.value = false
            _syncStatus.value = null
        }
    }

    /** Single-flight per-host resync; triggers while one is running coalesce into one rerun. */
    private fun scheduleHostSync(hostId: String) {
        if (hostSyncJobs[hostId]?.isActive == true) {
            hostSyncRerun.add(hostId)
            return
        }
        hostSyncJobs[hostId] = scope.launch {
            do {
                syncHost(hostId)
            } while (hostSyncRerun.remove(hostId))
        }
    }

    private suspend fun syncHost(hostId: String) {
        val credentials = secure.load()?.takeIf { it.approved } ?: return
        var failure: Throwable? = null
        suspend fun attempt(block: suspend () -> Unit): Boolean {
            return try {
                block()
                true
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                if (isTransientConnectionFailure(error)) {
                    queueActiveThreadRefresh()
                    false
                } else {
                    if (failure == null) failure = error
                    true
                }
            }
        }
        if (!attempt {
            val snapshot = outerCall("snapshot/get", obj("hostId" to hostId)).asObject()
            val envelope = snapshot?.obj("envelope")?.let(::envelopeFromJson)
            if (envelope != null) {
                val plain = withContext(Dispatchers.Default) {
                    RelayCrypto.decryptAccountEnvelope(envelope, credentials.contentKey!!)
                }
                applySnapshot(hostId, plain)
            }
        }) return
        if (!attempt { replayEvents(hostId, credentials) }) return
        if (hostInfos[hostId]?.online == true) {
            if (!attempt {
                ensureChannel(hostId)
                syncHostMetadata(hostId)
                syncThreads(hostId)
            }) return
            retryPendingThreadRefreshes(hostId)
            val action = "同步 ${hostInfos[hostId]?.name ?: "目标电脑"}"
            failure?.let { _actionError.value = "$action 失败：${it.message}" }
                ?: clearActionError(action)
        }
    }

    private suspend fun syncHostMetadata(hostId: String) {
        _projectsLoading.value = true
        try {
            val credentials = secure.load()?.takeIf { it.approved } ?: throw BridgeRpcException("尚未登录")
            val hello = innerCall(
                hostId,
                "bridge/hello",
                obj("protocolVersion" to 1, "deviceId" to credentials.deviceId),
            ).requireObject("Host 能力")
            capabilitiesByHost[hostId] = hello.array("capabilities")
                .mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                .toSet()
            runCatching { fetchHostRuntime(hostId) }
            val projectsResult = innerCall(hostId, "project/list").requireObject("项目列表")
            projectsByHost[hostId] = projectsResult.array("data").mapNotNull { element ->
                val item = element.asObject() ?: return@mapNotNull null
                val id = item.string("id").orEmpty()
                val cwd = item.string("cwd").orEmpty()
                if (id.isBlank() || cwd.isBlank()) null else Project(id, item.string("name") ?: cwd.substringAfterLast('\\').substringAfterLast('/'), cwd)
            }
            val modelResult = innerCall(hostId, "model/list").requireObject("模型列表")
            modelsByHost[hostId] = modelResult.array("data").mapNotNull(::modelFromJson)
            if (_selectedHostId.value == hostId) updateVisibleState()
        } finally {
            _projectsLoading.value = false
        }
    }

    private suspend fun fetchHostRuntime(hostId: String) {
        updateHostRuntime(hostId, innerCall(hostId, "host/runtime").requireObject("Desktop 状态"))
    }

    private fun updateHostRuntime(hostId: String, value: JsonObject) {
        val desktop = value.obj("desktop")
        val state = when (desktop?.string("state")) {
            "ready" -> DesktopRuntimeState.Ready
            "starting" -> DesktopRuntimeState.Starting
            "closed" -> DesktopRuntimeState.Closed
            else -> DesktopRuntimeState.Unavailable
        }
        _hostRuntimes.value = _hostRuntimes.value + (
            hostId to HostRuntime(
                hostId = hostId,
                desktopState = state,
                attachReady = desktop?.boolean("attachReady") == true,
                processRunning = desktop?.boolean("processRunning") == true,
                canWake = desktop?.boolean("canWake") == true,
            )
        )
    }

    /**
     * Keep encrypted relay messages comfortably below the 2 MiB ciphertext
     * ceiling. Images are sampled and JPEG-compressed on-device. Small user
     * documents are copied as bytes and materialized only on the selected Host;
     * Relay receives the already E2E-encrypted RPC envelope.
     */
    private suspend fun encodeAttachments(imageUris: List<Uri>, fileUris: List<Uri>): EncodedAttachments = withContext(Dispatchers.IO) {
        if (imageUris.size + fileUris.size > MAX_ATTACHMENT_COUNT) {
            throw BridgeRpcException("每次最多发送 $MAX_ATTACHMENT_COUNT 个附件")
        }
        var totalBytes = 0
        val encodedImages = buildJsonArray {
            imageUris.forEach { uri ->
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw BridgeRpcException("无法读取所选图片")
                var sample = 1
                while (bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600) sample *= 2
                val bitmap = context.contentResolver.openInputStream(uri)?.use {
                    BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample })
                } ?: throw BridgeRpcException("无法解码所选图片")
                val output = ByteArrayOutputStream()
                try {
                    var quality = 84
                    do {
                        output.reset()
                        bitmap.compress(android.graphics.Bitmap.CompressFormat.JPEG, quality, output)
                        quality -= 12
                    } while (output.size() > 360 * 1024 && quality >= 36)
                    val bytes = output.toByteArray()
                    if (bytes.size > 450 * 1024) throw BridgeRpcException("图片过大，请裁剪后重试")
                    totalBytes += bytes.size
                    if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw BridgeRpcException("附件总量过大，请减少附件数量")
                    add(buildJsonObject {
                        put("mimeType", "image/jpeg")
                        put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                    })
                } finally {
                    bitmap.recycle()
                    output.close()
                }
            }
        }
        val encodedFiles = buildJsonArray {
            fileUris.forEach { uri ->
                val filename = attachmentDisplayName(uri)
                val extension = filename.substringAfterLast('.', "").lowercase()
                val mimeType = context.contentResolver.getType(uri)?.lowercase()
                    ?: MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension)
                    ?: "application/octet-stream"
                if (!isSupportedAttachmentFile(filename, mimeType)) {
                    throw BridgeRpcException("暂不支持文件：$filename；请选择文本、代码、配置、日志、CSV 或 PDF")
                }
                val bytes = readAttachmentBytes(uri)
                totalBytes += bytes.size
                if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw BridgeRpcException("附件总量过大，请减少附件数量")
                add(buildJsonObject {
                    put("filename", filename)
                    put("mimeType", mimeType)
                    put("data", Base64.encodeToString(bytes, Base64.NO_WRAP))
                })
            }
        }
        EncodedAttachments(encodedImages, encodedFiles)
    }

    private fun attachmentDisplayName(uri: Uri): String {
        val queried = runCatching {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    .takeIf { it >= 0 }
                    ?.let(cursor::getString)
                else null
            }
        }.getOrNull()
        return (queried ?: uri.lastPathSegment ?: "attachment.txt")
            .replace(Regex("[\\u0000-\\u001F\\u007F]"), "_")
            .take(160)
            .ifBlank { "attachment.txt" }
    }

    private fun isSupportedAttachmentFile(filename: String, mimeType: String): Boolean {
        val lowerName = filename.lowercase()
        val extension = lowerName.substringAfterLast('.', "")
        if (extension in SAFE_FILE_EXTENSIONS || lowerName in setOf(".env", "dockerfile", "makefile")) return true
        return mimeType.startsWith("text/") || mimeType in setOf(
            "application/json",
            "application/xml",
            "application/pdf",
            "application/yaml",
            "application/x-yaml",
            "application/javascript",
            "application/sql",
        )
    }

    private fun readAttachmentBytes(uri: Uri): ByteArray {
        val output = ByteArrayOutputStream()
        context.contentResolver.openInputStream(uri)?.use { input ->
            val buffer = ByteArray(16 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                if (output.size() + read > MAX_FILE_ATTACHMENT_BYTES) {
                    throw BridgeRpcException("单个文件不能超过 512 KiB")
                }
                output.write(buffer, 0, read)
            }
        } ?: throw BridgeRpcException("无法读取所选文件")
        return output.toByteArray().also {
            if (it.isEmpty()) throw BridgeRpcException("不能发送空文件")
        }
    }

    private suspend fun syncThreads(hostId: String) {
        val result = innerCall(hostId, "thread/list").requireObject("任务列表")
        threadLists[hostId] = result.array("data")
            .mapNotNull { it.asObject()?.let { value -> summaryFromJson(hostId, value) } }
            .filterNot { it.archived }
        updateVisibleThreads()
    }

    private suspend fun fetchThread(ref: ThreadRef) {
        val key = ref.encoded()
        val flow = details.getOrPut(key) { MutableStateFlow(emptyDetail(ref)) }
        if (hostInfos[ref.hostId]?.online != true) {
            pendingThreadRefreshes += key
            val summary = threadLists[ref.hostId]?.firstOrNull { it.id == ref.threadId }
            flow.value = flow.value.copy(
                title = summary?.title ?: flow.value.title,
                cwd = summary?.cwd ?: flow.value.cwd,
                status = summary?.status ?: flow.value.status,
                preview = summary?.lastMessage?.ifBlank { flow.value.preview } ?: flow.value.preview,
                loading = false,
                loadError = "${hostInfos[ref.hostId]?.name ?: "目标电脑"}当前离线；恢复连接后会自动加载",
            )
            return
        }
        pendingThreadRefreshes -= key
        flow.value = flow.value.copy(loading = true, loadError = null)
        val baselineItems = flow.value.items
        _refreshingThreads.value = _refreshingThreads.value + key
        try {
            var cursor: String? = null
            var base: JsonObject? = null
            var order: String? = null
            val turns = mutableListOf<JsonElement>()
            val seen = mutableSetOf<String>()
            do {
                val result = innerCall(ref.hostId, "thread/read", buildJsonObject { put("threadId", ref.threadId); cursor?.let { put("cursor", it) } }).requireObject("读取任务")
                val thread = result.obj("thread") ?: error("任务详情缺少 thread")
                if (base == null) base = thread
                turns.addAll(thread.array("turns"))
                val page = result.obj("page")
                if (order == null) order = page?.string("order")
                cursor = page?.takeIf { it.boolean("hasMore") == true }?.string("nextCursor")
                if (cursor != null && !seen.add(cursor!!)) error("任务历史分页游标重复")
            } while (cursor != null)
            val baseThread = base ?: error("任务详情缺少 thread")
            val collectedTurns = turns.toList()
            val parsed = withContext(Dispatchers.Default) {
                val orderedTurns = if (order == "newest_first") collectedTurns.asReversed() else collectedTurns
                val merged = JsonObject(baseThread.toMutableMap().apply { put("turns", JsonArray(orderedTurns)) })
                parseThreadDetail(merged)
            }
            val current = flow.value
            // No suspension between this merge and assignment: completed live
            // events that arrived while JSON was parsed off-main must not be
            // overwritten by an older thread/read response.
            val mergedItems = mergeTimelineItems(parsed.items, current.items, baselineItems)
            flow.value = ThreadDetail(
                id = ref.threadId,
                title = parsed.title,
                cwd = parsed.cwd,
                status = if (parsed.source == "desktop") ThreadStatus.DesktopOwned else statusFromJson(key, parsed.status, parsed.activeTurnId != null),
                items = mergedItems,
                activeTurnId = parsed.activeTurnId,
                preview = current.preview,
                loading = false,
                loadError = null,
            )
            clearActionError("读取任务")
            clearActionError("同步 ${hostInfos[ref.hostId]?.name ?: "目标电脑"}")
        } catch (error: CancellationException) {
            throw error
        } catch (error: Throwable) {
            val transient = isTransientConnectionFailure(error) || hostInfos[ref.hostId]?.online != true
            if (transient) pendingThreadRefreshes += key
            val message = if (transient) "连接暂时中断，正在自动恢复任务内容…" else actionError("读取任务", error)
            flow.value = flow.value.copy(loading = false, loadError = message)
            if (!transient) _actionError.value = message
        } finally {
            _refreshingThreads.value = _refreshingThreads.value - key
        }
    }

    private fun retryPendingThreadRefreshes(hostId: String) {
        pendingThreadRefreshes.toList()
            .mapNotNull { runCatching { ThreadRef.parse(it) }.getOrNull() }
            .filter { it.hostId == hostId }
            .forEach { scheduleThreadRefresh(it, delayMs = 0) }
    }

    private suspend fun ensureChannel(hostId: String): ChannelState {
        channels[hostId]?.let { existing ->
            try {
                withTimeout(15_000) { existing.ready.await() }
                return existing
            } catch (error: Throwable) {
                // 通道未就绪或握手失败：丢弃后重建，而不是让这台 Host 永久占着一条死通道。
                channels.remove(hostId, existing)
                if (error is CancellationException && error !is TimeoutCancellationException) throw error
            }
        }
        val credentials = secure.load()?.takeIf { it.approved } ?: throw BridgeRpcException("尚未登录")
        val host = hostInfos[hostId]?.takeIf { it.online } ?: throw BridgeRpcException("目标电脑离线", "HOST_OFFLINE")
        val (crypto, envelope) = RelayCrypto.openChannel(credentials, host, UUID.randomUUID().toString())
        val state = ChannelState(crypto)
        channels[hostId] = state
        try {
            outerCall("channel/open", buildJsonObject { put("envelope", json.encodeToJsonElement(RelayEnvelope.serializer(), envelope)) })
            withTimeout(15_000) { state.ready.await() }
            return state
        } catch (_: TimeoutCancellationException) {
            channels.remove(hostId, state)
            throw BridgeRpcException("Host 通道握手超时，正在自动恢复", CHANNEL_TIMEOUT_CODE)
        } catch (error: Throwable) {
            channels.remove(hostId, state)
            throw error
        }
    }

    private suspend fun innerCall(hostId: String, method: String, params: JsonObject = JsonObject(emptyMap())): JsonElement {
        val state = ensureChannel(hostId)
        val id = innerIds.getAndIncrement()
        val deferred = CompletableDeferred<JsonElement>()
        innerPending[state.crypto.channelId to id] = deferred
        val request = buildJsonObject { put("jsonrpc", "2.0"); put("id", id); put("method", method); put("params", params) }
        return try {
            withTimeout(INNER_RPC_TIMEOUT_MS) {
                val envelope = state.crypto.encrypt(request.toString())
                outerCall("channel/data", buildJsonObject { put("envelope", json.encodeToJsonElement(RelayEnvelope.serializer(), envelope)) })
                deferred.await()
            }
        } catch (error: TimeoutCancellationException) {
            // 超时通常意味着对端已经丢弃了这条通道（解密失败或 Host 重启）；
            // 丢弃本地通道，让下一次调用重新握手，而不是在死通道上反复超时。
            channels.remove(hostId, state)
            throw BridgeRpcException("Host 响应超时，已重置加密通道，请重试", CHANNEL_TIMEOUT_CODE)
        } finally {
            innerPending.remove(state.crypto.channelId to id)
        }
    }

    private suspend fun processOuterNotification(notification: JsonObject) {
        val method = notification.string("method") ?: return
        val params = notification.obj("params") ?: return
        when (method) {
            "channel/open" -> {
                val envelope = params.obj("envelope")?.let(::envelopeFromJson) ?: return
                val state = channels.values.firstOrNull { it.crypto.channelId == envelope.channelId } ?: return
                runCatching { state.crypto.accept(envelope) }
                    .onSuccess { state.ready.complete(Unit) }
                    .onFailure { state.ready.completeExceptionally(it); channels.remove(envelope.hostId) }
            }
            "channel/data" -> {
                val envelope = params.obj("envelope")?.let(::envelopeFromJson) ?: return
                val state = channels[envelope.hostId] ?: return
                val response = json.parseToJsonElement(state.crypto.decrypt(envelope)) as? JsonObject ?: return
                val id = response.long("id") ?: return
                val pending = innerPending.remove(envelope.channelId to id) ?: return
                response.obj("error")?.let { error ->
                    pending.completeExceptionally(BridgeRpcException(error.string("message") ?: "Host 请求失败", error.string("code") ?: error.obj("data")?.string("name")))
                } ?: pending.complete(response["result"] ?: JsonNull)
            }
            "channel/close" -> params.string("channelId")?.let { channelId ->
                channels.entries.removeAll { it.value.crypto.channelId == channelId }
                val error = BridgeRpcException("Host 通道已关闭，正在自动恢复", CHANNEL_CLOSED_CODE)
                innerPending.keys.filter { it.first == channelId }.forEach { key ->
                    innerPending.remove(key)?.completeExceptionally(error)
                }
            }
            "relay/event" -> applyStoredEvent(params)
            "snapshot/updated" -> {
                val hostId = params.string("hostId") ?: return
                if (hostInfos[hostId] == null) syncHosts()
                if (hostInfos[hostId] != null) scheduleHostSync(hostId)
            }
            "host/status" -> {
                val hostId = params.string("hostId") ?: return
                if (hostInfos[hostId] == null) syncHosts()
                hostInfos[hostId]?.let { hostInfos[hostId] = it.copy(online = params.boolean("online") == true) }
                updateHosts()
                if (params.boolean("online") == true) scheduleHostSync(hostId)
            }
        }
    }

    private fun eventMutex(hostId: String) = hostEventMutexes.getOrPut(hostId) { Mutex() }

    private suspend fun replayEvents(hostId: String, credentials: RelayCredentials) {
        val events = try {
            outerCall("event/replay", obj("hostId" to hostId, "lastSeq" to secure.lastSeq(hostId))) as? JsonArray ?: return
        } catch (error: BridgeRpcException) {
            if (error.nameCode != "EVENT_GAP") throw error
            secure.setLastSeq(hostId, 0)
            outerCall("event/replay", obj("hostId" to hostId, "lastSeq" to 0)) as? JsonArray ?: return
        }
        val mutex = eventMutex(hostId)
        mutex.lock()
        try {
            for (event in events.mapNotNull { it.asObject() }) {
                val envelope = event.obj("envelope")?.let(::envelopeFromJson) ?: continue
                applyStoredEventLocked(hostId, envelope, event, credentials)
            }
        } finally {
            mutex.unlock()
        }
    }

    private suspend fun applyStoredEvent(stored: JsonObject) {
        val envelope = stored.obj("envelope")?.let(::envelopeFromJson) ?: return
        val hostId = envelope.hostId
        val mutex = eventMutex(hostId)
        mutex.lock()
        val gap = try {
            applyStoredEventLocked(hostId, envelope, stored, null)
        } finally {
            mutex.unlock()
        }
        if (gap) scheduleHostSync(hostId)
    }

    /**
     * Applies one stored event under the host's event mutex and returns true
     * when a sequence gap requires a host resync. A single undecryptable or
     * unprocessable event no longer wedges the cursor: it is skipped, the
     * cursor still advances, and a scheduled resync repairs thread state.
     */
    private suspend fun applyStoredEventLocked(hostId: String, envelope: RelayEnvelope, stored: JsonObject, supplied: RelayCredentials?): Boolean {
        val seq = stored.long("seq") ?: return false
        val credentials = supplied ?: secure.load()?.takeIf { it.approved } ?: return false
        when (eventSeqDecision(secure.lastSeq(hostId), seq)) {
            EventSeqDecision.Skip -> return false
            EventSeqDecision.Gap -> return true
            EventSeqDecision.Apply -> Unit
        }
        try {
            val event = withContext(Dispatchers.Default) {
                json.parseToJsonElement(RelayCrypto.decryptAccountEnvelope(envelope, credentials.contentKey!!)) as JsonObject
            }
            envelope.eventId?.let { eventId ->
                event.string("threadId")?.let { threadId -> notificationRefs[eventId] = ThreadRef(hostId, threadId).encoded() }
            }
            processBridgeEvent(hostId, event)
        } catch (error: CancellationException) {
            throw error
        } catch (_: Throwable) {
            scheduleHostSync(hostId)
        }
        secure.setLastSeq(hostId, seq)
        return false
    }

    private fun processBridgeEvent(hostId: String, event: JsonObject) {
        val type = event.string("type") ?: return
        val rawThreadId = event.string("threadId")
        val ref = rawThreadId?.let { ThreadRef(hostId, it) }
        val turnId = event.string("turnId")
        val payload = event.obj("payload") ?: JsonObject(emptyMap())
        when (type) {
            "message.delta" -> if (ref != null) applyMessageEvent(ref, turnId, payload)
            "plan.updated" -> if (ref != null) applyPlan(ref, turnId, payload)
            "command.updated" -> if (ref != null) applyCommand(ref, payload)
            "diff.updated" -> if (ref != null) diffs.getOrPut(ref.encoded()) { MutableStateFlow(emptyList()) }.value = parseDiff(payload.string("diff").orEmpty(), payload.boolean("truncated") == true)
            "approval.request" -> if (ref != null) applyApproval(ref, payload)
            "question.request" -> if (ref != null) applyQuestion(ref, payload)
            "turn.status" -> if (ref != null) applyTurnStatus(ref, turnId, payload)
            // 全量拉取不再阻塞事件游标：改为防抖后的后台校正。
            "sync.required" -> if (ref != null) scheduleThreadRefresh(ref) else scheduleHostSync(hostId)
        }
    }

    /** Debounced full-thread correction; coalesces bursts of sync.required events. */
    private fun scheduleThreadRefresh(ref: ThreadRef, delayMs: Long = 400) {
        val key = ref.encoded()
        // The active read already merges events that arrive while it is in
        // flight, so another full pagination pass would only add latency.
        if (threadRefreshJobs[key]?.isActive == true) return
        lateinit var job: Job
        job = scope.launch(start = CoroutineStart.LAZY) {
            try {
                if (delayMs > 0) delay(delayMs)
                fetchThread(ref)
            } finally {
                if (threadRefreshJobs[key] === job) threadRefreshJobs.remove(key)
            }
        }
        threadRefreshJobs[key] = job
        job.start()
    }

    private suspend fun applySnapshot(hostId: String, plain: String) {
        val rows = withContext<List<JsonObject>?>(Dispatchers.Default) {
            val root = json.parseToJsonElement(plain) as? JsonObject ?: return@withContext null
            val result = root.obj("threads") ?: return@withContext null
            result.array("data").mapNotNull { it.asObject() }
        } ?: return
        threadLists[hostId] = rows.map { summaryFromJson(hostId, it) }.filterNot { it.archived }
        updateVisibleThreads()
    }

    private fun applyMessageEvent(ref: ThreadRef, turnId: String?, payload: JsonObject) {
        val itemId = payload.string("itemId") ?: "agent-$turnId"
        val delta = payload.string("delta").orEmpty()
        if (payload.boolean("replace") == true) {
            deltaJobs.remove(ref.encoded() to itemId)?.cancel()
            deltaBuffers.remove(ref.encoded() to itemId)
            val role = if (payload.string("role") == "user") Role.User else Role.Assistant
            val isNew = details[ref.encoded()]?.value?.items?.none { it.id == itemId } ?: true
            upsert(ref, TimelineItem.Message(itemId, role, delta, if (payload.boolean("complete") == true) MessageStatus.Done else MessageStatus.Streaming))
            if (isNew && role == Role.Assistant) bumpUnread(ref)
            return
        }
        val key = ref.encoded() to itemId
        deltaBuffers.getOrPut(key) { StringBuilder() }.append(delta)
        if (deltaJobs[key]?.isActive == true) return
        deltaJobs[key] = scope.launch { delay(50); flushDelta(ref, itemId) }
    }

    private fun flushDelta(ref: ThreadRef, itemId: String) {
        val key = ref.encoded() to itemId
        deltaJobs.remove(key)
        val delta = deltaBuffers.remove(key)?.toString().orEmpty()
        if (delta.isEmpty()) return
        val flow = details.getOrPut(ref.encoded()) { MutableStateFlow(emptyDetail(ref)) }
        val existing = flow.value.items.filterIsInstance<TimelineItem.Message>().firstOrNull { it.id == itemId }
        if (existing == null) bumpUnread(ref)
        upsert(ref, existing?.copy(text = existing.text + delta) ?: TimelineItem.Message(itemId, Role.Assistant, delta, MessageStatus.Streaming))
    }

    private fun applyPlan(ref: ThreadRef, turnId: String?, payload: JsonObject) {
        val steps = payload.array("plan").mapIndexedNotNull { index, element -> element.asObject()?.let { PlanStep(index, it.string("step").orEmpty(), when (it.string("status")) { "completed" -> StepStatus.Done; "inProgress" -> StepStatus.InProgress; else -> StepStatus.Pending }) } }
        upsert(ref, TimelineItem.Plan("plan-${turnId ?: "current"}", steps, if (steps.all { it.status == StepStatus.Done }) PlanStatus.Done else PlanStatus.InProgress))
    }

    private fun applyCommand(ref: ThreadRef, payload: JsonObject) {
        val item = payload.obj("item") ?: payload
        val id = item.string("id") ?: payload.string("itemId") ?: return
        val current = details[ref.encoded()]?.value?.items?.filterIsInstance<TimelineItem.Command>()?.firstOrNull { it.id == id }
        val combined = payload.string("delta")?.let { current?.output.orEmpty() + it } ?: item.string("aggregatedOutput") ?: current?.output.orEmpty()
        upsert(ref, TimelineItem.Command(id, item.commandText() ?: current?.label ?: "命令", item.string("cwd") ?: current?.cwd.orEmpty(), when (item.string("status")) { "completed" -> CommandStatus.Succeeded; "failed", "declined" -> CommandStatus.Failed; else -> current?.status ?: CommandStatus.Running }, combined.takeLast(MAX_COMMAND_OUTPUT_CHARS), combined.length > MAX_COMMAND_OUTPUT_CHARS || payload.boolean("truncated") == true))
    }

    private fun applyApproval(ref: ThreadRef, payload: JsonObject) {
        val requestId = payload.string("requestId") ?: return
        upsert(ref, TimelineItem.Approval(requestId, requestId, payload.string("reason") ?: "Codex 请求允许一次", payload.commandText().orEmpty(), payload.string("cwd").orEmpty()))
        setThreadStatus(ref, ThreadStatus.NeedsAttention)
    }

    private fun applyQuestion(ref: ThreadRef, payload: JsonObject) {
        val requestId = payload.string("requestId") ?: return
        val questions = payload.array("questions").mapNotNull { it.asObject() }
        questionCounts["${ref.hostId}:$requestId"] = questions.size
        questions.forEach { question ->
            val questionId = question.string("id") ?: return@forEach
            val options = question.array("options").mapNotNull { it.asObject()?.string("label") ?: (it as? JsonPrimitive)?.contentOrNull }
            upsert(ref, TimelineItem.Question("$requestId:$questionId", requestId, questionId, question.string("question").orEmpty(), options))
        }
        setThreadStatus(ref, ThreadStatus.NeedsAttention)
    }

    private fun applyTurnStatus(ref: ThreadRef, turnId: String?, payload: JsonObject) {
        val key = ref.encoded()
        val status = payload.string("status") ?: payload.obj("status")?.string("type")
        val flow = details.getOrPut(key) { MutableStateFlow(emptyDetail(ref)) }
        when (status) {
            "started", "active" -> {
                turnId?.let { ownedTurns[key] = it }
                flow.value = flow.value.copy(status = ThreadStatus.Active, activeTurnId = turnId ?: ownedTurns[key])
                setThreadStatus(ref, ThreadStatus.Active)
            }
            "completed", "idle", "failed", "interrupted" -> {
                ownedTurns.remove(key)
                val next = if (status == "failed") ThreadStatus.NeedsAttention else ThreadStatus.Idle
                flow.value = flow.value.copy(status = next, activeTurnId = null, items = flow.value.items.map { if (it is TimelineItem.Message && it.status == MessageStatus.Streaming) it.copy(status = if (status == "interrupted") MessageStatus.Interrupted else MessageStatus.Done) else it })
                setThreadStatus(ref, next)
            }
        }
    }

    private fun summaryFromJson(hostId: String, thread: JsonObject): ThreadSummary {
        val id = thread.string("id").orEmpty()
        val preview = thread.string("preview").orEmpty()
        val epoch = thread.long("updatedAt") ?: 0
        val archivedAtPresent = thread["archivedAt"]?.let { it !is JsonNull } == true
        return ThreadSummary(
            id = id,
            title = thread.string("name") ?: preview.lineSequence().firstOrNull()?.take(40).orEmpty().ifBlank { "未命名任务" },
            cwd = thread.string("cwd").orEmpty(),
            status = if (thread.string("source") == "desktop") ThreadStatus.DesktopOwned else statusFromJson(ThreadRef(hostId, id).encoded(), thread.obj("status")),
            updatedAt = formatTime(epoch.takeIf { it > 0 }),
            lastMessage = preview.take(120),
            unreadCount = unreadCounts[ThreadRef(hostId, id).encoded()] ?: 0,
            hostId = hostId,
            hostName = hostInfos[hostId]?.name ?: "Windows Codex",
            updatedAtEpoch = epoch,
            archived = isArchivedThread(thread.boolean("archived"), thread.boolean("isArchived"), archivedAtPresent),
        )
    }

    private fun parseThreadDetail(thread: JsonObject): ParsedThreadDetail {
        val items = mutableListOf<TimelineItem>()
        var activeTurn: String? = null
        thread.array("turns").forEach { turnValue ->
            val turn = turnValue.asObject() ?: return@forEach
            if (turn.string("status") == "inProgress") activeTurn = turn.string("id")
            turn.array("items").forEach { item -> item.asObject()?.let { itemFromJson(it)?.let(items::add) } }
        }
        return ParsedThreadDetail(
            title = thread.string("name") ?: "未命名任务",
            cwd = thread.string("cwd").orEmpty(),
            source = thread.string("source"),
            status = thread.obj("status"),
            items = items.distinctBy { it.id },
            activeTurnId = activeTurn,
        )
    }

    private fun itemFromJson(item: JsonObject): TimelineItem? = when (item.string("type")) {
        "userMessage" -> TimelineItem.Message(item.string("id").orEmpty(), Role.User, displayUserText(item.array("content").mapNotNull { it.asObject()?.string("text") }.joinToString("\n")), MessageStatus.Done)
        "agentMessage" -> TimelineItem.Message(item.string("id").orEmpty(), Role.Assistant, item.string("text").orEmpty(), MessageStatus.Done)
        // Plan 文档是完整 markdown，按助手消息渲染而不是居中系统提示。
        "plan" -> TimelineItem.Message(item.string("id").orEmpty(), Role.Assistant, item.string("text").orEmpty(), MessageStatus.Done)
        "commandExecution" -> {
            val output = item.string("aggregatedOutput").orEmpty()
            TimelineItem.Command(item.string("id").orEmpty(), item.commandText().orEmpty(), item.string("cwd").orEmpty(), when (item.string("status")) { "completed" -> CommandStatus.Succeeded; "failed", "declined" -> CommandStatus.Failed; else -> CommandStatus.Running }, output.takeLast(MAX_COMMAND_OUTPUT_CHARS), output.length > MAX_COMMAND_OUTPUT_CHARS)
        }
        else -> null
    }

    private fun upsert(ref: ThreadRef, item: TimelineItem) {
        val flow = details.getOrPut(ref.encoded()) { MutableStateFlow(emptyDetail(ref)) }
        flow.value = flow.value.copy(items = if (flow.value.items.any { it.id == item.id }) flow.value.items.map { if (it.id == item.id) item else it } else flow.value.items + item)
    }

    private fun updateItem(ref: ThreadRef, requestId: String, transform: (TimelineItem) -> TimelineItem) {
        val flow = details[ref.encoded()] ?: return
        flow.value = flow.value.copy(items = flow.value.items.map { item ->
            val matches = (item is TimelineItem.Approval && item.requestId == requestId) || (item is TimelineItem.Question && item.requestId == requestId)
            if (matches) transform(item) else item
        })
    }

    private fun updateMessageStatus(ref: ThreadRef, messageId: String, status: MessageStatus) {
        val flow = details[ref.encoded()] ?: return
        flow.value = flow.value.copy(items = flow.value.items.map { if (it is TimelineItem.Message && it.id == messageId) it.copy(status = status) else it })
    }

    private fun setThreadStatus(ref: ThreadRef, status: ThreadStatus) {
        threadLists[ref.hostId] = threadLists[ref.hostId].orEmpty().map { if (it.id == ref.threadId) it.copy(status = status) else it }
        details[ref.encoded()]?.let { it.value = it.value.copy(status = status) }
        updateVisibleThreads()
    }

    private suspend fun reloadDevices() {
        val result = outerCall("device/list") as? JsonArray ?: return
        val current = secure.load()
        _accountDevices.value = result.mapNotNull { value ->
            val item = value.asObject() ?: return@mapNotNull null
            Device(
                id = item.string("id") ?: return@mapNotNull null,
                name = item.string("name") ?: "Android",
                pairedAt = item.long("created_at")?.let { Instant.ofEpochMilli(it).toString() }.orEmpty(),
                notificationEnabled = current?.deviceId == item.string("id") && settings.getBoolean("notifications", true),
                status = item.string("status") ?: "pending",
                encryptionPublicKey = item.string("encryption_public_key").orEmpty(),
            )
        }
    }

    private fun pollPendingApproval() {
        if (pendingApprovalJob?.isActive == true) return
        pendingApprovalJob = scope.launch {
            while (currentCoroutineContext().isActive) {
                var credentials = secure.load()?.takeIf { it.deviceStatus == "pending" } ?: return@launch
                runCatching {
                    if (credentials.accessExpiresAt < System.currentTimeMillis() + 30_000) credentials = refreshCredentials(credentials)
                    apiGet(credentials.endpoint, "/api/device/status", credentials.accessToken).requireObject("设备状态")
                }.onSuccess { result ->
                    val device = result.obj("device") ?: return@onSuccess
                    if (device.string("status") != "approved") return@onSuccess
                    val packageValue = device.string("keyPackage") ?: return@onSuccess
                    val secret = RelayCrypto.openAccountPackage(packageValue, credentials.deviceKeys())
                    val approved = credentials.copy(
                        deviceStatus = "approved",
                        accountSigningPrivateKey = secret.signingPrivateKey,
                        accountEncryptionPrivateKey = secret.encryptionPrivateKey,
                        contentKey = secret.contentKey,
                    )
                    secure.save(approved)
                    _device.value = deviceModel(approved)
                    _isPaired.value = true
                    _authStatus.value = "设备已批准"
                    BridgeSyncService.start(context)
                    reconnect()
                }.onFailure { error ->
                    if (isPendingSessionRejected(error)) {
                        secure.clear()
                        _device.value = deviceModel(null)
                        _isPaired.value = false
                        _authStatus.value = "待批准设备已失效，请重新登录"
                    } else {
                        _authStatus.value = "等待批准：${error.message}"
                    }
                }
                if (_isPaired.value) return@launch
                delay(5_000)
            }
        }
    }

    private suspend fun refreshCredentials(credentials: RelayCredentials): RelayCredentials {
        return refreshMutex.withLock {
            withContext(NonCancellable) {
                val current = secure.load()?.takeIf { it.approved && sameEndpoint(it.endpoint, credentials.endpoint) } ?: credentials
                if (current.accessExpiresAt >= System.currentTimeMillis() + 30_000) return@withContext current
                val result = apiPost(current.endpoint, "/api/auth/refresh", obj("refreshToken" to current.refreshToken)).requireObject("刷新登录")
                val updated = current.copy(
                    accessToken = result.string("accessToken") ?: error("刷新结果缺少 accessToken"),
                    refreshToken = result.string("refreshToken") ?: error("刷新结果缺少 refreshToken"),
                    accessExpiresAt = result.long("accessExpiresAt") ?: error("刷新结果缺少有效期"),
                    refreshExpiresAt = result.long("refreshExpiresAt") ?: current.refreshExpiresAt,
                )
                secure.save(updated)
                updated
            }
        }
    }

    private suspend fun registerPushIfReady() {
        val token = fcmToken ?: return
        if (rpc == null) return
        runCatching { outerCall("push/register", obj("installationId" to secure.installationId(), "fcmToken" to token)) }
    }

    private suspend fun outerCall(method: String, params: JsonObject = JsonObject(emptyMap())): JsonElement {
        val client = rpc ?: throw BridgeRpcException("Relay 尚未连接，正在自动恢复", CONNECTION_LOST_CODE)
        val ready = relayReady ?: throw BridgeRpcException("Relay 尚未连接，正在自动恢复", CONNECTION_LOST_CODE)
        ready.await()
        if (rpc !== client || relayReady !== ready) {
            throw BridgeRpcException("Relay 连接已切换，正在自动恢复", CONNECTION_LOST_CODE)
        }
        return client.call(method, params)
    }

    private suspend fun apiGet(endpoint: String, path: String, accessToken: String? = null) = apiRequest(endpoint, path, null, accessToken)
    private suspend fun apiPost(endpoint: String, path: String, body: JsonObject) = apiRequest(endpoint, path, body, null)

    private suspend fun apiRequest(endpoint: String, path: String, body: JsonObject?, accessToken: String?): JsonElement = withContext(Dispatchers.IO) {
        val base = endpoint.trimEnd('/')
        val builder = Request.Builder().url("$base$path")
        accessToken?.let { builder.header("Authorization", "Bearer $it") }
        if (body == null) builder.get() else builder.post(body.toString().toRequestBody("application/json".toMediaType()))
        http.newCall(builder.build()).execute().use { response ->
            val parsed = runCatching { json.parseToJsonElement(response.body?.string().orEmpty()) }.getOrElse { JsonObject(emptyMap()) }
            if (!response.isSuccessful) {
                val error = parsed.asObject()?.obj("error")
                throw BridgeRpcException(error?.string("message") ?: "Relay 请求失败 (${response.code})", error?.string("code"))
            }
            parsed
        }
    }

    private fun credentialsFromLogin(endpoint: String, username: String, keys: DeviceKeyMaterial, result: JsonObject, existing: RelayCredentials?): RelayCredentials {
        val account = result.obj("account") ?: error("登录结果缺少 account")
        val device = result.obj("device") ?: error("登录结果缺少 device")
        val tokens = result.obj("tokens") ?: error("登录结果缺少 tokens")
        val status = device.string("status") ?: "pending"
        val secret = device.string("keyPackage")?.let { RelayCrypto.openAccountPackage(it, keys) }
        return RelayCredentials(
            endpoint = endpoint.trimEnd('/'),
            accountId = account.string("id") ?: error("登录结果缺少 account.id"),
            username = username,
            deviceId = device.string("id") ?: error("登录结果缺少 device.id"),
            deviceName = device.string("name") ?: Build.MODEL,
            deviceStatus = status,
            accessToken = tokens.string("accessToken") ?: error("登录结果缺少 accessToken"),
            refreshToken = tokens.string("refreshToken") ?: error("登录结果缺少 refreshToken"),
            accessExpiresAt = tokens.long("accessExpiresAt") ?: 0,
            refreshExpiresAt = tokens.long("refreshExpiresAt") ?: 0,
            deviceSigningPublicKey = keys.signingPublicKey,
            deviceSigningPrivateKey = keys.signingPrivateKey,
            deviceEncryptionPublicKey = keys.encryptionPublicKey,
            deviceEncryptionPrivateKey = keys.encryptionPrivateKey,
            accountSigningPublicKey = account.string("signingPublicKey") ?: error("登录结果缺少账户签名公钥"),
            accountEncryptionPublicKey = account.string("encryptionPublicKey") ?: error("登录结果缺少账户加密公钥"),
            accountSigningPrivateKey = secret?.signingPrivateKey ?: existing?.accountSigningPrivateKey,
            accountEncryptionPrivateKey = secret?.encryptionPrivateKey ?: existing?.accountEncryptionPrivateKey,
            contentKey = secret?.contentKey ?: existing?.contentKey,
        )
    }

    private fun credentialsFromRegistration(endpoint: String, username: String, material: RegistrationMaterial, result: JsonObject): RelayCredentials {
        val account = result.obj("account") ?: error("注册结果缺少 account")
        val device = result.obj("device") ?: error("注册结果缺少 device")
        val tokens = result.obj("tokens") ?: error("注册结果缺少 tokens")
        return RelayCredentials(
            endpoint.trimEnd('/'), account.string("id")!!, username, device.string("id")!!, device.string("name") ?: Build.MODEL,
            "approved", tokens.string("accessToken")!!, tokens.string("refreshToken")!!, tokens.long("accessExpiresAt")!!,
            tokens.long("refreshExpiresAt")!!, material.device.signingPublicKey, material.device.signingPrivateKey,
            material.device.encryptionPublicKey, material.device.encryptionPrivateKey, material.accountSigningPublicKey,
            material.accountEncryptionPublicKey, material.accountSecret.signingPrivateKey, material.accountSecret.encryptionPrivateKey,
            material.accountSecret.contentKey,
        )
    }

    private fun updateHosts() {
        val endpoint = secure.load()?.endpoint.orEmpty()
        _hosts.value = hostInfos.values.sortedBy { it.name.lowercase() }.map { info ->
            Host(
                id = info.id,
                name = info.name,
                wssUrl = endpoint,
                connectionState = if (info.online) ConnectionState.Connected else ConnectionState.Disconnected,
                lastSeen = info.lastSeenAt?.let { DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochMilli(it)) }.orEmpty(),
                relayName = runCatching { URI(endpoint).host }.getOrNull().orEmpty(),
                signingPublicKey = info.signingPublicKey,
                encryptionPublicKey = info.encryptionPublicKey,
            )
        }
        if (_selectedHostId.value != null && _hosts.value.none { it.id == _selectedHostId.value }) _selectedHostId.value = null
        _host.value = selectedOrAggregateHost()
    }

    private fun updateVisibleState() {
        val selected = _selectedHostId.value
        _projects.value = selected?.let { projectsByHost[it] }.orEmpty()
        _models.value = selected?.let { modelsByHost[it] }.orEmpty()
        _projectsError.value = when {
            selected == null -> "请先选择一台电脑"
            hostInfos[selected]?.online != true -> "所选电脑当前离线"
            _projects.value.isEmpty() -> "Codex Desktop 中没有可用项目"
            else -> null
        }
        _host.value = selectedOrAggregateHost()
        updateVisibleThreads()
    }

    private fun updateVisibleThreads() {
        val selected = _selectedHostId.value
        _threads.value = (if (selected == null) threadLists.values.flatten() else threadLists[selected].orEmpty())
            .filterNot { it.archived }
            .sortedByDescending { it.updatedAtEpoch }
    }

    private fun selectedOrAggregateHost() = _selectedHostId.value?.let { selected -> _hosts.value.firstOrNull { it.id == selected } }
        ?: aggregateHost(if (rpc != null) "已连接" else "尚未连接")

    private fun aggregateHost(text: String = "尚未连接") = Host(
        id = "",
        name = "全部电脑",
        wssUrl = secure.load()?.endpoint.orEmpty(),
        connectionState = if (rpc != null) ConnectionState.Connected else ConnectionState.Disconnected,
        lastSeen = text,
        relayName = secure.load()?.endpoint?.let { runCatching { URI(it).host }.getOrNull() }.orEmpty(),
    )

    private fun markRelayConnecting() { _host.value = aggregateHost("正在连接 Relay").copy(connectionState = ConnectionState.Connecting) }
    private fun markRelayDisconnected(message: String = "连接暂时中断，正在自动重连") {
        hostInfos.replaceAll { _, value -> value.copy(online = false) }
        queueActiveThreadRefresh()
        updateHosts()
        _host.value = aggregateHost(message)
    }

    private fun queueActiveThreadRefresh() {
        val key = activeThreadKey ?: return
        pendingThreadRefreshes += key
        details[key]?.let { flow ->
            flow.value = flow.value.copy(
                loading = false,
                loadError = "连接暂时中断，正在自动恢复任务内容…",
            )
        }
    }

    private fun clearActionError(action: String) {
        if (_actionError.value?.startsWith("$action 失败：") == true) _actionError.value = null
    }

    private fun emptyDetail(ref: ThreadRef): ThreadDetail {
        val summary = threadLists[ref.hostId]?.firstOrNull { it.id == ref.threadId }
        val online = hostInfos[ref.hostId]?.online
        return ThreadDetail(
            id = ref.threadId,
            title = summary?.title ?: "加载中…",
            cwd = summary?.cwd.orEmpty(),
            status = summary?.status ?: ThreadStatus.Idle,
            items = emptyList(),
            activeTurnId = null,
            preview = summary?.lastMessage.orEmpty(),
            loading = online == true,
            loadError = if (online == false) "${hostInfos[ref.hostId]?.name ?: "目标电脑"}当前离线；恢复连接后会自动加载" else null,
        )
    }

    private fun deviceModel(credentials: RelayCredentials?) = Device(
        id = credentials?.deviceId.orEmpty(),
        name = credentials?.deviceName ?: Build.MODEL,
        pairedAt = "",
        notificationEnabled = settings.getBoolean("notifications", true),
        status = credentials?.deviceStatus ?: "signed_out",
        encryptionPublicKey = credentials?.deviceEncryptionPublicKey.orEmpty(),
    )

    private fun RelayCredentials.deviceKeys() = DeviceKeyMaterial(deviceSigningPublicKey, deviceSigningPrivateKey, deviceEncryptionPublicKey, deviceEncryptionPrivateKey)

    private fun websocketUrl(endpoint: String): String {
        val uri = URI(endpoint)
        val scheme = if (uri.scheme.equals("https", true)) "wss" else "ws"
        val path = uri.path.trimEnd('/') + "/ws/device"
        return URI(scheme, null, uri.host, uri.port, path, null, null).toString()
    }

    private fun validRelayUrl(value: String) = runCatching {
        val uri = URI(value)
        uri.scheme.equals("https", true) && !uri.host.isNullOrBlank() && uri.userInfo == null && uri.fragment == null
    }.getOrDefault(false)

    private fun sameEndpoint(left: String, right: String) = left.trimEnd('/').equals(right.trimEnd('/'), true)

    private fun parseInvite(value: String): Triple<String, String, String>? = runCatching {
        val uri = URI(value.trim())
        val pieces = uri.fragment?.split('.', limit = 2) ?: return null
        if (pieces.size != 2 || pieces.any { it.isBlank() }) return null
        Triple(pieces[0], pieces[1], URI(uri.scheme, null, uri.host, uri.port, "", null, null).toString().trimEnd('/'))
    }.getOrNull()

    private fun displayUserText(raw: String): String {
        if (!raw.contains("<codex_delegation>") || !raw.contains("<input>")) return raw
        return raw.substringAfter("<input>", "").substringBeforeLast("</input>", "").trim().ifBlank { raw }
    }

    private fun statusFromJson(key: String, status: JsonObject?, hasInProgressTurn: Boolean? = null) = when (status?.string("type")) {
        "active" -> if (ownedTurns.containsKey(key)) ThreadStatus.Active else if (hasInProgressTurn == true) ThreadStatus.ExternalBusy else ThreadStatus.Idle
        "systemError" -> ThreadStatus.NeedsAttention
        "idle" -> ThreadStatus.Idle
        else -> ThreadStatus.Completed
    }

    private fun modelFromJson(element: JsonElement): ModelOption? {
        val model = element.asObject() ?: return null
        val efforts = model.array("supportedReasoningEfforts").mapNotNull { it.asObject() }.map {
            val id = it.string("reasoningEffort").orEmpty()
            ReasoningOption(id, effortLabel(id), it.string("description").orEmpty())
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
        fun finish() { val current = file; val value = header; if (current != null && value != null) current.hunks += DiffHunk(value, lines); header = null; lines = mutableListOf() }
        text.lineSequence().forEach { line -> when {
            line.startsWith("diff --git ") -> { finish(); file = MutableFile(line.substringAfter(" b/")).also(files::add) }
            line.startsWith("new file mode") -> file?.status = DiffFileStatus.Added
            line.startsWith("deleted file mode") -> file?.status = DiffFileStatus.Deleted
            line.startsWith("rename to ") -> { file?.status = DiffFileStatus.Renamed; file?.path = line.removePrefix("rename to ") }
            line.startsWith("@@") -> { finish(); header = line }
            header != null && line.startsWith("+") && !line.startsWith("+++") -> lines += DiffLine(DiffLineKind.Add, line.drop(1))
            header != null && line.startsWith("-") && !line.startsWith("---") -> lines += DiffLine(DiffLineKind.Delete, line.drop(1))
            header != null -> lines += DiffLine(DiffLineKind.Context, line.removePrefix(" "))
        } }
        finish()
        return files.map { value -> val all = value.hunks.flatMap { it.lines }; DiffFile(value.path, value.status, all.count { it.kind == DiffLineKind.Add }, all.count { it.kind == DiffLineKind.Delete }, value.hunks, truncated) }
    }

    private fun formatTime(epoch: Long?) = epoch?.let { DateTimeFormatter.ofPattern("MM-dd HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochSecond(it)) }.orEmpty()
    private fun effortLabel(value: String) = when (value) { "none" -> "无"; "minimal" -> "极低"; "low" -> "低"; "medium" -> "中"; "high" -> "高"; "xhigh" -> "极高"; "max" -> "最大"; "ultra" -> "超高"; else -> value }
    private fun actionError(action: String, error: Throwable) = "$action 失败：${error.message ?: "未知错误"}"

    private fun envelopeFromJson(value: JsonObject) = json.decodeFromString<RelayEnvelope>(value.toString())
    private fun obj(vararg values: Pair<String, Any?>) = buildJsonObject { values.forEach { (key, value) -> when (value) { null -> put(key, JsonNull); is String -> put(key, value); is Number -> put(key, JsonPrimitive(value)); is Boolean -> put(key, value); is JsonElement -> put(key, value) } } }
}

private fun JsonElement.asObject() = this as? JsonObject
private fun JsonElement.requireObject(context: String) = this as? JsonObject ?: throw BridgeRpcException("$context 返回格式不兼容")
private fun JsonObject.string(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull
private fun JsonObject.long(key: String) = (this[key] as? JsonPrimitive)?.longOrNull
private fun JsonObject.boolean(key: String) = (this[key] as? JsonPrimitive)?.contentOrNull?.toBooleanStrictOrNull()
private fun JsonObject.obj(key: String) = this[key] as? JsonObject
private fun JsonObject.array(key: String) = this[key] as? JsonArray ?: JsonArray(emptyList())
private fun JsonObject.commandText(): String? = when (val command = this["command"]) {
    is JsonPrimitive -> command.contentOrNull
    is JsonArray -> command.mapNotNull { (it as? JsonPrimitive)?.contentOrNull ?: (it as? JsonObject)?.string("text") }.joinToString(" ").ifBlank { null }
    is JsonObject -> command.string("text") ?: command.string("command")
    else -> null
}
