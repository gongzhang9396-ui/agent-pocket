package com.agentpocket.app.ui.components

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

@Composable
fun rememberImagePicker(onPicked: (List<Uri>) -> Unit): () -> Unit {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.GetMultipleContents()) { uris ->
        if (uris.isNotEmpty()) onPicked(uris.take(3))
    }
    return { launcher.launch("image/*") }
}

@Composable
fun rememberFilePicker(onPicked: (List<Uri>) -> Unit): () -> Unit {
    val launcher = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { uris ->
        if (uris.isNotEmpty()) onPicked(uris.take(3))
    }
    return { launcher.launch(arrayOf("*/*")) }
}

@Composable
fun PendingAttachmentStrip(uris: List<Uri>, onRemove: (Uri) -> Unit, modifier: Modifier = Modifier) {
    if (uris.isEmpty()) return
    Row(modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        uris.forEach { uri -> AttachmentThumb(uri, onRemove = { onRemove(uri) }) }
    }
}

@Composable
fun PendingFileList(uris: List<Uri>, onRemove: (Uri) -> Unit, modifier: Modifier = Modifier) {
    if (uris.isEmpty()) return
    Column(modifier = modifier, verticalArrangement = Arrangement.spacedBy(6.dp)) {
        uris.forEach { uri -> PendingFileCard(uri, onRemove = { onRemove(uri) }) }
    }
}

@Composable
private fun AttachmentThumb(uri: Uri, onRemove: () -> Unit) {
    val context = LocalContext.current
    val bitmap by produceState<ImageBitmap?>(initialValue = null, uri) {
        value = withContext(Dispatchers.IO) { decodeThumbnail(context, uri) }
    }
    Box {
        Box(
            Modifier
                .size(56.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(MaterialTheme.colorScheme.surfaceVariant),
        ) {
            bitmap?.let {
                Image(it, contentDescription = "待发送图片", contentScale = ContentScale.Crop, modifier = Modifier.size(56.dp))
            }
        }
        IconButton(
            onClick = onRemove,
            modifier = Modifier.align(Alignment.TopEnd).padding(2.dp).size(20.dp),
            colors = IconButtonDefaults.iconButtonColors(
                containerColor = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
                contentColor = MaterialTheme.colorScheme.onSurface,
            ),
        ) {
            Icon(Icons.Filled.Close, contentDescription = "移除图片", modifier = Modifier.size(12.dp))
        }
    }
}

@Composable
private fun PendingFileCard(uri: Uri, onRemove: () -> Unit) {
    val context = LocalContext.current
    val info by produceState(initialValue = FileDisplayInfo("所选文件", null), uri) {
        value = withContext(Dispatchers.IO) { readFileDisplayInfo(context, uri) }
    }
    Surface(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(10.dp),
        color = MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.55f),
    ) {
        Row(
            modifier = Modifier.padding(start = 10.dp, end = 4.dp, top = 7.dp, bottom = 7.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.AttachFile,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary,
                modifier = Modifier.size(20.dp),
            )
            Column(modifier = Modifier.padding(horizontal = 8.dp).weight(1f)) {
                Text(info.name, style = MaterialTheme.typography.bodySmall, maxLines = 1)
                info.size?.let {
                    Text(
                        formatFileSize(it),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            IconButton(onClick = onRemove, modifier = Modifier.size(36.dp)) {
                Icon(Icons.Filled.Close, contentDescription = "移除文件", modifier = Modifier.size(18.dp))
            }
        }
    }
}

private data class FileDisplayInfo(val name: String, val size: Long?)

private fun readFileDisplayInfo(context: Context, uri: Uri): FileDisplayInfo = runCatching {
    context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
        if (cursor.moveToFirst()) {
            val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
            val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
            val name = if (nameIndex >= 0) cursor.getString(nameIndex) else null
            val size = if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) cursor.getLong(sizeIndex) else null
            FileDisplayInfo(name?.take(160)?.ifBlank { "所选文件" } ?: "所选文件", size)
        } else FileDisplayInfo("所选文件", null)
    } ?: FileDisplayInfo(uri.lastPathSegment?.takeLast(160) ?: "所选文件", null)
}.getOrElse { FileDisplayInfo(uri.lastPathSegment?.takeLast(160) ?: "所选文件", null) }

private fun formatFileSize(bytes: Long): String = when {
    bytes >= 1024 * 1024 -> "%.1f MB".format(bytes / (1024.0 * 1024.0))
    bytes >= 1024 -> "%.0f KB".format(bytes / 1024.0)
    else -> "$bytes B"
}

private fun decodeThumbnail(context: Context, uri: Uri): ImageBitmap? = runCatching {
    val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
    if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null
    var sample = 1
    while (bounds.outWidth / (sample * 2) >= 160 && bounds.outHeight / (sample * 2) >= 160) sample *= 2
    context.contentResolver.openInputStream(uri)
        ?.use { BitmapFactory.decodeStream(it, null, BitmapFactory.Options().apply { inSampleSize = sample }) }
        ?.asImageBitmap()
}.getOrNull()
