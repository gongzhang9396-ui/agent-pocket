package com.agentpocket.app.ui.theme

import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.unit.dp

/** Shared geometry also covers controls whose Material defaults use a full capsule. */
object SkinGeometry {
    val panel: Shape @Composable get() = if (LocalSkin.current == SkinStyle.Plain) RoundedCornerShape(14.dp) else MaterialTheme.shapes.medium
    val input: Shape @Composable get() = if (LocalSkin.current == SkinStyle.Plain) RoundedCornerShape(20.dp) else MaterialTheme.shapes.small
    val action: Shape @Composable get() = if (LocalSkin.current == SkinStyle.Plain) CircleShape else MaterialTheme.shapes.small
    val badge: Shape @Composable get() = if (LocalSkin.current == SkinStyle.Plain) RoundedCornerShape(6.dp) else MaterialTheme.shapes.extraSmall
    val message: Shape @Composable get() = if (LocalSkin.current == SkinStyle.Plain) RoundedCornerShape(14.dp, 14.dp, 4.dp, 14.dp) else MaterialTheme.shapes.small
}

/** A ruled edge gives structure without placing a texture behind text. */
@Composable
fun Modifier.skinRule(): Modifier {
    val skin = LocalSkin.current
    val color = if (skin == SkinStyle.Oil) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.primary
    return if (skin == SkinStyle.Plain) this else drawWithContent {
        drawContent()
        drawLine(color, Offset(0f, size.height - 1.dp.toPx()), Offset(size.width, size.height - 1.dp.toPx()), 2.dp.toPx())
    }
}
