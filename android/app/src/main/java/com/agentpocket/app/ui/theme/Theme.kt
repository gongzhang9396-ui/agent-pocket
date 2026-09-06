package com.agentpocket.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

// Light-first palette: warm off-white canvas, white cards, emerald/teal accent.
val Background = Color(0xFFFAF8F3)
val Surface = Color(0xFFFFFFFF)
val SurfaceHigh = Color(0xFFF5F2EA)
val SurfaceVariant = Color(0xFFEFEBE1)
val Outline = Color(0xFFE3DECE)
val TextPrimary = Color(0xFF28261F)
val TextSecondary = Color(0xFF6E6A5C)
val Accent = Color(0xFF0F766E)
val OnAccent = Color(0xFFFFFFFF)

/** Stable visual identity for each coding-agent backend. */
object AgentAccents {
    val codex = Color(0xFF0F766E)
    val grok = Color(0xFF7C5CD6)
    val kimi = Color(0xFF2B6CB0)
}

// Semantic status colors, all readable on white/light backgrounds.
object StatusColors {
    val running = Color(0xFF047857)
    val attention = Color(0xFFB45309)
    val completed = Color(0xFF4A6FA1)
    val disconnected = Color(0xFF6B7280)
    val external = Color(0xFFC05621)
    val error = Color(0xFFB3261E)
    val diffAddBg = Color(0xFFE4F4E8)
    val diffAddFg = Color(0xFF1B7A43)
    val diffDelBg = Color(0xFFFBEBE9)
    val diffDelFg = Color(0xFFB3261E)
}

private val LightScheme = lightColorScheme(
    primary = Accent,
    onPrimary = OnAccent,
    primaryContainer = Color(0xFFD9EFE8),
    onPrimaryContainer = Color(0xFF0B3B32),
    secondary = Color(0xFF5F6B60),
    onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFE1EDE5),
    onSecondaryContainer = Color(0xFF254C40),
    tertiary = StatusColors.attention,
    onTertiary = Color.White,
    tertiaryContainer = Color(0xFFFFEBD1),
    onTertiaryContainer = Color(0xFF643A0D),
    background = Background,
    onBackground = TextPrimary,
    surface = Surface,
    surfaceTint = Accent,
    onSurface = TextPrimary,
    surfaceVariant = SurfaceVariant,
    onSurfaceVariant = TextSecondary,
    surfaceContainerLowest = Surface,
    surfaceContainerLow = Background,
    surfaceContainer = Color(0xFFF7F4ED),
    surfaceContainerHigh = SurfaceHigh,
    surfaceContainerHighest = SurfaceVariant,
    outline = Outline,
    outlineVariant = Color(0xFFEDE8DA),
    error = StatusColors.error,
    onError = Color(0xFFFFFFFF),
)

@Composable
fun AgentPocketTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightScheme,
        content = content,
    )
}
