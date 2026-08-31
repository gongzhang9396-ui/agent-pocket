package com.agentpocket.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.Security
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.ui.theme.AgentPocketTheme

/** Relay v2 account entry. New phones stay here until a trusted phone approves them. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PairingScreen(
    repo: PocketRepository,
    onPaired: () -> Unit,
    onBack: (() -> Unit)? = null,
) {
    val host by repo.host.collectAsState()
    val paired by repo.isPaired.collectAsState()
    val authStatus by repo.authStatus.collectAsState()
    var mode by rememberSaveable { mutableStateOf(0) }
    var relayUrl by rememberSaveable { mutableStateOf(host.wssUrl) }
    var username by rememberSaveable { mutableStateOf("") }
    var displayName by rememberSaveable { mutableStateOf("") }
    var password by rememberSaveable { mutableStateOf("") }
    var confirmPassword by rememberSaveable { mutableStateOf("") }
    var inviteUrl by rememberSaveable { mutableStateOf("") }
    val busy = authStatus.startsWith("正在")

    LaunchedEffect(paired) { if (paired) onPaired() }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Agent Pocket Relay") },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                        }
                    }
                },
            )
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
                Column(Modifier.padding(14.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                        Icon(
                            Icons.Filled.Security,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(19.dp),
                        )
                        Text("你的私有 Codex 中继", style = MaterialTheme.typography.titleSmall)
                    }
                    Spacer(Modifier.height(8.dp))
                    SecurityPoint("一个账号可连接多台 Windows 电脑和多部手机。")
                    SecurityPoint("任务正文、代码和命令在手机与 Host 之间端到端加密。")
                    SecurityPoint("新手机必须由已批准设备确认后才能读取任务。")
                }
            }

            Spacer(Modifier.height(16.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(selected = mode == 0, onClick = { mode = 0 }, label = { Text("登录") })
                FilterChip(selected = mode == 1, onClick = { mode = 1 }, label = { Text("接受邀请") })
            }
            Spacer(Modifier.height(14.dp))

            if (mode == 1) {
                OutlinedTextField(
                    value = inviteUrl,
                    onValueChange = { inviteUrl = it.trim() },
                    label = { Text("邀请链接") },
                    placeholder = { Text("https://relay.example.com/#邀请信息") },
                    minLines = 2,
                    modifier = Modifier.fillMaxWidth(),
                )
                Spacer(Modifier.height(10.dp))
            }

            OutlinedTextField(
                value = relayUrl,
                onValueChange = { relayUrl = it.trim() },
                label = { Text(if (mode == 0) "Relay 地址" else "Relay 地址（可从邀请链接自动识别）") },
                placeholder = { Text("https://relay.example.com") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                value = username,
                onValueChange = { username = it },
                label = { Text("用户名") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth(),
            )
            if (mode == 1) {
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = displayName,
                    onValueChange = { displayName = it },
                    label = { Text("显示名称") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(imeAction = ImeAction.Next),
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            Spacer(Modifier.height(10.dp))
            OutlinedTextField(
                value = password,
                onValueChange = { password = it },
                label = { Text("密码") },
                supportingText = { Text("12-128 个字符") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                modifier = Modifier.fillMaxWidth(),
            )
            if (mode == 1) {
                Spacer(Modifier.height(10.dp))
                OutlinedTextField(
                    value = confirmPassword,
                    onValueChange = { confirmPassword = it },
                    label = { Text("确认密码") },
                    isError = confirmPassword.isNotEmpty() && confirmPassword != password,
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done),
                    modifier = Modifier.fillMaxWidth(),
                )
            }

            if (authStatus.isNotBlank()) {
                Spacer(Modifier.height(12.dp))
                Text(
                    authStatus,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (authStatus.contains("失败") || authStatus.contains("不正确")) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                )
            }
            Spacer(Modifier.height(16.dp))
            Button(
                onClick = {
                    if (mode == 0) repo.login(relayUrl, username, password)
                    else repo.claimInvite(inviteUrl, relayUrl, username, displayName, password)
                },
                enabled = !busy && username.isNotBlank() && password.length in 12..128 &&
                    (mode == 0 || (inviteUrl.isNotBlank() && displayName.isNotBlank() && confirmPassword == password)),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(if (mode == 0) "登录 Relay" else "创建账号并登录")
            }
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Composable
private fun SecurityPoint(text: String) {
    Row(Modifier.padding(vertical = 3.dp)) {
        Icon(
            Icons.Filled.Lock,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(14.dp),
        )
        Spacer(Modifier.width(8.dp))
        Text(text, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF0B0E13)
@Composable
private fun PairingScreenPreview() {
    AgentPocketTheme { PairingScreen(repo = MockPocketRepository, onPaired = {}) }
}
