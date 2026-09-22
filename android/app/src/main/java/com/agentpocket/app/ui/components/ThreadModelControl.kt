package com.agentpocket.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.Tune
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.data.reasoningLabel
import com.agentpocket.app.data.model.ThreadModelOptions
import kotlinx.coroutines.CancellationException

/** Thread-keyed caller owns the pending choice; opening this sheet is read-only. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ThreadModelControl(
    repo: PocketRepository,
    threadId: String,
    running: Boolean,
    busy: Boolean,
    readOnly: Boolean,
    desktopOwned: Boolean,
    modelId: String?,
    reasoningId: String?,
    onChange: (String?, String?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    var options by remember { mutableStateOf<ThreadModelOptions?>(null) }
    var loading by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var retry by remember { mutableIntStateOf(0) }
    val keyboard = LocalSoftwareKeyboardController.current
    val selected = options?.models?.firstOrNull { it.id == modelId }
    val label = selected?.label ?: modelId ?: "沿用会话"
    val canChange = options?.canControl == true && !running && !busy && !readOnly && !loading && error == null
    val explanation = when {
        running -> "正在回复中。请等本轮结束后再切换；已选设置会保留。"
        readOnly -> "当前任务暂不可发送，恢复连接后可以切换模型。"
        options?.reason != null -> options?.reason
        options?.controlScope == "desktop" -> "随下次发送应用到这条 Codex Desktop 任务，并保留原任务上下文。"
        options?.controlScope == "shared" -> "随下次发送应用到这条 Grok 共享会话，电脑端也会沿用。"
        desktopOwned -> "当前 Desktop Attach 暂不支持从手机切换模型和推理档位。"
        else -> "随下次发送生效，保留原任务的上下文。"
    }

    LaunchedEffect(open, retry, running) {
        if (!open) return@LaunchedEffect
        loading = true
        error = null
        try { options = repo.threadModelOptions(threadId) }
        catch (cancelled: CancellationException) { throw cancelled }
        catch (failure: Throwable) { error = failure.message ?: "模型列表读取失败，请重试。" }
        finally { loading = false }
    }

    Row(Modifier.fillMaxWidth().padding(horizontal = 8.dp), verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = { keyboard?.hide(); open = true }, modifier = Modifier.weight(1f)) {
            Icon(Icons.Filled.Tune, contentDescription = null, modifier = Modifier.size(16.dp))
            Spacer(Modifier.width(6.dp))
            Text("模型 · $label" + (reasoningId?.let { " · ${reasoningLabel(it)}" } ?: ""), maxLines = 1, overflow = TextOverflow.Ellipsis)
            Icon(Icons.Filled.KeyboardArrowDown, contentDescription = "模型与推理设置", modifier = Modifier.size(18.dp))
        }
        if (modelId != null) Text("下次发送", style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(end = 8.dp))
    }

    if (open) ModalBottomSheet(onDismissRequest = { open = false }) {
        LazyColumn(Modifier.fillMaxWidth().fillMaxHeight(0.85f).navigationBarsPadding(), contentPadding = PaddingValues(bottom = 20.dp)) {
            item {
                Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalAlignment = Alignment.CenterVertically) {
                    Text("模型与推理", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                    TextButton(onClick = { open = false }) { Text("完成") }
                }
                Text(explanation.orEmpty(), style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                options?.let { value ->
                    val current = value.models.firstOrNull { it.id == value.currentModelId }?.label ?: value.currentModelId
                    Text(if (current == null) "当前设置由会话保留" else "当前：$current" + (value.currentReasoningId?.let { " · 推理${reasoningLabel(it)}" } ?: ""),
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 4.dp))
                }
                if (loading) LinearProgressIndicator(Modifier.fillMaxWidth().padding(20.dp))
                if (error != null) {
                    Text(error.orEmpty(), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                    TextButton(onClick = { retry++ }, modifier = Modifier.padding(horizontal = 12.dp)) { Text("重新读取模型") }
                }
                options?.warning?.let { Text(it, style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(20.dp)) }
                ListItem(
                    headlineContent = { Text("沿用会话设置") },
                    supportingContent = { Text("跟随这条任务已有的模型与推理档位") },
                    leadingContent = { RadioButton(selected = modelId == null, onClick = null) },
                    modifier = Modifier.clickable(enabled = !busy) { onChange(null, null) },
                    colors = ListItemDefaults.colors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                )
                if (selected != null) {
                    Text("推理强度", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(start = 20.dp, top = 16.dp))
                    if (selected.reasoningOptions.isEmpty()) {
                        Text("这个模型未提供可选推理档位", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp))
                    } else {
                        Row(Modifier.horizontalScroll(rememberScrollState()).padding(horizontal = 20.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            selected.reasoningOptions.forEach { option ->
                                FilterChip(selected = reasoningId == option.id, enabled = canChange,
                                    onClick = { onChange(selected.id, option.id) }, label = { Text(option.label) })
                            }
                        }
                    }
                }
                Text("选择模型", style = MaterialTheme.typography.titleSmall, modifier = Modifier.padding(horizontal = 20.dp, vertical = 12.dp))
                if (!loading && error == null && options?.models.isNullOrEmpty() && options?.canControl == true) {
                    Text("电脑没有返回可选模型，请检查模型配置后重试。", style = MaterialTheme.typography.bodySmall, modifier = Modifier.padding(horizontal = 20.dp))
                    TextButton(onClick = { retry++ }, modifier = Modifier.padding(horizontal = 12.dp)) { Text("重新读取模型") }
                }
            }
            items(options?.models.orEmpty(), key = { it.id }) { option ->
                ListItem(
                    headlineContent = { Text(option.label) },
                    supportingContent = { Text(option.description.ifBlank { option.id }, maxLines = 2, overflow = TextOverflow.Ellipsis) },
                    leadingContent = { RadioButton(selected = modelId == option.id, enabled = canChange, onClick = null) },
                    modifier = Modifier.clickable(enabled = canChange) {
                        val effort = if (modelId == option.id) reasoningId else if (option.id == options?.currentModelId)
                            options?.currentReasoningId?.takeIf { id -> option.reasoningOptions.any { it.id == id } } else null
                        onChange(option.id, effort ?: option.defaultReasoningId ?: option.reasoningOptions.firstOrNull()?.id)
                    },
                    colors = ListItemDefaults.colors(containerColor = if (modelId == option.id) MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.35f) else MaterialTheme.colorScheme.surfaceContainerLow),
                )
            }
        }
    }
}
