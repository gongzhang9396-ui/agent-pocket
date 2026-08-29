package com.agentpocket.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Badge
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.data.model.ThreadStatus
import com.agentpocket.app.data.model.ThreadSummary
import com.agentpocket.app.ui.components.ConnectionPill
import com.agentpocket.app.ui.components.ThreadStatusChip
import com.agentpocket.app.ui.theme.AgentPocketTheme
import com.agentpocket.app.ui.theme.StatusColors

/** 会话收件箱：默认落地页。区分运行中 / 待处理 / 已完成 / 已断开 / 桌面端运行中。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen(
    repo: PocketRepository,
    onOpenThread: (String) -> Unit,
    onNewTask: () -> Unit,
    onOpenSettings: () -> Unit,
) {
    val host by repo.host.collectAsState()
    val threads by repo.threads.collectAsState()
    val desktopCount = threads.count { it.status == ThreadStatus.DesktopOwned }
    val externalCount = threads.count { it.status == ThreadStatus.ExternalBusy }

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
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(
                start = 16.dp,
                end = 16.dp,
                top = 8.dp,
                bottom = 96.dp,
            ),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (desktopCount > 0) {
                item(key = "desktop-attached", contentType = "banner") {
                    DesktopAttachedBanner(desktopCount)
                }
            }
            if (externalCount > 0) {
                item(key = "external-warning", contentType = "banner") {
                    ExternalBusyBanner(externalCount)
                }
            }
            items(threads, key = { it.id }, contentType = { "thread" }) { thread ->
                ThreadCard(thread = thread, onClick = { onOpenThread(thread.id) })
            }
        }
    }
}

@Composable
private fun DesktopAttachedBanner(count: Int) {
    Card(
        colors = CardDefaults.cardColors(containerColor = StatusColors.external.copy(alpha = 0.10f)),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.DesktopWindows, contentDescription = null, tint = StatusColors.external, modifier = Modifier.width(18.dp))
            Spacer(Modifier.width(10.dp))
            Column {
                Text("已附着 $count 个 Codex Desktop 任务", style = MaterialTheme.typography.labelMedium, color = StatusColors.external)
                Text("可从手机继续发送；中断与审批暂时仍在电脑端处理。", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
private fun ExternalBusyBanner(count: Int) {
    Card(
        colors = CardDefaults.cardColors(containerColor = StatusColors.external.copy(alpha = 0.10f)),
        shape = RoundedCornerShape(12.dp),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Icon(
                Icons.Filled.DesktopWindows,
                contentDescription = null,
                tint = StatusColors.external,
                modifier = Modifier.width(18.dp),
            )
            Spacer(Modifier.width(10.dp))
            Column {
                Text(
                    "有 $count 个会话正在桌面端 Codex 中运行",
                    style = MaterialTheme.typography.labelMedium,
                    color = StatusColors.external,
                )
                Text(
                    "该任务未通过 Desktop Attach 确认，无法从移动端发送或强制接管。",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun ThreadCard(thread: ThreadSummary, onClick: () -> Unit) {
    Card(onClick = onClick, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
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
