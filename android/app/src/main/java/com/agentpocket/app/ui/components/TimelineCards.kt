package com.agentpocket.app.ui.components

import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.HelpOutline
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Route
import androidx.compose.material.icons.filled.Terminal
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.agentpocket.app.data.model.ApprovalDecision
import com.agentpocket.app.data.model.CommandStatus
import com.agentpocket.app.data.model.MessageStatus
import com.agentpocket.app.data.model.PlanStatus
import com.agentpocket.app.data.model.Role
import com.agentpocket.app.data.model.StepStatus
import com.agentpocket.app.data.model.TimelineItem
import com.agentpocket.app.ui.theme.StatusColors

/**
 * Renders one timeline item. Items are consumed from a keyed LazyColumn, so a
 * future 50 ms delta-coalescing layer only needs to swap list entries in place.
 */
@Composable
fun TimelineItemContent(
    item: TimelineItem,
    actionsEnabled: Boolean = true,
    onAnswerQuestion: (requestId: String, questionId: String, option: String) -> Unit,
    onResolveApproval: (requestId: String, decision: ApprovalDecision) -> Unit,
) {
    when (item) {
        is TimelineItem.Message -> MessageRow(item)
        is TimelineItem.Plan -> PlanCard(item)
        is TimelineItem.Command -> CommandCard(item)
        is TimelineItem.Question -> QuestionCard(item, actionsEnabled, onAnswerQuestion)
        is TimelineItem.Approval -> ApprovalCard(item, actionsEnabled, onResolveApproval)
    }
}

@Composable
private fun MessageRow(message: TimelineItem.Message) {
    when (message.role) {
        Role.User -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
            Surface(
                shape = RoundedCornerShape(14.dp, 14.dp, 4.dp, 14.dp),
                color = MaterialTheme.colorScheme.surfaceVariant,
                modifier = Modifier.widthIn(max = 300.dp),
            ) {
                Column(Modifier.padding(horizontal = 12.dp, vertical = 9.dp)) {
                    Text(message.text, style = MaterialTheme.typography.bodyMedium)
                    when (message.status) {
                        MessageStatus.Streaming -> Text(
                            "正在发送…",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                        MessageStatus.Failed -> Text(
                            "发送失败",
                            style = MaterialTheme.typography.labelSmall,
                            color = StatusColors.error,
                            modifier = Modifier.padding(top = 4.dp),
                        )
                        else -> Unit
                    }
                }
            }
        }

        Role.System -> Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Text(
                message.text,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 24.dp),
            )
        }

        Role.Assistant -> Column(Modifier.fillMaxWidth()) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    "Codex",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.primary,
                )
                if (message.status == MessageStatus.Streaming) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "正在生成…",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                if (message.status == MessageStatus.Interrupted) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "已中断",
                        style = MaterialTheme.typography.labelSmall,
                        color = StatusColors.attention,
                    )
                }
                if (message.status == MessageStatus.Failed) {
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "生成失败",
                        style = MaterialTheme.typography.labelSmall,
                        color = StatusColors.error,
                    )
                }
            }
            Spacer(Modifier.height(4.dp))
            Row {
                Text(
                    message.text,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.weight(1f, fill = false),
                )
                if (message.status == MessageStatus.Streaming) {
                    StreamingCursor()
                }
            }
        }
    }
}

@Composable
private fun StreamingCursor() {
    val transition = rememberInfiniteTransition(label = "cursor")
    val alpha by transition.animateFloat(
        initialValue = 0.15f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(650), RepeatMode.Reverse),
        label = "cursorAlpha",
    )
    Text("▍", color = MaterialTheme.colorScheme.primary.copy(alpha = alpha))
}

@Composable
private fun PlanCard(plan: TimelineItem.Plan) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.Route,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text("执行计划", style = MaterialTheme.typography.labelMedium)
                Spacer(Modifier.weight(1f))
                Text(
                    when (plan.status) {
                        PlanStatus.InProgress -> "进行中"
                        PlanStatus.Done -> "已完成"
                        PlanStatus.Abandoned -> "已放弃"
                    },
                    style = MaterialTheme.typography.labelSmall,
                    color = when (plan.status) {
                        PlanStatus.InProgress -> StatusColors.running
                        PlanStatus.Done -> StatusColors.completed
                        PlanStatus.Abandoned -> StatusColors.disconnected
                    },
                )
            }
            Spacer(Modifier.height(8.dp))
            plan.steps.forEach { step ->
                Row(
                    Modifier.padding(vertical = 3.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    when (step.status) {
                        StepStatus.Done -> Icon(
                            Icons.Filled.CheckCircle,
                            contentDescription = "完成",
                            tint = StatusColors.running,
                            modifier = Modifier.size(15.dp),
                        )

                        StepStatus.InProgress -> CircularProgressIndicator(
                            modifier = Modifier.size(13.dp),
                            strokeWidth = 2.dp,
                            color = StatusColors.attention,
                        )

                        StepStatus.Pending -> Icon(
                            Icons.Filled.RadioButtonUnchecked,
                            contentDescription = "待执行",
                            tint = MaterialTheme.colorScheme.outline,
                            modifier = Modifier.size(15.dp),
                        )
                    }
                    Spacer(Modifier.width(8.dp))
                    Text(
                        "${step.index}. ${step.text}",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (step.status == StepStatus.Pending) {
                            MaterialTheme.colorScheme.onSurfaceVariant
                        } else {
                            MaterialTheme.colorScheme.onSurface
                        },
                    )
                }
            }
        }
    }
}

