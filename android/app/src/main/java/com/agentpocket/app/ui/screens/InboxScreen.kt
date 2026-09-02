package com.agentpocket.app.ui.screens

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
import androidx.compose.material.icons.filled.WarningAmber
import androidx.compose.material3.Badge
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
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
import androidx.compose.ui.text.font.FontFamily
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

/** 多电脑、多 Agent 的任务收件箱。当前线程来源均为 Codex。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    repo: PocketRepository,
    onOpenThread: (String) -> Unit,
    onNewTask: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val host by repo.host.collectAsState()
    val hosts by repo.hosts.collectAsState()
    val hostRuntimes by repo.hostRuntimes.collectAsState()
    val selectedHostId by repo.selectedHostId.collectAsState()
    val threads by repo.threads.collectAsState()
    val projects by repo.projects.collectAsState()
    val syncing by repo.syncing.collectAsState()
    val syncStatus by repo.syncStatus.collectAsState()
    val sections = remember(threads, selectedHostId, projects) {
        threadSections(threads, showHost = selectedHostId == null, projects = projects)
    }
    var collapsedSections by rememberSaveable { mutableStateOf(arrayListOf<String>()) }
    var agentFilter by rememberSaveable { mutableStateOf("all") }
    val desktopCount = threads.count { it.status == ThreadStatus.DesktopOwned }
    val externalCount = threads.count { it.status == ThreadStatus.ExternalBusy }
    val runningCount = threads.count { it.status == ThreadStatus.Active }
    val attentionCount = threads.count { it.status == ThreadStatus.NeedsAttention }
    val unreadCount = threads.sumOf { it.unreadCount }
    val selectedHost = hosts.firstOrNull { it.id == selectedHostId }

    LaunchedEffect(selectedHostId, selectedHost?.connectionState) {
        if (selectedHost?.connectionState == ConnectionState.Connected) repo.refreshHostRuntime(selectedHost.id)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Column {
                        Text("Agent Pocket", style = MaterialTheme.typography.titleMedium)
                        ConnectionPill(state = host.connectionState, relayName = host.relayName)
                    }
                },
                actions = {
                    IconButton(onClick = { repo.refreshAll() }, enabled = !syncing) {
                        Icon(Icons.Filled.Refresh, contentDescription = "刷新")
                    }
                    IconButton(onClick = onOpenSettings) {
                        Icon(Icons.Filled.Settings, contentDescription = "设置")
                    }
                },
            )
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                onClick = onNewTask,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("新建任务") },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
        ) {
            if (syncing) {
                LinearProgressIndicator(Modifier.fillMaxWidth())
                syncStatus?.let {
                    Text(
                        it,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 4.dp),
                    )
                }
            }
            PullToRefreshBox(
                isRefreshing = syncing,
                onRefresh = { repo.refreshAll() },
                modifier = Modifier
                    .weight(1f)
                    .fillMaxWidth(),
            ) {
                LazyColumn(
                    modifier = Modifier.fillMaxSize(),
                    contentPadding = androidx.compose.foundation.layout.PaddingValues(
                        start = 16.dp,
                        end = 16.dp,
                        top = 8.dp,
                        bottom = 96.dp,
                    ),
                    verticalArrangement = Arrangement.spacedBy(10.dp),
                ) {
                    selectedHost?.let { item ->
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
                    if (threads.isNotEmpty()) {
                        item(key = "stats", contentType = "dashboard") {
                            StatsRow(runningCount, attentionCount, unreadCount)
                        }
                    }
                    item(key = "agent-filter", contentType = "filter") {
                        Row(
                            modifier = Modifier
                                .fillMaxWidth()
                                .horizontalScroll(rememberScrollState()),
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                        ) {
                            FilterChip(
                                selected = agentFilter == "all",
                                onClick = { agentFilter = "all" },
                                label = { Text("全部 Agent") },
                            )
                            AgentRegistry.all.forEach { agent ->
                                FilterChip(
                                    selected = agentFilter == agent.kind.id,
                                    onClick = { if (agent.available) agentFilter = agent.kind.id },
                                    enabled = agent.available,
                                    label = {
                                        Text(
                                            if (agent.available) agent.displayName else "${agent.displayName} · 即将接入",
                                            maxLines = 1,
                                        )
                                    },
                                )
                            }
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
                    if (desktopCount > 0) {
                        item(key = "desktop-attached", contentType = "notice") {
                            SlimNotice("$desktopCount 个任务由 Codex Desktop 持有，可从手机续写；中断与审批仍在电脑端处理。")
                        }
                    }
                    if (externalCount > 0) {
                        item(key = "external-warning", contentType = "notice") {
                            SlimNotice(
                                "$externalCount 个会话被桌面端进程占用，未通过 Desktop Attach 确认，移动端仅可查看。",
                                warning = true,
                            )
                        }
                    }
                    if (threads.isEmpty()) {
                        item(key = "empty", contentType = "empty") {
                            Text(
                                if (hosts.isEmpty()) "还没有绑定 Windows 电脑" else "这台电脑暂时没有可显示的任务",
                                style = MaterialTheme.typography.bodyMedium,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(vertical = 32.dp),
                            )
                        }
                    }
                    // 按 Codex Desktop 的体系分组：一个项目一节，节内与节间都按最新活动排序。
                    sections.forEach { section ->
                        val collapsed = section.key in collapsedSections
                        item(key = "section:${section.key}", contentType = "section") {
                            ProjectHeader(
                                section = section,
                                collapsed = collapsed,
                                onToggle = {
                                    collapsedSections = ArrayList(collapsedSections).apply {
                                        if (!remove(section.key)) add(section.key)
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
    Surface(modifier = modifier, shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surface) {
        Text(
            label,
            style = MaterialTheme.typography.labelMedium,
            color = color,
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 8.dp),
        )
    }
}

@Composable
private fun SlimNotice(text: String, warning: Boolean = false) {
    val color = if (warning) StatusColors.external else MaterialTheme.colorScheme.onSurfaceVariant
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = StatusColors.external.copy(alpha = if (warning) 0.10f else 0.06f),
    ) {
        Row(
            Modifier
                .fillMaxWidth()
                .padding(horizontal = 10.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                if (warning) Icons.Filled.WarningAmber else Icons.Filled.DesktopWindows,
                contentDescription = null,
                tint = color,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.width(8.dp))
            Text(text, style = MaterialTheme.typography.labelSmall, color = color)
        }
    }
}

@Composable
private fun ProjectHeader(section: ThreadSection, collapsed: Boolean, onToggle: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onToggle)
            .padding(top = 8.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            Icons.Filled.Folder,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.width(16.dp),
        )
        Spacer(Modifier.width(6.dp))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    section.title,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                section.hostName?.let {
                    Spacer(Modifier.width(6.dp))
                    Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                }
            }
            if (section.cwd.isNotBlank()) {
                Text(
                    section.cwd,
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        Spacer(Modifier.width(8.dp))
        Text(
            "${section.threads.size} 个任务",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
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
    Card(onClick = onClick, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                AgentBadge(AgentRegistry.codex)
                Spacer(Modifier.width(6.dp))
                ThreadStatusChip(thread.status)
                Spacer(Modifier.weight(1f))
                Text(
                    thread.updatedAt,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(6.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    thread.title,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
                if (thread.unreadCount > 0) {
                    Spacer(Modifier.width(8.dp))
                    Badge { Text(thread.unreadCount.toString()) }
                }
            }
            Spacer(Modifier.height(2.dp))
            if (showHost) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        Icons.Filled.DesktopWindows,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.width(14.dp),
                    )
                    Spacer(Modifier.width(5.dp))
                    Text(
                        thread.hostName,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                Spacer(Modifier.height(2.dp))
            }
            Text(
                thread.cwd,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Spacer(Modifier.height(6.dp))
            Text(
                thread.lastMessage,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF0B0E13)
@Composable
private fun InboxScreenPreview() {
    AgentPocketTheme {
        InboxScreen(
            repo = MockPocketRepository,
            onOpenThread = {},
            onNewTask = {},
            onOpenSettings = {},
        )
    }
}
