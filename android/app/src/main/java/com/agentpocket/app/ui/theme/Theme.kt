package com.agentpocket.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Dark-first, calm, technical palette.
val Background = Color(0xFF0B0E13)
val Surface = Color(0xFF11151C)
val SurfaceHigh = Color(0xFF161C25)
val SurfaceVariant = Color(0xFF1A2029)
val Outline = Color(0xFF2A3441)
val TextPrimary = Color(0xFFE2E8F0)
val TextSecondary = Color(0xFF94A3B8)
val Accent = Color(0xFF7BD5C3)
val OnAccent = Color(0xFF0B2B25)

// Semantic status colors used across inbox and timeline.
object StatusColors {
    val running = Color(0xFF6FD3A7)
    val attention = Color(0xFFE5B567)
    val completed = Color(0xFF7FA6C9)
    val disconnected = Color(0xFF6B7280)
    val external = Color(0xFFE08A5B)
    val error = Color(0xFFF28B82)
    val diffAddBg = Color(0xFF14301F)
    val diffAddFg = Color(0xFF7CE0A3)
    val diffDelBg = Color(0xFF3A1B1E)
    val diffDelFg = Color(0xFFF2A0A0)
}

private val DarkScheme = darkColorScheme(
    primary = Accent,
    onPrimary = OnAccent,
    secondary = Color(0xFF8EA3B8),
    onSecondary = Color(0xFF10161E),
    tertiary = StatusColors.attention,
    background = Background,
    onBackground = TextPrimary,
    surface = Surface,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceVariant,
    onSurfaceVariant = TextSecondary,
    surfaceContainerHigh = SurfaceHigh,
    outline = Outline,
    error = StatusColors.error,
    onError = Color(0xFF3B0D0C),
)

@Composable
fun AgentPocketTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = DarkScheme,
        content = content,
    )
}
