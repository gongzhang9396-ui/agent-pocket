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
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.agentpocket.app.BuildConfig
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.ui.components.ConnectionPill
import com.agentpocket.app.ui.components.SectionLabel
import com.agentpocket.app.ui.theme.AgentPocketTheme

/** 设置与设备信息：连接、通知、设备身份、中继详情。无生物识别与多主机入口。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    repo: PocketRepository,
    onBack: () -> Unit,
    onReenterPairing: () -> Unit,
) {
    val host by repo.host.collectAsState()
    val device by repo.device.collectAsState()

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("设置与设备信息") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(key = "connection", contentType = "card") {
                SettingsCard {
                    SectionLabel("连接")
                    Spacer(Modifier.height(8.dp))
                    ConnectionPill(state = host.connectionState, relayName = host.relayName)
                    Spacer(Modifier.height(10.dp))
                    InfoRow("主机", host.name)
                    InfoRow("连接路径", host.relayName)
                    InfoRow("Bridge 地址", host.wssUrl, mono = true)
                    InfoRow("最近在线", host.lastSeen)
                }
            }

            item(key = "device", contentType = "card") {
                SettingsCard {
                    SectionLabel("本机设备")
                    Spacer(Modifier.height(8.dp))
                    InfoRow("设备名称", device.name)
                    InfoRow("设备 ID", device.id, mono = true)
                    InfoRow("配对时间", device.pairedAt)
                    Spacer(Modifier.height(6.dp))
                    Row(
                        Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text("任务通知", style = MaterialTheme.typography.bodyMedium)
                            Text(
                                "会话完成或需要审批时推送提醒",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                        Switch(
                            checked = device.notificationEnabled,
                            onCheckedChange = { repo.setNotificationsEnabled(it) },
                        )
                    }
                }
            }

            item(key = "pairing", contentType = "card") {
                SettingsCard {
                    SectionLabel("配对")
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "公网入口只经过你的 HTTPS 中继；Windows Bridge 不监听局域网或公网地址。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(10.dp))
                    OutlinedButton(
                        onClick = {
                            repo.resetPairing()
                            onReenterPairing()
                        },
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text("重新进入配对流程")
                    }
                }
            }

            item(key = "about", contentType = "card") {
                SettingsCard {
                    SectionLabel("关于")
                    Spacer(Modifier.height(8.dp))
                    InfoRow("版本", BuildConfig.VERSION_NAME)
                    Text(
                        "Agent Pocket — Windows 桌面端 Codex 的私有移动端控制台。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun SettingsCard(content: @Composable () -> Unit) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(14.dp)) {
            content()
        }
    }
}

@Composable
private fun InfoRow(label: String, value: String, mono: Boolean = false) {
    Row(
        Modifier
            .fillMaxWidth()
            .padding(vertical = 3.dp),
    ) {
        Text(
            label,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(88.dp),
        )
        Text(
            value,
            style = MaterialTheme.typography.bodySmall,
            fontFamily = if (mono) FontFamily.Monospace else null,
        )
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF0B0E13)
@Composable
private fun SettingsScreenPreview() {
    AgentPocketTheme {
        SettingsScreen(repo = MockPocketRepository, onBack = {}, onReenterPairing = {})
    }
}
