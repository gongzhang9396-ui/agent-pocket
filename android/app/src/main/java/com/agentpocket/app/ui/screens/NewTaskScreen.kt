package com.agentpocket.app.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
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
    val projects by repo.projects.collectAsState()
    val models by repo.models.collectAsState()
    val actionError by repo.actionError.collectAsState()
    val creating by repo.creatingTask.collectAsState()
    var projectId by rememberSaveable { mutableStateOf("") }
    var modelId by rememberSaveable { mutableStateOf("") }
    var reasoningId by rememberSaveable { mutableStateOf("") }
    var prompt by rememberSaveable { mutableStateOf("") }

    LaunchedEffect(Unit) { repo.clearActionError() }
    LaunchedEffect(projects) { if (projects.none { it.id == projectId }) projectId = projects.firstOrNull()?.id.orEmpty() }
    LaunchedEffect(models) { if (models.none { it.id == modelId }) modelId = models.firstOrNull()?.id.orEmpty() }
    val model = models.firstOrNull { it.id == modelId }
    // 推理选项跟随所选模型动态变化；切换模型后回落到该模型的第一个档位。
    val reasoning = model?.reasoningOptions?.firstOrNull { it.id == reasoningId }
        ?: model?.reasoningOptions?.firstOrNull()

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
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(horizontal = 16.dp, vertical = 8.dp),
        ) {
            SectionLabel("项目")
            Spacer(Modifier.height(6.dp))
            projects.forEach { project ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    RadioButton(selected = projectId == project.id, onClick = { projectId = project.id })
                    Column {
                        Text(project.name, style = MaterialTheme.typography.bodyMedium)
                        Text(
                            project.cwd,
                            style = MaterialTheme.typography.labelSmall,
                            fontFamily = FontFamily.Monospace,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
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
                    .heightIn(min = 140.dp),
                textStyle = MaterialTheme.typography.bodyMedium,
            )

            Spacer(Modifier.height(20.dp))
            if (!actionError.isNullOrBlank()) {
                Text(
                    actionError.orEmpty(),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier.padding(bottom = 10.dp),
                )
            }
            Button(
                onClick = { repo.createTask(projectId, modelId, reasoning?.id.orEmpty(), prompt, onCreated) },
                enabled = !creating && prompt.isNotBlank() && projectId.isNotBlank() && modelId.isNotBlank() && reasoning != null,
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
