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
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LinearProgressIndicator
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.data.model.ThreadStatus
import com.agentpocket.app.data.model.ThreadRef
import com.agentpocket.app.data.model.TimelineItem
import com.agentpocket.app.ui.components.AgentBadge
import com.agentpocket.app.ui.components.AgentRegistry
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
    val attachmentsSupported = repo.hostSupports("attachments-v1", threadHostId)
    val planSupported = repo.hostSupports("plan-v1", threadHostId)
    val goalSupported = repo.hostSupports("goal-v1", threadHostId)
    val refreshing = threadId in refreshingThreads
    var goalDialogOpen by remember { mutableStateOf(false) }
    var goalCurrent by remember { mutableStateOf<String?>(null) }
    var goalDraft by remember { mutableStateOf("") }
    var goalLoading by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    var initialScrollDone by rememberSaveable(threadId) { mutableStateOf(false) }
    var followTail by rememberSaveable(threadId) { mutableStateOf(true) }
    var forceScrollRequest by rememberSaveable(threadId) { mutableStateOf(0) }
    val desktopOwned = detail.status == ThreadStatus.DesktopOwned
    val readOnly = detail.status == ThreadStatus.ExternalBusy
    val running = detail.activeTurnId != null
    val tailVersion = when (val tail = detail.items.lastOrNull()) {
        is TimelineItem.Message -> "${tail.id}:${tail.text.length}:${tail.status}"
        is TimelineItem.Command -> "${tail.id}:${tail.output.length}:${tail.status}"
        is TimelineItem.Plan -> "${tail.id}:${tail.steps.hashCode()}:${tail.status}"
        is TimelineItem.Question -> "${tail.id}:${tail.selectedOption}"
        is TimelineItem.Approval -> "${tail.id}:${tail.decision}"
        null -> ""
    }

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
    LaunchedEffect(threadId, desktopOwned) {
        if (!desktopOwned) repo.threadGoal(threadId) { goalCurrent = it }
    }
    DisposableEffect(threadId) {
        repo.setActiveThread(threadId)
        onDispose { repo.setActiveThread(null) }
    }
    LaunchedEffect(listState) {
        snapshotFlow {
            val layout = listState.layoutInfo
            val lastVisible = layout.visibleItemsInfo.lastOrNull()?.index ?: -1
            listState.isScrollInProgress to (
                layout.totalItemsCount == 0 || lastVisible >= layout.totalItemsCount - 2
            )
        }.distinctUntilChanged().collect { (scrolling, nearBottom) ->
            if (scrolling) followTail = nearBottom
        }
    }
    LaunchedEffect(threadId, detail.items.size, tailVersion, forceScrollRequest) {
        if (detail.items.isEmpty()) return@LaunchedEffect
        if (!initialScrollDone || followTail) {
            // The extra anchor is after the final timeline card, so this lands at
            // the actual bottom even when the last message is taller than a screen.
            listState.scrollToItem(detail.items.size)
            initialScrollDone = true
        }
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        Column {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                AgentBadge(AgentRegistry.codex)
                                Spacer(Modifier.width(6.dp))
                                Text(
                                    detail.title,
                                    style = MaterialTheme.typography.titleSmall,
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    modifier = Modifier.weight(1f, fill = false),
                                )
                                Spacer(Modifier.width(8.dp))
                                ThreadStatusChip(detail.status)
                            }
                            Text(
                                detail.cwd,
                                style = MaterialTheme.typography.labelSmall,
                                fontFamily = FontFamily.Monospace,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                        }
                    },
                    actions = {
                        if (!desktopOwned && goalSupported) {
                            IconButton(onClick = { openGoalDialog() }) {
                                Icon(Icons.Filled.Flag, contentDescription = "任务目标")
                            }
                        }
                        IconButton(onClick = { repo.refreshThread(threadId) }, enabled = !refreshing) {
                            Icon(Icons.Filled.Refresh, contentDescription = "重新同步会话")
                        }
                        IconButton(onClick = { onOpenDiff(threadId) }) {
                            Icon(Icons.Filled.Difference, contentDescription = "查看变更")
                        }
                    },
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
                if (refreshing) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        },
        bottomBar = {
            Composer(
                running = running,
                desktopOwned = desktopOwned,
                readOnly = readOnly,
                attachmentsSupported = attachmentsSupported,
                planSupported = planSupported,
                errorMessage = actionError,
                onSend = { text, planMode, images, files ->
                    followTail = true
                    repo.sendSteer(threadId, text, planMode, images, files)
                    forceScrollRequest += 1
                },
                onInterrupt = { repo.interruptTurn(threadId) },
            )
        },
        floatingActionButton = {
            if (detail.items.isNotEmpty() && listState.canScrollForward) {
                SmallFloatingActionButton(
                    onClick = {
                        followTail = true
                        coroutineScope.launch { listState.animateScrollToItem(detail.items.size) }
                    },
                ) {
                    Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "回到最新消息")
                }
            }
        },
    ) { padding ->
        // keyed LazyColumn：后续接入 50 ms delta 合并时只需替换列表项，无需改动渲染层。
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
            state = listState,
        ) {
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
                key = { index, item ->
                    // Desktop history occasionally contains missing or reused IDs.
                    // Include the position and type so Compose never receives a
                    // duplicate key and aborts the whole Activity.
                    "$index:${item::class.simpleName}:${item.id}"
                },
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
                    actionsEnabled = !desktopOwned && !readOnly,
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
    Surface(tonalElevation = 3.dp) {
        Column(Modifier.imePadding()) {
            if (desktopOwned) {
                Text(
                    "该任务由 Codex Desktop 持有。你可以从手机追加文字、图片和文件；中断、审批和问题回答仍需在电脑端处理。",
                    style = MaterialTheme.typography.labelSmall,
                    color = StatusColors.external,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                )
            } else if (readOnly) {
                Text(
                    "该任务被外部进程占用，移动端仅可查看，无法发送或强制接管。",
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
                        label = { Text("Execute · 执行") },
                    )
                    FilterChip(
                        selected = planMode,
                        onClick = { planMode = true },
                        label = { Text("Plan · 先规划") },
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
                    enabled = !readOnly,
                    placeholder = {
                        Text(
                            if (desktopOwned) "通过 Desktop 追加指令…" else if (running) "追加指令以调整当前任务…" else "继续对话…",
                            style = MaterialTheme.typography.bodySmall,
                        )
                    },
                    shape = RoundedCornerShape(20.dp),
                    colors = OutlinedTextFieldDefaults.colors(),
                    maxLines = 4,
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.width(8.dp))
                if (running && !desktopOwned && !readOnly) {
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
                    enabled = !readOnly && (text.isNotBlank() || imageAttachments.isNotEmpty() || fileAttachments.isNotEmpty()),
                ) {
                    Icon(Icons.AutoMirrored.Filled.Send, contentDescription = "发送")
                }
            }
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF0B0E13)
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