@Composable
private fun CommandCard(command: TimelineItem.Command) {
    var expanded by rememberSaveable(command.id) { mutableStateOf(false) }
    val outputLabel = remember(command.output.length) {
        val chars = command.output.length
        when {
            chars >= 1024 * 1024 -> "%.1f MB".format(chars / (1024f * 1024f))
            chars >= 1024 -> "%.1f KB".format(chars / 1024f)
            else -> "$chars 字符"
        }
    }
    Card(
        onClick = { expanded = !expanded },
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface),
    ) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.Filled.Terminal,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.secondary,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    command.label,
                    style = MaterialTheme.typography.labelMedium,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.weight(1f),
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                val (label, color) = when (command.status) {
                    CommandStatus.Running -> "运行中" to StatusColors.running
                    CommandStatus.Succeeded -> "成功" to StatusColors.completed
                    CommandStatus.Failed -> "失败" to StatusColors.error
                }
                Text(label, style = MaterialTheme.typography.labelSmall, color = color)
                Spacer(Modifier.width(4.dp))
                Icon(
                    if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = if (expanded) "收起输出" else "展开输出",
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(18.dp),
                )
            }
            Text(
                command.cwd,
                style = MaterialTheme.typography.labelSmall,
                fontFamily = FontFamily.Monospace,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(vertical = 4.dp),
            )
            if (!expanded && command.output.isNotBlank()) {
                Text(
                    "$outputLabel 输出 · 点击展开",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.primary,
                )
            }
            if (expanded && command.output.isNotBlank()) {
                MonoBlock(text = command.output)
            }
            if (command.truncated) {
                Text(
                    "输出过长，已截断，仅显示末尾部分",
                    style = MaterialTheme.typography.labelSmall,
                    color = StatusColors.attention,
                    modifier = Modifier.padding(top = 6.dp),
                )
            }
        }
    }
}

@Composable
private fun QuestionCard(
    question: TimelineItem.Question,
    actionsEnabled: Boolean,
    onAnswer: (requestId: String, questionId: String, option: String) -> Unit,
) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(
                    Icons.AutoMirrored.Filled.HelpOutline,
                    contentDescription = null,
                    tint = StatusColors.attention,
                    modifier = Modifier.size(16.dp),
                )
                Spacer(Modifier.width(6.dp))
                Text(
                    "Codex 需要确认",
                    style = MaterialTheme.typography.labelMedium,
                    color = StatusColors.attention,
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(question.prompt, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            question.options.forEach { option ->
                val selected = question.selectedOption == option
                OutlinedButton(
                    onClick = { onAnswer(question.requestId, question.questionId, option) },
                    enabled = actionsEnabled && question.selectedOption == null,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(vertical = 2.dp),
                ) {
                    Text(
                        if (selected) "✓ $option" else option,
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
            if (!actionsEnabled && question.selectedOption == null) {
                Text("请在 Codex Desktop 中回答", style = MaterialTheme.typography.labelSmall, color = StatusColors.external)
            }
        }
    }
}

@Composable
private fun ApprovalCard(
    approval: TimelineItem.Approval,
    actionsEnabled: Boolean,
    onResolve: (requestId: String, decision: ApprovalDecision) -> Unit,
) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text("⚠", color = StatusColors.attention)
                Spacer(Modifier.width(6.dp))
                Text(
                    "需要你的审批",
                    style = MaterialTheme.typography.labelMedium,
                    color = StatusColors.attention,
                )
                Spacer(Modifier.weight(1f))
                Text(
                    approval.requestId,
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(6.dp))
            Text(approval.summary, style = MaterialTheme.typography.bodyMedium)
            Spacer(Modifier.height(8.dp))
            MonoBlock(text = "$ ${approval.command}\n${approval.cwd}")
            Spacer(Modifier.height(10.dp))
            if (approval.decision == null && actionsEnabled) {
                // Exactly three choices: allow once / deny / cancel. No permanent approval.
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Button(onClick = { onResolve(approval.requestId, ApprovalDecision.AllowOnce) }) {
                        Text("允许一次")
                    }
                    OutlinedButton(onClick = { onResolve(approval.requestId, ApprovalDecision.Deny) }) {
                        Text("拒绝")
                    }
                    TextButton(onClick = { onResolve(approval.requestId, ApprovalDecision.Cancel) }) {
                        Text("取消任务")
                    }
                }
            } else if (approval.decision != null) {
                val (label, color) = when (approval.decision) {
                    ApprovalDecision.AllowOnce -> "已允许一次" to StatusColors.running
                    ApprovalDecision.Deny -> "已拒绝" to StatusColors.error
                    ApprovalDecision.Cancel -> "已取消任务" to StatusColors.disconnected
                }
                Text(label, style = MaterialTheme.typography.labelMedium, color = color)
            } else {
                Text("请在 Codex Desktop 中处理审批", style = MaterialTheme.typography.labelSmall, color = StatusColors.external)
            }
        }
    }
}
