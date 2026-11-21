package com.agentpocket.app.ui.theme

import androidx.compose.foundation.Image
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import com.agentpocket.app.R

@Composable
private fun SkinPreview(skin: SkinStyle) {
    AgentPocketTheme(skin = skin) {
        Surface(color = MaterialTheme.colorScheme.background, shape = MaterialTheme.shapes.small,
            border = BorderStroke(1.dp, MaterialTheme.colorScheme.outline)) {
            Column(Modifier.fillMaxWidth().height(90.dp).padding(8.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(if (skin == SkinStyle.Pixel) ">_" else "Aa 手记", style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary)
                Box(Modifier.fillMaxWidth(.8f).height(2.dp).background(MaterialTheme.colorScheme.outline))
                Box(Modifier.fillMaxWidth(.55f).height(2.dp).background(MaterialTheme.colorScheme.outline))
                Box(Modifier.align(Alignment.End).size(28.dp, 14.dp).clip(SkinGeometry.action).background(MaterialTheme.colorScheme.primary))
            }
        }
    }
}

@Composable
fun SkinPicker() {
    val selected = LocalSkin.current
    val choose = LocalSetSkin.current
    Column {
        Text("界面风格", style = MaterialTheme.typography.titleSmall)
        Text("列表、对话、字体和控件一起变化。", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Spacer(Modifier.height(8.dp))
        Row(Modifier.fillMaxWidth().selectableGroup(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            SkinStyle.entries.forEach { skin ->
                Surface(
                    modifier = Modifier.weight(1f).selectable(selected = selected == skin, onClick = { choose(skin) }, role = Role.RadioButton),
                    shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceVariant,
                    border = BorderStroke(if (selected == skin) 2.dp else 1.dp, if (selected == skin) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.outlineVariant),
                ) {
                    Column(Modifier.padding(6.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                        SkinPreview(skin)
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(selected = selected == skin, onClick = null, modifier = Modifier.size(32.dp))
                            Text(skin.label, style = MaterialTheme.typography.labelSmall, maxLines = 2)
                        }
                    }
                }
            }
        }
    }
}
