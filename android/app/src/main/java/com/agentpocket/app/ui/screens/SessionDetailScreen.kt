package com.agentpocket.app.ui.screens

import android.net.Uri
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.AddPhotoAlternate
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Difference
import androidx.compose.material.icons.filled.Flag
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.snapshotFlow
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.nestedscroll.NestedScrollConnection
import androidx.compose.ui.input.nestedscroll.NestedScrollSource
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.data.model.ThreadStatus
import com.agentpocket.app.data.model.ThreadRef
import com.agentpocket.app.data.model.TimelineItem
import com.agentpocket.app.ui.components.PendingAttachmentStrip
import com.agentpocket.app.ui.components.PendingFileList
import com.agentpocket.app.ui.components.ThreadStatusChip
import com.agentpocket.app.ui.components.TimelineItemContent
import com.agentpocket.app.ui.components.rememberFilePicker
import com.agentpocket.app.ui.components.rememberImagePicker
import com.agentpocket.app.ui.theme.AgentPocketTheme
import com.agentpocket.app.ui.theme.StatusColors
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch

private data class HistoryScrollAnchor(val key: Any, val offset: Int, val firstItemId: String?)

/**
 * 会话详情：流式消息、计划、命令/测试卡、提问卡、审批卡（允许一次/拒绝/取消）、
 * 底部 composer（运行中发送即 steer）、中断按钮。
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionDetailScreen(
    repo: PocketRepository,
    threadId: String,
    onBack: () -> Unit,
    onOpenDiff: (String) -> Unit,
) {
    val detailState = remember(repo, threadId) { repo.threadDetail(threadId) }
    val detail by detailState.collectAsState()
    val actionError by repo.actionError.collectAsState()
    val refreshingThreads by repo.refreshingThreads.collectAsState()
    val threadHostId = remember(threadId) { runCatching { ThreadRef.parse(threadId).hostId }.getOrNull() }
    val attachmentsSupported = detail.execution.attachments && repo.hostSupports("attachments-v1", threadHostId)
    val planSupported = repo.hostSupports("plan-v1", threadHostId)
    val goalSupported = repo.hostSupports("goal-v1", threadHostId)
    val handoffSupported = repo.hostSupports("handoff-v1", threadHostId)
    val refreshing = threadId in refreshingThreads
    var goalDialogOpen by remember { mutableStateOf(false) }
    var goalCurrent by remember { mutableStateOf<String?>(null) }
    var goalDraft by remember { mutableStateOf("") }
    var goalLoading by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var handoffDialogOpen by remember { mutableStateOf(false) }
    var handingOff by remember(threadId) { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var followTail by rememberSaveable(threadId) { mutableStateOf(true) }
    var historyAnchor by remember(threadId) { mutableStateOf<HistoryScrollAnchor?>(null) }
    val tailScrollConnection = remember(threadId) {
        object : NestedScrollConnection {
            override fun onPreScroll(available: Offset, source: NestedScrollSource): Offset {
                if (source == NestedScrollSource.UserInput && available.y != 0f) {
                    historyAnchor = null
                    if (available.y > 0) followTail = false
                }
                return Offset.Zero
            }
        }
    }
    val endIndex = detail.items.size + (if (detail.hasEarlierMessages) 1 else 0) +
        (if (detail.items.isNotEmpty() && detail.loadError != null) 1 else 0)
    val execution = detail.execution
    val desktopOwned = execution.backend == "desktop" || detail.status == ThreadStatus.DesktopOwned
    val readOnly = !execution.send || detail.status == ThreadStatus.ExternalBusy
    val running = detail.activeTurnId != null

    fun openGoalDialog() {
        goalDialogOpen = true
        goalLoading = true
        repo.threadGoal(threadId) {
            goalCurrent = it
            goalDraft = it.orEmpty()
            goalLoading = false
        }
    }

    LaunchedEffect(threadId) { repo.clearActionError() }
    LaunchedEffect(threadId, execution.goal, goalSupported, detail.loading) {
        if (execution.goal && goalSupported && !detail.loading && detail.loadError == null) repo.threadGoal(threadId) { goalCurrent = it }
    }
    DisposableEffect(threadId) {
        repo.setActiveThread(threadId)
        onDispose { repo.setActiveThread(null) }
    }
    LaunchedEffect(listState) {
        snapshotFlow { listState.canScrollForward }.distinctUntilChanged().collect { canScrollForward ->
            if (!canScrollForward) followTail = true
        }
    }
    LaunchedEffect(threadId, detail.loadingEarlier, detail.items.firstOrNull()?.id) {
        if (detail.loadingEarlier) return@LaunchedEffect
        val anchor = historyAnchor ?: return@LaunchedEffect
        historyAnchor = null
        if (anchor.firstItemId == detail.items.firstOrNull()?.id) return@LaunchedEffect
        val index = detail.items.indexOfFirst { "${it::class.simpleName}:${it.id}" == anchor.key }
        if (index >= 0 && !followTail) {
            withFrameNanos { }
            if (!listState.isScrollInProgress) {
                val headers = (if (detail.hasEarlierMessages) 1 else 0) + (if (detail.loadError != null) 1 else 0)
                listState.scrollToItem(index + headers, -anchor.offset)
            }
        }
    }
    LaunchedEffect(threadId, followTail, detail.items.isNotEmpty()) {
        if (!followTail || detail.items.isEmpty()) return@LaunchedEffect
        // Markdown and expandable cards can grow after their text was delivered.
        // Follow measured layout, so asynchronous rendering and keyboard insets
        // keep the last card visible too. An upward gesture cancels this collector.
        snapshotFlow {
            val layout = listState.layoutInfo
            val last = layout.visibleItemsInfo.lastOrNull()
            listOf(
                layout.totalItemsCount, layout.viewportEndOffset,
                last?.index, last?.offset, last?.size,
                listState.canScrollForward, listState.isScrollInProgress,
            )
        }.collect {
            if (followTail && listState.canScrollForward && !listState.isScrollInProgress) {
                withFrameNanos { }
                if (followTail && !listState.isScrollInProgress) {
                    listState.scrollToItem((listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0))
                }
            }
        }
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Text(
                                    detail.title,
                                    style = MaterialTheme.typography.titleSmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                            }
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                if (execution.backend == "grok" && execution.owner == "external") {
                                    Text("电脑会话 · 仅查看", style = MaterialTheme.typography.labelSmall, color = StatusColors.external)
                                } else ThreadStatusChip(detail.status)
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    detail.cwd.trimEnd('/', '\\').substringAfterLast('/').substringAfterLast('\\'),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                )
                            }
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                        }
                    },
                    actions = {
                        IconButton(onClick = { repo.refreshThread(threadId) }, enabled = !refreshing) {
                            if (refreshing || handingOff) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
                            else Icon(Icons.Filled.Refresh, contentDescription = "刷新会话")
                        }
                        Box {
                            IconButton(onClick = { menuOpen = true }) {
                                Icon(Icons.Filled.MoreVert, contentDescription = "任务操作")
                            }
                            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                if (execution.handoff && !desktopOwned && handoffSupported) DropdownMenuItem(
                                    text = { Text(if (handingOff) "正在交接…" else "在电脑继续") },
                                    leadingIcon = { Icon(Icons.Filled.DesktopWindows, contentDescription = null) },
                                    enabled = !running && !detail.loading && !handingOff,
                                    onClick = { menuOpen = false; handoffDialogOpen = true },
                                )
                                if (execution.goal && !desktopOwned && goalSupported) DropdownMenuItem(
                                    text = { Text("任务目标") },
                                    leadingIcon = { Icon(Icons.Filled.Flag, contentDescription = null) },
                                    onClick = { menuOpen = false; openGoalDialog() },
                                )
                                DropdownMenuItem(
                                    text = { Text("查看变更") },
                                    leadingIcon = { Icon(Icons.Filled.Difference, contentDescription = null) },
                                    onClick = { menuOpen = false; onOpenDiff(threadId) },
                                )
                            }
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.background),
                )
                goalCurrent?.takeIf { it.isNotBlank() }?.let { goal ->
                    Surface(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp),
                        shape = RoundedCornerShape(8.dp),
                        color = MaterialTheme.colorScheme.tertiary.copy(alpha = 0.10f),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 10.dp, vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Icon(Icons.Filled.Flag, contentDescription = null, tint = MaterialTheme.colorScheme.tertiary)
                            Spacer(Modifier.width(6.dp))
                            Text(
                                "目标 · $goal",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.tertiary,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    }
                }
            }
        },
        bottomBar = {
            key(threadId) {
            Composer(
                running = running,
                desktopOwned = desktopOwned,
                readOnly = readOnly,
                readOnlyReason = execution.readOnlyReason,
                statusMessage = execution.statusMessage,
                busy = handingOff,
                canSteer = execution.steer,
                canInterrupt = execution.interrupt,
                attachmentsSupported = attachmentsSupported,
                planSupported = planSupported && execution.plan,
                errorMessage = actionError,
                onSend = { text, planMode, images, files ->
                    followTail = true
                    repo.sendSteer(threadId, text, planMode, images, files)
                },
                onInterrupt = { repo.interruptTurn(threadId) },
            )
            }
        },
        floatingActionButton = {
            if (detail.items.isNotEmpty() && listState.canScrollForward) {
                SmallFloatingActionButton(
                    onClick = {
                        followTail = true
                        coroutineScope.launch { listState.animateScrollToItem(endIndex) }
                    },
                ) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "回到最新消息")
                }
            }
        },
    ) { padding ->
        // Stable keys preserve the reading position across refreshes and older pages.
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .nestedScroll(tailScrollConnection)
                .padding(padding),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            state = listState,
        ) {
            if (detail.hasEarlierMessages) {
                item(key = "__agent_pocket_earlier__", contentType = "history") {
                    Box(Modifier.fillMaxWidth(), contentAlignment = Alignment.Center) {
                        TextButton(
                            onClick = {
                                followTail = false
                                // The history button may disappear on the final page.
                                // Anchor a message, rather than that temporary header.
                                historyAnchor = listState.layoutInfo.visibleItemsInfo
                                    .firstOrNull { !it.key.toString().startsWith("__agent_pocket_") }
                                    ?.let { HistoryScrollAnchor(it.key, it.offset, detail.items.firstOrNull()?.id) }
                                repo.loadEarlierMessages(threadId)
                            },
                            enabled = !refreshing && !detail.loadingEarlier,
                        ) { Text(if (detail.loadingEarlier) "正在加载…" else "加载更早的消息") }
                    }
                }
            }
            if (detail.items.isNotEmpty() && detail.loadError != null) {
                item(key = "__agent_pocket_load_error__", contentType = "notice") {
                    Text(detail.loadError!!, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.error)
                }
            }
            if (detail.items.isEmpty()) {
                item(key = "__agent_pocket_thread_empty__", contentType = "empty") {
                    Surface(
                        modifier = Modifier.fillMaxWidth(),
                        shape = RoundedCornerShape(12.dp),
                        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
                    ) {
                        Column(Modifier.padding(16.dp)) {
                            Text(
                                if (detail.loading || refreshing) "正在读取任务内容…" else "暂时没有可显示的任务内容",
                                style = MaterialTheme.typography.titleSmall,
                            )
                            detail.preview.takeIf { it.isNotBlank() }?.let { preview ->
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    preview,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            detail.loadError?.let { error ->
                                Spacer(Modifier.height(8.dp))
                                Text(
                                    error,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error,
                                )
                            }
                            if (!detail.loading && !refreshing) {
                                TextButton(onClick = { repo.refreshThread(threadId) }) {
                                    Text("重新加载")
                                }
                            }
                        }
                    }
                }
            }
            itemsIndexed(
                detail.items,
                // Repository merges de-duplicate IDs. Position-free keys keep the
                // visible message and expanded cards anchored when history is prepended.
                key = { _, item -> "${item::class.simpleName}:${item.id}" },
                contentType = { _, item ->
                    when (item) {
                        is TimelineItem.Message -> "message"
                        is TimelineItem.Plan -> "plan"
                        is TimelineItem.Command -> "command"
                        is TimelineItem.Question -> "question"
                        is TimelineItem.Approval -> "approval"
                    }
                },
            ) { _, item ->
                TimelineItemContent(
                    item = item,
                    actionsEnabled = !handingOff && when (item) {
                        is TimelineItem.Question -> execution.question
                        is TimelineItem.Approval -> execution.approval
                        else -> true
                    },
                    onAnswerQuestion = { requestId, questionId, option ->
                        repo.answerQuestion(threadId, requestId, questionId, option)
                    },
                    onResolveApproval = { requestId, decision ->
                        repo.resolveApproval(threadId, requestId, decision)
                    },
                )
            }
            item(key = "__agent_pocket_thread_end_anchor__", contentType = "anchor") {
                Spacer(Modifier.height(1.dp))
            }
        }
    }

    if (handoffDialogOpen) {
        AlertDialog(
            onDismissRequest = { handoffDialogOpen = false },
            title = { Text("在电脑继续") },
            text = { Text("释放当前任务后，可以在 Codex Desktop 打开同一个任务。手机仍可追加消息；中断、审批和问题回答转到电脑处理。") },
            confirmButton = {
                TextButton(onClick = {
                    handoffDialogOpen = false
                    handingOff = true
                    repo.handoffThread(threadId) { handingOff = false }
                }) { Text("交接任务") }
            },
            dismissButton = { TextButton(onClick = { handoffDialogOpen = false }) { Text("取消") } },
        )
    }

    if (goalDialogOpen) {
        AlertDialog(
            onDismissRequest = { goalDialogOpen = false },
            title = { Text("任务目标") },
            text = {
                Column {
                    Text(
                        when {
                            goalLoading -> "正在读取…"
                            goalCurrent == null -> "尚未设置目标。目标会持久保存在该任务上，Codex 会围绕它持续推进。"
                            else -> "当前目标（修改后保存即替换）："
                        },
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = goalDraft,
                        onValueChange = { goalDraft = it },
                        placeholder = { Text("例如：把 p95 延迟降到 120ms 以下", style = MaterialTheme.typography.bodySmall) },
                        maxLines = 4,
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        repo.setThreadGoal(threadId, goalDraft.trim()) { goalCurrent = it }
                        goalDialogOpen = false
                    },
                    enabled = goalDraft.isNotBlank() && !goalLoading,
                ) { Text("保存") }
            },
            dismissButton = {
                Row {
                    if (goalCurrent != null) {
                        TextButton(onClick = {
                            repo.clearThreadGoal(threadId) { goalCurrent = it }
                            goalDialogOpen = false
                        }) { Text("清除") }
                    }
                    TextButton(onClick = { goalDialogOpen = false }) { Text("关闭") }
                }
            },
        )
    }
}

@Composable
private fun Composer(
    running: Boolean,
    desktopOwned: Boolean,
    readOnly: Boolean,
    readOnlyReason: String?,
    statusMessage: String?,
    busy: Boolean,
    canSteer: Boolean,
    canInterrupt: Boolean,
    attachmentsSupported: Boolean,
    planSupported: Boolean,
    errorMessage: String?,
    onSend: (String, Boolean, List<Uri>, List<Uri>) -> Unit,
    onInterrupt: () -> Unit,
) {
    var text by rememberSaveable { mutableStateOf("") }
    var planMode by rememberSaveable { mutableStateOf(false) }
    var attachmentMenuOpen by remember { mutableStateOf(false) }
    var imageAttachments by rememberSaveable { mutableStateOf(listOf<Uri>()) }
    var fileAttachments by rememberSaveable { mutableStateOf(listOf<Uri>()) }
    val pickImages = rememberImagePicker { picked ->
        imageAttachments = (imageAttachments + picked).distinct().take((3 - fileAttachments.size).coerceAtLeast(0))
    }
    val pickFiles = rememberFilePicker { picked ->
        fileAttachments = (fileAttachments + picked).distinct().take((3 - imageAttachments.size).coerceAtLeast(0))
    }
    Surface(color = MaterialTheme.colorScheme.surface) {
        Column(Modifier.imePadding().navigationBarsPadding()) {
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
            if (busy) Text("正在交接任务…", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.labelSmall)
            if (running && !canSteer) Text(statusMessage ?: "Grok 正在执行；完成或中断后可以继续发送。", modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp), style = MaterialTheme.typography.labelSmall)
            if (desktopOwned) {
                Text(
                    "由 Desktop 执行 · 可追加消息，审批与中断在电脑处理",
                    style = MaterialTheme.typography.labelSmall,
                    color = StatusColors.external,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            } else if (readOnly) {
                Text(
                    readOnlyReason ?: "当前执行连接暂不可写；可继续查看任务，恢复后再发送。",
                    style = MaterialTheme.typography.labelSmall,
                    color = StatusColors.external,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            }
            if (!errorMessage.isNullOrBlank()) {
                Text(
                    errorMessage,
                    style = MaterialTheme.typography.labelSmall,
                    color = StatusColors.error,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                )
            }
            if (!running && !desktopOwned && !readOnly && planSupported) {
                Row(
                    modifier = Modifier.padding(start = 16.dp, top = 8.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    FilterChip(
                        selected = !planMode,
                        onClick = { planMode = false },
                        label = { Text("执行") },
                    )
                    FilterChip(
                        selected = planMode,
                        onClick = { planMode = true },
                        label = { Text("先规划") },
                    )
                }
            }
            if (!readOnly && attachmentsSupported) {
                PendingAttachmentStrip(
                    uris = imageAttachments,
                    onRemove = { imageAttachments = imageAttachments - it },
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
                PendingFileList(
                    uris = fileAttachments,
                    onRemove = { fileAttachments = fileAttachments - it },
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                )
            }
            Row(
                modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
                verticalAlignment = Alignment.Bottom,
            ) {
                if (!readOnly && attachmentsSupported) {
                    Box {
                        IconButton(
                            onClick = { attachmentMenuOpen = true },
                            colors = IconButtonDefaults.iconButtonColors(
                                containerColor = MaterialTheme.colorScheme.primary.copy(alpha = 0.12f),
                                contentColor = MaterialTheme.colorScheme.primary,
                            ),
                        ) {
                            Icon(Icons.Filled.Add, contentDescription = "添加附件", modifier = Modifier.size(24.dp))
                        }
                        DropdownMenu(
                            expanded = attachmentMenuOpen,
                            onDismissRequest = { attachmentMenuOpen = false },
                        ) {
                            DropdownMenuItem(
                                text = { Text("添加图片") },
                                leadingIcon = { Icon(Icons.Filled.AddPhotoAlternate, contentDescription = null) },
                                onClick = {
                                    attachmentMenuOpen = false
                                    pickImages()
                                },
                            )
                            DropdownMenuItem(
                                text = { Text("添加文件") },
                                leadingIcon = { Icon(Icons.Filled.AttachFile, contentDescription = null) },
                                onClick = {
                                    attachmentMenuOpen = false
                                    pickFiles()
                                },
                            )
                        }
                    }
                    Spacer(Modifier.width(4.dp))
                }
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    enabled = !readOnly && !busy,
                    placeholder = {
                        Text(
                            if (running && !canSteer) "先写下下一条消息…" else if (running) "补充想法，调整当前任务…" else "继续对话…",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    },
                    shape = RoundedCornerShape(20.dp),
                    colors = OutlinedTextFieldDefaults.colors(),
                    maxLines = 4,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                if (running && canInterrupt && !busy) {
                    FilledIconButton(
                        onClick = onInterrupt,
                        colors = IconButtonDefaults.filledIconButtonColors(
                            containerColor = StatusColors.error,
                            contentColor = MaterialTheme.colorScheme.onError,
                        ),
                    ) {
                        Icon(Icons.Filled.Stop, contentDescription = "中断")
                    }
                    Spacer(Modifier.width(6.dp))
                }
                FilledIconButton(
                    onClick = {
                        if (text.isNotBlank() || imageAttachments.isNotEmpty() || fileAttachments.isNotEmpty()) {
                            onSend(text.trim(), planMode, imageAttachments, fileAttachments)
                            text = ""
                            planMode = false
                            imageAttachments = emptyList()
                            fileAttachments = emptyList()
                        }
                    },
                    enabled = !readOnly && !busy && (!running || canSteer) && (text.isNotBlank() || imageAttachments.isNotEmpty() || fileAttachments.isNotEmpty()),
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "发送")
                }
            }
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFFFAF8F3)
@Composable
private fun SessionDetailScreenPreview() {
    AgentPocketTheme {
        SessionDetailScreen(
            repo = MockPocketRepository,
            threadId = "t-payment-tests",
            onBack = {},
            onOpenDiff = {},
        )
    }
}
