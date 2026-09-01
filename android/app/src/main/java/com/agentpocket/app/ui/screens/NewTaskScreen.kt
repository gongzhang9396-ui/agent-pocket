package com.agentpocket.app.ui.screens

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.data.model.ConnectionState
import com.agentpocket.app.ui.components.SectionLabel
import com.agentpocket.app.ui.theme.AgentPocketTheme

/** 新建 Codex 任务：项目、动态模型/推理强度选择、提示词与创建动作。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewTaskScreen(
    repo: PocketRepository,
    onBack: () -> Unit,
    onCreated: (threadId: String) -> Unit,
) {
    val hosts by repo.hosts.collectAsState()
    val selectedHostId by repo.selectedHostId.collectAsState()
    val projects by repo.projects.collectAsState()
    val projectsLoading by repo.projectsLoading.collectAsState()
    val projectsError by repo.projectsError.collectAsState()
    val models by repo.models.collectAsState()
    val actionError by repo.actionError.collectAsState()
    val creating by repo.creatingTask.collectAsState()
    var hostMenuExpanded by remember { mutableStateOf(false) }
    var projectId by rememberSaveable { mutableStateOf("") }
    var projectMenuExpanded by remember { mutableStateOf(false) }
    var modelId by rememberSaveable { mutableStateOf("") }
    var reasoningId by rememberSaveable { mutableStateOf("") }
    var target by rememberSaveable { mutableStateOf(repo.lastTaskTarget()) }
    var prompt by rememberSaveable { mutableStateOf("") }
    var promptFocused by remember { mutableStateOf(false) }
    val focusManager = LocalFocusManager.current

    LaunchedEffect(Unit) {
        repo.clearActionError()
    }
    LaunchedEffect(hosts, selectedHostId) {
        val selectedOnline = hosts.any { it.id == selectedHostId && it.connectionState == ConnectionState.Connected }
        if (!selectedOnline) hosts.firstOrNull { it.connectionState == ConnectionState.Connected }?.let { repo.selectHost(it.id) }
    }
    LaunchedEffect(selectedHostId) {
        projectId = ""
        modelId = ""
        reasoningId = ""
        if (selectedHostId != null) repo.refreshProjects()
    }
    LaunchedEffect(projects) { if (projects.none { it.id == projectId }) projectId = projects.firstOrNull()?.id.orEmpty() }
    LaunchedEffect(models) { if (models.none { it.id == modelId }) modelId = models.firstOrNull()?.id.orEmpty() }
    val model = models.firstOrNull { it.id == modelId }
    val selectedHost = hosts.firstOrNull { it.id == selectedHostId }
    val selectedProject = projects.firstOrNull { it.id == projectId }
    // 推理选项跟随所选模型动态变化；切换模型后回落到该模型的第一个档位。
    val reasoning = model?.reasoningOptions?.firstOrNull { it.id == reasoningId }
        ?: model?.reasoningOptions?.firstOrNull()
    val canCreate = !creating && selectedHost?.connectionState == ConnectionState.Connected &&
        prompt.isNotBlank() && projectId.isNotBlank() && modelId.isNotBlank() && reasoning != null
    val submit = {
        if (canCreate) {
            focusManager.clearFocus()
            repo.createTask(projectId, modelId, reasoning?.id.orEmpty(), prompt, target, onCreated)
        }
    }

    BackHandler(enabled = promptFocused) {
        focusManager.clearFocus()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("新建 Codex 任务") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "返回")
                    }
                },
            )
        },
        bottomBar = {
            Surface(
                color = MaterialTheme.colorScheme.surface,
                tonalElevation = 2.dp,
                modifier = Modifier
                    .fillMaxWidth()
                    .navigationBarsPadding()
                    .imePadding(),
            ) {
                Column(modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)) {
                    if (!actionError.isNullOrBlank()) {
                        Text(
                            actionError.orEmpty(),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.error,
                            modifier = Modifier.padding(bottom = 10.dp),
                        )
                    }
                    Button(
                        onClick = submit,
                        enabled = canCreate,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        if (creating) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(18.dp),
                                strokeWidth = 2.dp,
                                color = MaterialTheme.colorScheme.onPrimary,
                            )
                            Spacer(Modifier.size(8.dp))
                            Text("正在创建…")
                        } else {
                            Text("创建任务")
                        }
                    }
                }
            }
        },
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            SectionLabel("电脑")
            Spacer(Modifier.height(6.dp))
            Box(modifier = Modifier.fillMaxWidth()) {
                OutlinedButton(
                    onClick = { hostMenuExpanded = true },
                    enabled = hosts.isNotEmpty(),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(modifier = Modifier.weight(1f), horizontalAlignment = Alignment.Start) {
                        Text(selectedHost?.name ?: "选择一台在线电脑")
                        Text(
                            when {
                                selectedHost == null -> "还没有可用的 Windows Host"
                                selectedHost.connectionState == ConnectionState.Connected -> "在线"
                                else -> "离线，无法创建任务"
                            },
                            style = MaterialTheme.typography.labelSmall,
                            color = if (selectedHost?.connectionState == ConnectionState.Connected) {
                                MaterialTheme.colorScheme.primary
                            } else {
                                MaterialTheme.colorScheme.onSurfaceVariant
                            },
                        )
                    }
                    Icon(Icons.Default.ArrowDropDown, contentDescription = "展开电脑列表")
                }
                DropdownMenu(
                    expanded = hostMenuExpanded,
                    onDismissRequest = { hostMenuExpanded = false },
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    hosts.forEach { item ->
                        DropdownMenuItem(
                            text = {
                                Column {
                                    Text(item.name)
                                    Text(
                                        if (item.connectionState == ConnectionState.Connected) "在线" else "离线",
                                        style = MaterialTheme.typography.labelSmall,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            },
                            enabled = item.connectionState == ConnectionState.Connected,
                            onClick = {
                                repo.selectHost(item.id)
                                hostMenuExpanded = false
                            },
                        )
                    }
                }
            }

            Spacer(Modifier.height(16.dp))
            SectionLabel("运行方式")
            Spacer(Modifier.height(6.dp))
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                FilterChip(
                    selected = target == "bridge",
                    onClick = { target = "bridge" },
                    label = { Text("Bridge · 手机完整控制") },
                )
                FilterChip(
                    selected = target == "desktop",
                    onClick = { target = "desktop" },
                    label = { Text("Codex Desktop") },
                )
            }
            Spacer(Modifier.height(4.dp))
            Text(
                if (target == "bridge") {
                    "由这台电脑的 codex app-server 执行，兼容第三方模型通道；支持从手机审批、回答提问和中断。任务同样出现在 Codex Desktop 列表中，可在电脑上查看，但请不要在电脑端续写它。"
                } else {
                    "创建真实 Codex Desktop 任务，可在电脑上继续操作。注意：第三方 HTTP 模型通道（如 cc-switch 中转）暂不支持新建，需要官方 WebSocket v2 通道。"
                },
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(16.dp))
            SectionLabel("项目")
            Spacer(Modifier.height(6.dp))
            when {
                projectsLoading && projects.isEmpty() -> {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp),
                    ) {
                        CircularProgressIndicator(modifier = Modifier.size(18.dp), strokeWidth = 2.dp)
                        Text("正在读取 Codex Desktop 项目…", color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                projects.isEmpty() -> {
                    Text(
                        projectsError ?: "Codex Desktop 中没有可用的本地项目。请先在电脑端保存项目，然后重新加载。",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (projectsError == null) MaterialTheme.colorScheme.onSurfaceVariant else MaterialTheme.colorScheme.error,
                    )
                    TextButton(onClick = repo::refreshProjects, enabled = !projectsLoading) {
                        Icon(Icons.Default.Refresh, contentDescription = null)
                        Spacer(Modifier.size(6.dp))
                        Text("重新加载项目")
                    }
                }
                else -> {
                    Box(modifier = Modifier.fillMaxWidth()) {
                        OutlinedButton(
                            onClick = { projectMenuExpanded = true },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            Column(
                                modifier = Modifier.weight(1f),
                                horizontalAlignment = Alignment.Start,
                            ) {
                                Text(selectedProject?.name ?: "选择项目", style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    selectedProject?.cwd.orEmpty(),
                                    maxLines = 1,
                                    overflow = TextOverflow.Ellipsis,
                                    style = MaterialTheme.typography.labelSmall,
                                    fontFamily = FontFamily.Monospace,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Icon(Icons.Default.ArrowDropDown, contentDescription = "展开项目列表")
                        }
                        DropdownMenu(
                            expanded = projectMenuExpanded,
                            onDismissRequest = { projectMenuExpanded = false },
                            modifier = Modifier.fillMaxWidth(),
                        ) {
                            projects.forEach { project ->
                                DropdownMenuItem(
                                    text = {
                                        Column {
                                            Text(project.name, style = MaterialTheme.typography.bodyMedium)
                                            Text(
                                                project.cwd,
                                                maxLines = 1,
                                                overflow = TextOverflow.Ellipsis,
                                                style = MaterialTheme.typography.labelSmall,
                                                fontFamily = FontFamily.Monospace,
                                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                            )
                                        }
                                    },
                                    onClick = {
                                        projectId = project.id
                                        projectMenuExpanded = false
                                    },
                                )
                            }
                        }
                    }
                    TextButton(onClick = repo::refreshProjects, enabled = !projectsLoading) {
                        if (projectsLoading) {
                            CircularProgressIndicator(modifier = Modifier.size(16.dp), strokeWidth = 2.dp)
                        } else {
                            Icon(Icons.Default.Refresh, contentDescription = null)
                        }
                        Spacer(Modifier.size(6.dp))
                        Text(if (projectsLoading) "正在刷新…" else "刷新项目")
                    }
                }
            }

            Spacer(Modifier.height(16.dp))
            SectionLabel("模型")
            Spacer(Modifier.height(6.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            ) {
                models.forEach { option ->
                    FilterChip(
                        selected = modelId == option.id,
                        onClick = { modelId = option.id },
                        label = { Text(option.label) },
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(
                model?.description ?: "正在从 Codex 读取可用模型…",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(16.dp))
            SectionLabel("推理强度")
            Spacer(Modifier.height(6.dp))
            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                modifier = Modifier.horizontalScroll(rememberScrollState()),
            ) {
                model?.reasoningOptions?.forEach { option ->
                    FilterChip(
                        selected = reasoning?.id == option.id,
                        onClick = { reasoningId = option.id },
                        label = { Text(option.label) },
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Text(
                reasoning?.description ?: "",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            Spacer(Modifier.height(16.dp))
            SectionLabel("任务描述")
            Spacer(Modifier.height(6.dp))
            OutlinedTextField(
                value = prompt,
                onValueChange = { prompt = it },
                placeholder = { Text("描述你要 Codex 完成的任务，例如：为订单模块补充退款路径的集成测试…") },
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 140.dp)
                    .onFocusChanged { promptFocused = it.isFocused },
                textStyle = MaterialTheme.typography.bodyMedium,
            )
            Spacer(Modifier.height(24.dp))
        }
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF0B0E13)
@Composable
private fun NewTaskScreenPreview() {
    AgentPocketTheme {
        NewTaskScreen(repo = MockPocketRepository, onBack = {}, onCreated = {})
    }
}
