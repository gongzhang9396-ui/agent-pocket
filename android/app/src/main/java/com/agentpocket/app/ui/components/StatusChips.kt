package com.agentpocket.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentpocket.app.data.model.ConnectionState
import com.agentpocket.app.data.model.ThreadStatus
import com.agentpocket.app.ui.theme.StatusColors

/** Small pill showing Bridge connection state, used in the inbox top bar and settings. */
@Composable
fun ConnectionPill(state: ConnectionState, relayName: String, modifier: Modifier = Modifier) {
    val (color, label) = when (state) {
        ConnectionState.Connected -> StatusColors.running to "已连接 · $relayName"
        ConnectionState.Connecting -> StatusColors.attention to "连接中…"
        ConnectionState.Disconnected -> StatusColors.disconnected to "已断开"
    }
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(50),
        color = MaterialTheme.colorScheme.surfaceVariant,
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            Box(
                Modifier
                    .size(7.dp)
                    .clip(CircleShape)
                    .background(color),
            )
            Text(label, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

data class StatusStyle(val label: String, val color: Color, val icon: String)

fun ThreadStatus.style(): StatusStyle = when (this) {
    ThreadStatus.Active -> StatusStyle("运行中", StatusColors.running, "●")
    ThreadStatus.NeedsAttention -> StatusStyle("待处理", StatusColors.attention, "▲")
    ThreadStatus.Completed -> StatusStyle("已完成", StatusColors.completed, "✓")
    ThreadStatus.Idle -> StatusStyle("已断开", StatusColors.disconnected, "○")
    ThreadStatus.DesktopOwned -> StatusStyle("Desktop 可续写", StatusColors.external, "◆")
    ThreadStatus.ExternalBusy -> StatusStyle("外部占用", StatusColors.external, "◇")
}

/** Compact status chip used on inbox cards and the detail top bar. */
@Composable
fun ThreadStatusChip(status: ThreadStatus, modifier: Modifier = Modifier) {
    val style = status.style()
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(6.dp),
        color = style.color.copy(alpha = 0.14f),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Text(style.icon, fontSize = 9.sp, color = style.color)
            Text(style.label, style = MaterialTheme.typography.labelSmall, color = style.color)
        }
    }
}

/** Muted uppercase-style section label used to group settings and form blocks. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Text(
        text = text,
        modifier = modifier,
        style = MaterialTheme.typography.labelMedium,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
}

/** Monospaced, horizontally scrollable block for commands, output and code. */
@Composable
fun MonoBlock(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = MaterialTheme.colorScheme.onSurface,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(Color(0xFF0A0D11))
            .horizontalScroll(rememberScrollState())
            .padding(10.dp),
    ) {
        Text(
            text = text,
            fontFamily = FontFamily.Monospace,
            fontSize = 12.sp,
            lineHeight = 17.sp,
            color = color,
            softWrap = false,
        )
    }
}
