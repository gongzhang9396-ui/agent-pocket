package com.agentpocket.app.ui.screens

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.data.ThreadSection
import com.agentpocket.app.data.model.ConnectionState
import com.agentpocket.app.data.model.ThreadRef
import com.agentpocket.app.data.model.ThreadStatus
import com.agentpocket.app.data.model.ThreadSummary
import com.agentpocket.app.data.threadSections
import com.agentpocket.app.ui.components.AgentBadge
import com.agentpocket.app.ui.components.AgentRegistry
import com.agentpocket.app.ui.components.ConnectionPill
import com.agentpocket.app.ui.components.HostRuntimeCard
import com.agentpocket.app.ui.components.ThreadStatusChip
import com.agentpocket.app.ui.theme.AgentPocketTheme
import com.agentpocket.app.ui.theme.StatusColors

/** 按 Agent 查看各电脑上的项目与对话。Agent 选择由导航层保留。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    repo: PocketRepository,
    selectedAgentId: String?,
    onSelectAgent: (String?) -> Unit,
    onOpenThread: (String) -> Unit,
    onNewTask: (String) -> Unit,
    onOpenSettings: () -> Unit,
) {
    val host by repo.host.collectAsState()
    val hosts by repo.hosts.collectAsState()
    val hostRuntimes by repo.hostRuntimes.collectAsState()
    val selectedHostId by repo.selectedHostId.collectAsState()
    val threads by repo.threads.collectAsState()
    val projects by repo.projects.collectAsState()
    val agents by repo.agents.collectAsState()
    val syncing by repo.syncing.collectAsState()
    val syncStatus by repo.syncStatus.collectAsState()
    val filteredThreads = remember(threads, selectedAgentId) {
        threads.filter { selectedAgentId == null || AgentRegistry.forBackend(it.execution.backend).kind.id == selectedAgentId }
    }
    val selectedAgent = AgentRegistry.all.firstOrNull { it.kind.id == selectedAgentId }
    val sections = remember(filteredThreads, selectedHostId, projects) {
        threadSections(filteredThreads, showHost = selectedHostId == null, projects = projects)
    }
    var collapsedSections by rememberSaveable { mutableStateOf(arrayListOf<String>()) }
    val listState = rememberLazyListState()
    LaunchedEffect(selectedAgentId) { listState.scrollToItem(0) }
    val runningCount = filteredThreads.count { it.status == ThreadStatus.Active }
    val attentionCount = filteredThreads.count { it.status == ThreadStatus.NeedsAttention }
    val unreadCount = filteredThreads.sumOf { it.unreadCount }
    val selectedHost = hosts.firstOrNull { it.id == selectedHostId }

    LaunchedEffect(selectedHostId, selectedHost?.connectionState, selectedAgentId) {
        if (selectedAgentId != "grok" && selectedHost?.connectionState == ConnectionState.Connected) repo.refreshHostRuntime(selectedHost.id)
    }

    Scaffold(
        topBar = {
            Column {
                TopAppBar(
                    title = {
                        Column {
                            Text("Agent Pocket", style = MaterialTheme.typography.titleMedium)
                            ConnectionPill(state = host.connectionState, relayName = host.relayName)
                        }
                    },
                    actions = {
                        if (syncing) {
                            // 刷新中的小反馈：不占布局、不推挤列表。
                            CircularProgressIndicator(
                                modifier = Modifier
                                    .padding(horizontal = 14.dp)
                                    .size(20.dp),
                                strokeWidth = 2.dp,
                            )
                        } else {
                            IconButton(onClick = { repo.refreshAll() }) {
                                Icon(Icons.Filled.Refresh, contentDescription = "刷新")
                            }
                        }
                        IconButton(onClick = onOpenSettings) {
                            Icon(Icons.Filled.Settings, contentDescription = "设置")
                        }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(
                        containerColor = MaterialTheme.colorScheme.background,
                    ),
                )
                AgentFilters(
                    selectedAgentId = selectedAgentId,
                    threads = threads,
                    onSelect = onSelectAgent,
                )
            }
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = { onNewTask(selectedAgentId ?: "codex") },
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text(selectedAgent?.let { "新建 ${it.displayName} 任务" } ?: "新建任务") },
            )
        },
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            PullToRefreshBox(
                isRefreshing = syncing,
                onRefresh = { repo.refreshAll() },
                modifier = Modifier
                    .fillMaxSize(),
            ) {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 8.dp,
                        bottom = 96.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    selectedHost?.takeIf { selectedAgentId != "grok" }?.let { item ->
                        item(key = "runtime:${item.id}", contentType = "dashboard") {
                            HostRuntimeCard(
                                hostName = item.name,
                                hostOnline = item.connectionState == ConnectionState.Connected,
                                runtime = hostRuntimes[item.id],
                                onRefresh = { repo.refreshHostRuntime(item.id) },
                                onLaunch = { repo.launchDesktop(item.id) },
                            )
                        }
                    }
                    if (selectedAgentId == "grok") {
                        item(key = "grok-summary", contentType = "dashboard") {
                            Column(Modifier.padding(vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                                Text("Grok 项目与对话", style = MaterialTheme.typography.titleMedium)
                                val availability = agents.firstOrNull { it.id == "grok" }
                                Text(
                                    when {
                                        selectedHost == null -> "按项目查看电脑与手机的 Grok 对话。"
                                        selectedHost.connectionState != ConnectionState.Connected -> "电脑离线，连接恢复后可继续对话。"
                                        availability?.error != null -> availability.error
                                        availability?.available == true -> "电脑与手机共用 Grok 会话，打开后即可继续聊。"
                                        else -> "暂未获取 Grok 状态，可刷新检查电脑上的安装和登录。"
                                    },
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    if (filteredThreads.isNotEmpty()) {
                        item(key = "stats", contentType = "dashboard") {
                            StatsRow(runningCount, attentionCount, unreadCount)
                        }
                    }
                    item(key = "host-filter", contentType = "filter") {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            FilterChip(
                                selected = selectedHostId == null,
                                onClick = { repo.selectHost(null) },
                                label = { Text("全部电脑") },
                            )
                            hosts.forEach { item ->
                                FilterChip(
                                    selected = selectedHostId == item.id,
                                    onClick = { repo.selectHost(item.id) },
                                    label = {
                                        Text(
                                            if (item.connectionState == ConnectionState.Connected) item.name else "${item.name} · 离线",
                                            maxLines = 1,
                                        )
                                    },
                                )
                            }
                        }
                    }
                    if (filteredThreads.isEmpty()) {
                        item(key = "empty", contentType = "empty") {
                            Column(Modifier.padding(vertical = 24.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                                Text(
                                    when {
                                        hosts.isEmpty() -> "还没有绑定 Windows 电脑"
                                        syncing -> "正在同步${selectedAgent?.displayName.orEmpty()}任务…"
                                        selectedAgent != null -> "还没有 ${selectedAgent.displayName} 对话"
                                        else -> "暂时没有可显示的任务"
                                    },
                                    style = MaterialTheme.typography.titleSmall,
                                )
                                if (hosts.isNotEmpty() && !syncing) Text(
                                    if (selectedAgentId == "grok") {
                                        "点击右下角新建任务，或刷新同步电脑会话。电脑会话的项目目录需要在 Host 允许访问的范围内。"
                                    } else {
                                        "点击右下角新建任务，或刷新获取电脑上的对话。"
                                    },
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    }
                    // 在当前 Agent 范围内按项目分组，最新活动优先。
                    sections.forEach { section ->
                        val collapseKey = "${selectedAgentId.orEmpty()}:${section.key}"
                        val collapsed = collapseKey in collapsedSections
                        item(key = "section:${section.key}", contentType = "section") {
                            ProjectHeader(
                                section = section,
                                collapsed = collapsed,
                                onToggle = {
                                    collapsedSections = ArrayList(collapsedSections).apply {
                                        if (!remove(collapseKey)) add(collapseKey)
                                    }
                                },
                            )
                        }
                        if (!collapsed) {
                            items(section.threads, key = { ThreadRef(it.hostId, it.id).encoded() }, contentType = { "thread" }) { thread ->
                                ThreadCard(
                                    thread = thread,
                                    showHost = false,
                                    onClick = { onOpenThread(ThreadRef(thread.hostId, thread.id).encoded()) },
                                )
                            }
                        }
                    }
                }
            }
            if (syncing && !syncStatus.isNullOrBlank()) {
                // 悬浮状态条：覆盖在列表上方，不造成布局位移。
                Surface(
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(top = 4.dp),
                    shape = RoundedCornerShape(50),
                    color = MaterialTheme.colorScheme.surface,
                    border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
                ) {
                    Text(
                        syncStatus!!,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 12.dp, vertical = 5.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun AgentFilters(selectedAgentId: String?, threads: List<ThreadSummary>, onSelect: (String?) -> Unit) {
    val options = listOf(null to "全部") + AgentRegistry.all.filter { it.available }.map { it.kind.id to it.displayName }
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        options.forEach { (id, label) ->
            val count = if (id == null) threads.size else threads.count { AgentRegistry.forBackend(it.execution.backend).kind.id == id }
            FilterChip(
                modifier = Modifier.weight(1f),
                selected = selectedAgentId == id,
                onClick = { onSelect(id) },
                label = {
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
                        Text(label)
                        Spacer(Modifier.width(6.dp))
                        Text(count.toString(), style = MaterialTheme.typography.labelSmall)
                    }
                },
            )
        }
    }
}

@Composable
private fun StatsRow(running: Int, attention: Int, unread: Int) {
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        StatPill("运行中 $running", StatusColors.running, Modifier.weight(1f))
        StatPill("待处理 $attention", StatusColors.attention, Modifier.weight(1f))
        StatPill("未读 $unread", MaterialTheme.colorScheme.primary, Modifier.weight(1f))
    }
}

@Composable
private fun StatPill(label: String, color: androidx.compose.ui.graphics.Color, modifier: Modifier = Modifier) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(50),
        color = color.copy(alpha = 0.10f),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = color,
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 7.dp),
        )
    }
}

@Composable
private fun ProjectHeader(section: ThreadSection, collapsed: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onToggle)
            .padding(top = 10.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Folder,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.width(16.dp),
        )
        Spacer(Modifier.width(6.dp))
        Text(
            section.title,
            style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
            modifier = Modifier.weight(1f, fill = false),
        )
        section.hostName?.let {
            Spacer(Modifier.width(6.dp))
            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
        }
        Spacer(Modifier.weight(1f))
        Spacer(Modifier.width(8.dp))
        Surface(
            shape = RoundedCornerShape(50),
            color = MaterialTheme.colorScheme.surfaceVariant,
        ) {
            Text(
                "${section.threads.size} 个任务",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }
        Icon(
            if (collapsed) Icons.Filled.KeyboardArrowDown else Icons.Filled.KeyboardArrowUp,
            contentDescription = if (collapsed) "展开" else "收起",
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(18.dp),
        )
    }
}

@Composable
private fun ThreadCard(thread: ThreadSummary, showHost: Boolean, onClick: () -> Unit) {
    Card(
        onClick = onClick,
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    thread.title,
                    style = MaterialTheme.typography.titleSmall.copy(fontWeight = FontWeight.SemiBold),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (thread.unreadCount > 0) {
                    Spacer(Modifier.width(8.dp))
                    Badge { Text(thread.unreadCount.toString()) }
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(
                thread.lastMessage,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(8.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                AgentBadge(AgentRegistry.forBackend(thread.execution.backend))
                Spacer(Modifier.width(6.dp))
                if (thread.execution.backend == "grok" && thread.execution.owner == "external") {
                    Text("电脑会话 · 仅查看", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                } else if (thread.execution.backend == "grok" && thread.execution.owner == "shared" && thread.status == ThreadStatus.Idle) {
                    Text("跨端续聊", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                } else ThreadStatusChip(thread.status)
                if (showHost) {
                    Spacer(Modifier.width(6.dp))
                    Icon(
                        Icons.Filled.DesktopWindows,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.width(14.dp),
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(
                        thread.hostName,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                }
                Spacer(Modifier.weight(1f))
                Text(
                    thread.updatedAt,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFFFAF8F3)
@Composable
private fun InboxScreenPreview() {
    var agentId by remember { mutableStateOf<String?>(null) }
    AgentPocketTheme {
        InboxScreen(
            repo = MockPocketRepository,
            selectedAgentId = agentId,
            onSelectAgent = { agentId = it },
            onOpenThread = {},
            onNewTask = {},
            onOpenSettings = {},
        )
    }
}
