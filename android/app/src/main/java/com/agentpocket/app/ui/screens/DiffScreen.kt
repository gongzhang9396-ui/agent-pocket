package com.agentpocket.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
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
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.agentpocket.app.data.MockPocketRepository
import com.agentpocket.app.data.PocketRepository
import com.agentpocket.app.data.model.DiffFile
import com.agentpocket.app.data.model.DiffFileStatus
import com.agentpocket.app.data.model.DiffLine
import com.agentpocket.app.data.model.DiffLineKind
import com.agentpocket.app.ui.theme.AgentPocketTheme
import com.agentpocket.app.ui.theme.StatusColors

/** 代码变更：按文件分组，等宽字体，增删计数与截断状态。 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DiffScreen(
    repo: PocketRepository,
    threadId: String,
    onBack: () -> Unit,
) {
    val files by repo.threadDiff(threadId).collectAsState()
    val totalAdd = files.sumOf { it.additions }
    val totalDel = files.sumOf { it.deletions }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("代码变更") },
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
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 10.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(key = "summary", contentType = "summary") {
                Row {
                    Text(
                        "${files.size} 个文件 · ",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text("+$totalAdd", style = MaterialTheme.typography.labelMedium, color = StatusColors.diffAddFg)
                    Text("  ")
                    Text("−$totalDel", style = MaterialTheme.typography.labelMedium, color = StatusColors.diffDelFg)
                }
            }
            items(files, key = { it.path }, contentType = { "file" }) { file ->
                DiffFileCard(file)
            }
        }
    }
}

@Composable
private fun DiffFileCard(file: DiffFile) {
    Card(colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surface)) {
        Column(Modifier.padding(12.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                val (tag, tagColor) = when (file.status) {
                    DiffFileStatus.Added -> "新增" to StatusColors.diffAddFg
                    DiffFileStatus.Modified -> "修改" to StatusColors.completed
                    DiffFileStatus.Deleted -> "删除" to StatusColors.diffDelFg
                    DiffFileStatus.Renamed -> "重命名" to StatusColors.attention
                }
                Text(
                    tag,
                    style = MaterialTheme.typography.labelSmall,
                    color = tagColor,
                    modifier = Modifier
                        .clip(RoundedCornerShape(4.dp))
                        .background(tagColor.copy(alpha = 0.12f))
                        .padding(horizontal = 6.dp, vertical = 2.dp),
                )
                Spacer(Modifier.width(8.dp))
                Text(
                    file.path,
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    modifier = Modifier.weight(1f),
                )
                Text(
                    "+${file.additions} −${file.deletions}",
                    style = MaterialTheme.typography.labelSmall,
                    fontFamily = FontFamily.Monospace,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
            Spacer(Modifier.height(8.dp))
            file.hunks.forEach { hunk ->
                Text(
                    hunk.header,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(vertical = 4.dp),
                )
                Column(
                    Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(8.dp))
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                        .horizontalScroll(rememberScrollState()),
                ) {
                    hunk.lines.forEach { line -> DiffLineRow(line) }
                }
            }
            if (file.truncated) {
                Text(
                    "该文件差异过大，已截断显示",
                    style = MaterialTheme.typography.labelSmall,
                    color = StatusColors.attention,
                    modifier = Modifier.padding(top = 8.dp),
                )
            }
        }
    }
}

@Composable
private fun DiffLineRow(line: DiffLine) {
    val (prefix, fg, bg) = when (line.kind) {
        DiffLineKind.Add -> Triple("+", StatusColors.diffAddFg, StatusColors.diffAddBg)
        DiffLineKind.Delete -> Triple("−", StatusColors.diffDelFg, StatusColors.diffDelBg)
        DiffLineKind.Context -> Triple(" ", MaterialTheme.colorScheme.onSurfaceVariant, null)
    }
    Row(
        modifier = Modifier.then(
            if (bg != null) Modifier.background(bg) else Modifier,
        ),
    ) {
        Text(
            prefix,
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            lineHeight = 16.sp,
            color = fg,
            modifier = Modifier.padding(start = 8.dp),
        )
        Text(
            line.text.ifEmpty { " " },
            fontFamily = FontFamily.Monospace,
            fontSize = 11.sp,
            lineHeight = 16.sp,
            color = fg,
            softWrap = false,
            modifier = Modifier.padding(start = 4.dp, end = 12.dp),
        )
    }
}

@Preview(showBackground = true, backgroundColor = 0xFF0B0E13)
@Composable
private fun DiffScreenPreview() {
    AgentPocketTheme {
        DiffScreen(repo = MockPocketRepository, threadId = "t-theme-flicker", onBack = {})
    }
}
