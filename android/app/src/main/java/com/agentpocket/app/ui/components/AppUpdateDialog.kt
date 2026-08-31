package com.agentpocket.app.ui.components

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.agentpocket.app.update.AppUpdateState

@Composable
fun AppUpdateDialog(
    state: AppUpdateState,
    onDownload: () -> Unit,
    onInstall: () -> Unit,
) {
    var dismissedKey by rememberSaveable { mutableStateOf<String?>(null) }
    when (state) {
        is AppUpdateState.Available -> {
            val key = "available:${state.version}"
            if (dismissedKey != key) {
                AlertDialog(
                    onDismissRequest = { dismissedKey = key },
                    title = { Text("发现新版本 ${state.version}") },
                    text = { Text("更新包可以直接下载到本机，完成后由 Android 系统确认安装。") },
                    confirmButton = { TextButton(onClick = onDownload) { Text("下载更新") } },
                    dismissButton = { TextButton(onClick = { dismissedKey = key }) { Text("稍后") } },
                )
            }
        }

        is AppUpdateState.Downloading -> AlertDialog(
            onDismissRequest = {},
            title = { Text("正在下载 ${state.version}") },
            text = {
                Column {
                    LinearProgressIndicator(
                        progress = { state.progress / 100f },
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    Text("${state.progress}%")
                }
            },
            confirmButton = {},
        )

        is AppUpdateState.Ready -> {
            val key = "ready:${state.version}"
            if (dismissedKey != key) {
                AlertDialog(
                    onDismissRequest = { dismissedKey = key },
                    title = { Text("版本 ${state.version} 已下载") },
                    text = { Text("安装时 Android 会核对应用签名，并显示一次系统确认。") },
                    confirmButton = { TextButton(onClick = onInstall) { Text("安装") } },
                    dismissButton = { TextButton(onClick = { dismissedKey = key }) { Text("稍后") } },
                )
            }
        }

        else -> Unit
    }
}
