package com.agentpocket.app.ui.components

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.DesktopWindows
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentpocket.app.data.model.DesktopRuntimeState
import com.agentpocket.app.data.model.HostRuntime
import com.agentpocket.app.ui.theme.StatusColors

/** Live Host/Desktop status. Every action is backed by a Host RPC. */
@Composable
fun HostRuntimeCard(
    hostName: String,
    hostOnline: Boolean,
    runtime: HostRuntime?,
    onRefresh: () -> Unit,
    onLaunch: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val state = if (hostOnline) runtime?.desktopState ?: DesktopRuntimeState.Unavailable else DesktopRuntimeState.Unavailable
    Card(
        modifier = modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
        shape = RoundedCornerShape(14.dp),
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.DesktopWindows,
                    contentDescription = null,
                    tint = if (hostOnline) StatusColors.running else StatusColors.disconnected,
                    modifier = Modifier.size(18.dp),
                )
                Spacer(Modifier.width(8.dp))
                Column(Modifier.weight(1f)) {
                    Text(hostName, style = MaterialTheme.typography.labelLarge)
                    Text(
                        if (hostOnline) "Host 在线" else "Host 离线",
                        style = MaterialTheme.typography.labelSmall,
                        color = if (hostOnline) StatusColors.running else StatusColors.disconnected,
                    )
                }
                IconButton(onClick = onRefresh, enabled = hostOnline) {
                    Icon(Icons.Filled.Refresh, contentDescription = "刷新电脑状态")
                }
            }
            if (hostOnline) when (runtime?.bridgeReady) {
                true -> RuntimeText("Codex 执行连接已就绪，可使用本机配置的模型。", StatusColors.running)
                false -> RuntimeText("Codex 执行连接暂不可用；其他 Agent 的状态请在新建任务中查看。", StatusColors.attention)
                null -> Unit
            }
            when (state) {
                DesktopRuntimeState.Ready -> RuntimeText("Codex Desktop 已连接，可创建和续写 Desktop 任务。", StatusColors.running)
                DesktopRuntimeState.Starting -> RuntimeText("Codex Desktop 正在启动，Attach 加载后会自动变为可用。", StatusColors.attention)
                DesktopRuntimeState.Closed -> {
                    RuntimeText("Codex Desktop 未运行。", MaterialTheme.colorScheme.onSurfaceVariant)
                    if (runtime?.canWake == true) {
                        OutlinedButton(onClick = onLaunch, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Filled.PowerSettingsNew, contentDescription = null, modifier = Modifier.size(16.dp))
                            Spacer(Modifier.width(8.dp))
                            Text("启动 Codex Desktop")
                        }
                    }
                }
                DesktopRuntimeState.Unavailable -> RuntimeText(
                    if (hostOnline) "正在读取 Codex Desktop 状态…" else "Host 离线，无法远程启动 Desktop。",
                    MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun RuntimeText(text: String, color: androidx.compose.ui.graphics.Color) {
    Text(
        text,
        style = MaterialTheme.typography.labelSmall,
        color = color,
        modifier = Modifier.padding(top = 4.dp, bottom = 8.dp),
    )
}
