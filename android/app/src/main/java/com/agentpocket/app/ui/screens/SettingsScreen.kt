package com.agentpocket.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Download
import androidx.compose.material.icons.filled.InstallMobile
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.agentpocket.app.BuildConfig
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.data.model.ConnectionState
import com.agentpocket.app.data.model.Device
import com.agentpocket.app.ui.components.AgentBadge
import com.agentpocket.app.ui.components.AgentRegistry
import com.agentpocket.app.ui.components.ConnectionPill
import com.agentpocket.app.ui.components.QrScannerButton
import com.agentpocket.app.ui.components.SectionLabel
import com.agentpocket.app.ui.theme.AgentPocketTheme
import com.agentpocket.app.update.AppUpdateState

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    repo: PocketRepository,
    onBack: () -> Unit,
    onReenterPairing: () -> Unit,
    updateState: AppUpdateState,
    onCheckForUpdates: () -> Unit,
    onDownloadUpdate: () -> Unit,
    onInstallUpdate: () -> Unit,
) {
    val aggregateHost by repo.host.collectAsState()
    val hosts by repo.hosts.collectAsState()
    val device by repo.device.collectAsState()
    val devices by repo.accountDevices.collectAsState()
    val actionError by repo.actionError.collectAsState()
    val authStatus by repo.authStatus.collectAsState()
    val agentStates by repo.agents.collectAsState()
    var showPasswordForm by rememberSaveable { mutableStateOf(false) }
    var currentPassword by rememberSaveable { mutableStateOf("") }
    var newPassword by rememberSaveable { mutableStateOf("") }
    var confirmPassword by rememberSaveable { mutableStateOf("") }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(key = "relay", contentType = "card") {
                SettingsCard {
                    SectionLabel("Relay")
                    Spacer(Modifier.height(8.dp))
                    ConnectionPill(state = aggregateHost.connectionState, relayName = aggregateHost.relayName)
                    Spacer(Modifier.height(10.dp))
                    InfoRow("地址", aggregateHost.wssUrl, mono = true)
                    InfoRow("状态", aggregateHost.lastSeen)
                }
            }

            item(key = "agents", contentType = "card") {
                SettingsCard {
                    SectionLabel("编程 Agent")
                    Spacer(Modifier.height(8.dp))
                    AgentRegistry.all.forEachIndexed { index, agent ->
                        if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp))
                        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                            Column(Modifier.weight(1f)) {
                                Text(agent.displayName, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    agentStates.firstOrNull { it.id == agent.kind.id }?.let { state ->
                                        state.error ?: if (state.available) "${agent.capabilities}${state.version?.let { " · $it" }.orEmpty()}" else "电脑上的 Agent 尚未就绪"
                                    } ?: agent.capabilities,
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            AgentBadge(agent)
                        }
                    }
                }
            }

            item(key = "hosts", contentType = "card") {
                SettingsCard {
                    SectionLabel("Windows 电脑")
                    Spacer(Modifier.height(8.dp))
                    if (hosts.isEmpty()) {
                        Text("尚未绑定电脑", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        hosts.forEachIndexed { index, host ->
                            if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp))
                            Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                                Column(Modifier.weight(1f)) {
                                    Text(host.name, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    Text(
                                        if (host.connectionState == ConnectionState.Connected) "在线" else "离线 · ${host.lastSeen.ifBlank { "尚未连接" }}",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = if (host.connectionState == ConnectionState.Connected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                                if (host.connectionState == ConnectionState.Connected) {
                                    Icon(Icons.Filled.Check, contentDescription = "在线", tint = MaterialTheme.colorScheme.primary)
                                }
                            }
                        }
                    }
                }
            }

            item(key = "host-enrollment", contentType = "card") {
                SettingsCard {
                    SectionLabel("绑定新电脑")
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "在 Windows Host 上生成五分钟绑定码，然后用这里扫描。电脑会归属当前 Relay 账号。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(10.dp))
                    QrScannerButton(text = "扫描 Windows Host 二维码", onScanned = { repo.approveHostFromQr(it) })
                    actionError?.let {
                        Spacer(Modifier.height(8.dp))
                        Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                    }
                }
            }

            item(key = "this-device", contentType = "card") {
                SettingsCard {
                    SectionLabel("这部手机")
                    Spacer(Modifier.height(8.dp))
                    InfoRow("设备", device.name)
                    InfoRow("设备 ID", device.id, mono = true)
                    InfoRow("状态", device.status)
                    Spacer(Modifier.height(6.dp))
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("任务通知", style = MaterialTheme.typography.bodyMedium)
                            Text("任务完成或需要关注时提醒", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                        Switch(checked = device.notificationEnabled, onCheckedChange = repo::setNotificationsEnabled)
                    }
                }
            }

            item(key = "devices", contentType = "card") {
                SettingsCard {
                    SectionLabel("账号设备")
                    Spacer(Modifier.height(8.dp))
                    if (devices.isEmpty()) {
                        Text("设备列表正在同步", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    } else {
                        devices.forEachIndexed { index, item ->
                            if (index > 0) HorizontalDivider(Modifier.padding(vertical = 8.dp))
                            DeviceRow(
                                item = item,
                                isCurrent = item.id == device.id,
                                onApprove = { repo.approveDevice(item.id) },
                                onRevoke = { repo.revokeAccountDevice(item.id) },
                            )
                        }
                    }
                }
            }

            item(key = "account", contentType = "card") {
                SettingsCard {
                    SectionLabel("账号")
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = { showPasswordForm = !showPasswordForm },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(if (showPasswordForm) "收起修改密码" else "修改密码")
                    }
                    if (showPasswordForm) {
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = currentPassword,
                            onValueChange = { currentPassword = it },
                            label = { Text("当前密码") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = newPassword,
                            onValueChange = { newPassword = it },
                            label = { Text("新密码") },
                            supportingText = { Text("12-128 个字符") },
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        OutlinedTextField(
                            value = confirmPassword,
                            onValueChange = { confirmPassword = it },
                            label = { Text("确认新密码") },
                            isError = confirmPassword.isNotEmpty() && confirmPassword != newPassword,
                            singleLine = true,
                            visualTransformation = PasswordVisualTransformation(),
                            modifier = Modifier.fillMaxWidth(),
                        )
                        Spacer(Modifier.height(8.dp))
                        Button(
                            onClick = { repo.changePassword(currentPassword, newPassword) },
                            enabled = currentPassword.length in 12..128 && newPassword.length in 12..128 && confirmPassword == newPassword,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Text("保存新密码")
                        }
                        if (authStatus == "密码已修改") {
                            Spacer(Modifier.height(6.dp))
                            Text(authStatus, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                        }
                        actionError?.let {
                            Spacer(Modifier.height(6.dp))
                            Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                        }
                    }
                    Spacer(Modifier.height(8.dp))
                    OutlinedButton(
                        onClick = onReenterPairing,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("重新登录 Relay")
                    }
                    Spacer(Modifier.height(8.dp))
                    TextButton(
                        onClick = { repo.resetPairing() },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("退出并清除本机凭据")
                    }
                }
            }

            item(key = "update", contentType = "card") {
                SettingsCard {
                    SectionLabel("应用更新")
                    Spacer(Modifier.height(8.dp))
                    when (val update = updateState) {
                        AppUpdateState.Idle -> UpdateText("尚未检查更新")
                        AppUpdateState.Checking -> UpdateText("正在通过 Relay 检查私有更新")
                        AppUpdateState.UpToDate -> UpdateText("当前已是最新版本")
                        is AppUpdateState.Available -> UpdateText("发现版本 ${update.version}，安装包约 ${megabytes(update.sizeBytes)} MB")
                        is AppUpdateState.Downloading -> {
                            UpdateText("正在下载版本 ${update.version} · ${update.progress}%")
                            Spacer(Modifier.height(8.dp))
                            LinearProgressIndicator(progress = { update.progress / 100f }, modifier = Modifier.fillMaxWidth())
                        }
                        is AppUpdateState.Ready -> UpdateText("版本 ${update.version} 已下载并通过校验")
                        is AppUpdateState.Error -> UpdateText(update.message)
                    }
                    Spacer(Modifier.height(10.dp))
                    when (updateState) {
                        is AppUpdateState.Available -> Button(onClick = onDownloadUpdate, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Filled.Download, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text("下载更新")
                        }
                        is AppUpdateState.Ready -> Button(onClick = onInstallUpdate, modifier = Modifier.fillMaxWidth()) {
                            Icon(Icons.Filled.InstallMobile, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text("安装更新")
                        }
                        is AppUpdateState.Downloading -> Unit
                        else -> OutlinedButton(
                            onClick = onCheckForUpdates,
                            enabled = updateState !is AppUpdateState.Checking,
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Icon(Icons.Filled.Refresh, contentDescription = null)
                            Spacer(Modifier.width(8.dp))
                            Text("检查更新")
                        }
                    }
                }
            }

            item(key = "about", contentType = "card") {
                SettingsCard {
                    SectionLabel("关于")
                    Spacer(Modifier.height(8.dp))
                    InfoRow("版本", BuildConfig.VERSION_NAME)
                    Text(
                        "Agent Pocket · 多电脑、多 Agent 远程编程控制台",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }
    }
}

@Composable
private fun DeviceRow(item: Device, isCurrent: Boolean, onApprove: () -> Unit, onRevoke: () -> Unit) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(if (isCurrent) "${item.name}（本机）" else item.name, style = MaterialTheme.typography.bodyMedium)
            Text(
                when (item.status) { "pending" -> "等待批准"; "approved" -> "已批准"; else -> item.status },
                style = MaterialTheme.typography.labelSmall,
                color = if (item.status == "pending") MaterialTheme.colorScheme.tertiary else MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        if (item.status == "pending") {
            Button(onClick = onApprove) { Text("批准") }
        } else {
            TextButton(onClick = onRevoke) { Text(if (isCurrent) "撤销并退出" else "撤销") }
        }
    }
}

@Composable
private fun SettingsCard(content: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp)) { content() }
    }
}

@Composable
private fun InfoRow(label: String, value: String, mono: Boolean = false) {
    Row(Modifier.fillMaxWidth().padding(vertical = 3.dp)) {
        Text(label, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.width(72.dp))
        Text(value, style = MaterialTheme.typography.bodySmall, fontFamily = if (mono) FontFamily.Monospace else null, overflow = TextOverflow.Ellipsis)
    }
}

@Composable
private fun UpdateText(value: String) {
    Text(value, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

private fun megabytes(bytes: Long): Long = if (bytes <= 0) 0 else (bytes + 1024 * 1024 - 1) / (1024 * 1024)

@Preview(showBackground = true, backgroundColor = 0xFF0B0E13)
@Composable
private fun SettingsScreenPreview() {
    AgentPocketTheme {
        SettingsScreen(
            repo = MockPocketRepository,
            onBack = {},
            onReenterPairing = {},
            updateState = AppUpdateState.Available("0.3.2", 24L * 1024 * 1024),
            onCheckForUpdates = {},
            onDownloadUpdate = {},
            onInstallUpdate = {},
        )
    }
}
