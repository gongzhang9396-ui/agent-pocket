package com.agentpocket.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.unit.dp
import com.agentpocket.app.ui.theme.AgentAccents

enum class AgentKind(val id: String) {
    Codex("codex"),
    Grok("grok"),
    Kimi("kimi"),
}

data class AgentProfile(
    val kind: AgentKind,
    val displayName: String,
    val accent: Color,
    val available: Boolean,
    val capabilities: String,
)

/**
 * Future providers remain visible but disabled until a real Host adapter is
 * available. This prevents the UI from claiming unsupported capabilities.
 */
object AgentRegistry {
    val codex = AgentProfile(
        kind = AgentKind.Codex,
        displayName = "Codex",
        accent = AgentAccents.codex,
        available = true,
        capabilities = "执行、Plan、审批、中断与 Desktop 续写",
    )
    val grok = AgentProfile(
        kind = AgentKind.Grok,
        displayName = "Grok",
        accent = AgentAccents.grok,
        available = true,
        capabilities = "Grok CLI · 文本任务、实时进度、单次审批与中断",
    )
    val kimi = AgentProfile(
        kind = AgentKind.Kimi,
        displayName = "Kimi Code",
        accent = AgentAccents.kimi,
        available = false,
        capabilities = "Host 适配器尚未接入",
    )

    val all = listOf(codex, grok, kimi)
    fun forBackend(backend: String) = if (backend == "grok") grok else codex
}

@Composable
fun AgentBadge(agent: AgentProfile, modifier: Modifier = Modifier) {
    val color = if (agent.available) agent.accent else MaterialTheme.colorScheme.onSurfaceVariant
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(6.dp),
        color = color.copy(alpha = if (agent.available) 0.14f else 0.08f),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(5.dp),
        ) {
            Box(
                Modifier
                    .size(6.dp)
                    .clip(CircleShape)
                    .background(color.copy(alpha = if (agent.available) 1f else 0.5f)),
            )
            Text(
                if (agent.available) agent.displayName else "${agent.displayName} · 即将接入",
                style = MaterialTheme.typography.labelSmall,
                color = color.copy(alpha = if (agent.available) 1f else 0.7f),
            )
        }
    }
}
