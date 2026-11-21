package com.agentpocket.app.ui.theme

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

enum class SkinStyle(val id: String, val label: String) {
    Plain("plain", "原色"), Pixel("pixel", "像素掌机"), Oil("oil", "油画手记");
    companion object { fun fromId(id: String?): SkinStyle = entries.firstOrNull { it.id == id } ?: Plain }
}

val LocalSkin = staticCompositionLocalOf { SkinStyle.Plain }
val LocalSetSkin = staticCompositionLocalOf<(SkinStyle) -> Unit> { {} }

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

// Status text must remain readable in both the paper and the dark handheld skin.
object StatusColors {
    val running: Color @Composable get() = adaptive(0xFF047857, 0xFF96CEAC)
    val attention: Color @Composable get() = adaptive(0xFF95500B, 0xFFEDC27C)
    val completed: Color @Composable get() = adaptive(0xFF4A6FA1, 0xFFA4C4E3)
    val disconnected: Color @Composable get() = adaptive(0xFF62695F, 0xFFACBAB9)
    val external: Color @Composable get() = adaptive(0xFF9C4C24, 0xFFE9AD84)
    val error: Color @Composable get() = MaterialTheme.colorScheme.error
    val diffAddBg: Color @Composable get() = adaptive(0xFFE4F4E8, 0xFF203D31)
    val diffAddFg: Color @Composable get() = adaptive(0xFF1B7A43, 0xFFACE0B8)
    val diffDelBg: Color @Composable get() = adaptive(0xFFFBEBE9, 0xFF472E2D)
    val diffDelFg: Color @Composable get() = adaptive(0xFFB3261E, 0xFFFFB5AA)
    @Composable private fun adaptive(light: Long, dark: Long) = Color(if (LocalSkin.current == SkinStyle.Pixel) dark else light)
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
    tertiary = Color(0xFFB45309),
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
    error = Color(0xFFB3261E),
    onError = Color(0xFFFFFFFF),
)

@Composable
fun AgentPocketTheme(skin: SkinStyle = SkinStyle.Plain, onSkinChange: (SkinStyle) -> Unit = {}, content: @Composable () -> Unit) {
    val scheme = when (skin) {
        SkinStyle.Plain -> LightScheme
        SkinStyle.Pixel -> darkColorScheme(
            primary = Color(0xFFE6B964), onPrimary = Color(0xFF20251F), primaryContainer = Color(0xFF344B52), onPrimaryContainer = Color(0xFFF3EDDD),
            secondary = Color(0xFF96CEAC), onSecondary = Color(0xFF142B22), secondaryContainer = Color(0xFF283B44), onSecondaryContainer = Color(0xFFD2D7CE),
            tertiary = Color(0xFFEDC27C), onTertiary = Color(0xFF302718), tertiaryContainer = Color(0xFF3A3225), onTertiaryContainer = Color(0xFFF3D49E),
            background = Color(0xFF141D24), onBackground = Color(0xFFEDE7D7), surface = Color(0xFF21303A), onSurface = Color(0xFFEDE7D7),
            surfaceTint = Color(0xFFE6B964), surfaceContainerLowest = Color(0xFF111A21), surfaceContainerLow = Color(0xFF18232B),
            surfaceContainer = Color(0xFF21303A), surfaceContainerHigh = Color(0xFF283B44), surfaceContainerHighest = Color(0xFF344B52),
            surfaceVariant = Color(0xFF283B44), onSurfaceVariant = Color(0xFFACBAB9), outline = Color(0xFF698087), outlineVariant = Color(0xFF3C505A),
            error = Color(0xFFFFB5AA), onError = Color(0xFF561C18), errorContainer = Color(0xFF472E2D), onErrorContainer = Color(0xFFFFDAD5),
            inverseSurface = Color(0xFFEDE7D7), inverseOnSurface = Color(0xFF18232B), inversePrimary = Color(0xFF6C511E),
        )
        SkinStyle.Oil -> LightScheme.copy(
            primary = Color(0xFF3C5144), onPrimary = Color(0xFFFFF6E3), primaryContainer = Color(0xFFE3E7D7), onPrimaryContainer = Color(0xFF2E4436),
            secondary = Color(0xFF805137), secondaryContainer = Color(0xFFEFDFC8), onSecondaryContainer = Color(0xFF5C3C25),
            tertiary = Color(0xFF92502F), tertiaryContainer = Color(0xFFEFDFC8), onTertiaryContainer = Color(0xFF5C3C25),
            background = Color(0xFFF6EFDF), onBackground = Color(0xFF302F27), surface = Color(0xFFFFF9ED), onSurface = Color(0xFF302F27),
            surfaceTint = Color(0xFF3C5144), surfaceContainerLowest = Color(0xFFFFF9ED), surfaceContainerLow = Color(0xFFF6EFDF), surfaceContainer = Color(0xFFEEE4D1),
            surfaceContainerHigh = Color(0xFFE8DDC7), surfaceContainerHighest = Color(0xFFDDD2B8),
            surfaceVariant = Color(0xFFE8DDC7), onSurfaceVariant = Color(0xFF676B58), outline = Color(0xFFA7997C), outlineVariant = Color(0xFFD5C8AE),
        )
    }
    val shapes = if (skin == SkinStyle.Pixel) Shapes(
        extraSmall = RoundedCornerShape(0.dp), small = RoundedCornerShape(2.dp), medium = RoundedCornerShape(2.dp),
        large = RoundedCornerShape(2.dp), extraLarge = RoundedCornerShape(2.dp),
    ) else if (skin == SkinStyle.Oil) Shapes(
        extraSmall = RoundedCornerShape(1.dp), small = RoundedCornerShape(3.dp), medium = RoundedCornerShape(3.dp),
        large = RoundedCornerShape(4.dp), extraLarge = RoundedCornerShape(4.dp),
    ) else Shapes()
    val base = Typography()
    val display = when (skin) { SkinStyle.Pixel -> FontFamily.Monospace; SkinStyle.Oil -> FontFamily.Serif; else -> FontFamily.Default }
    val typography = if (skin == SkinStyle.Plain) base else base.copy(
        headlineLarge = base.headlineLarge.copy(fontFamily = display), headlineMedium = base.headlineMedium.copy(fontFamily = display),
        headlineSmall = base.headlineSmall.copy(fontFamily = display),
        titleLarge = base.titleLarge.copy(fontFamily = display, fontWeight = FontWeight.SemiBold, fontSize = 24.sp),
        titleMedium = base.titleMedium.copy(fontFamily = display, fontSize = 18.sp),
        titleSmall = base.titleSmall.copy(fontFamily = display, fontSize = 16.sp),
        labelLarge = base.labelLarge.copy(fontFamily = if (skin == SkinStyle.Pixel) display else FontFamily.Default),
        labelMedium = base.labelMedium.copy(fontFamily = if (skin == SkinStyle.Pixel) display else FontFamily.Default),
        bodyMedium = base.bodyMedium.copy(fontSize = 15.sp, lineHeight = 24.sp),
        bodySmall = base.bodySmall.copy(fontSize = 13.sp, lineHeight = 20.sp),
    )
    CompositionLocalProvider(LocalSkin provides skin, LocalSetSkin provides onSkinChange) {
        MaterialTheme(colorScheme = scheme, shapes = shapes, typography = typography, content = content)
    }
}
