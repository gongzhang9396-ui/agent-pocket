package com.agentpocket.app

import android.app.Activity
import android.content.Intent
import android.provider.OpenableColumns
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

/** Platform document picker only. Transfer, hashing verification and retries
 * remain in Dart; never reads a provider URI beyond the bounded copy. */
class PocketFileChannels(private val activity: Activity, messenger: BinaryMessenger) {
    private val channel = MethodChannel(messenger, "agent_pocket/files")
    private var pending: MethodChannel.Result? = null
    private var closed = false
    private val requestCode = 49262
    private val root get() = File(activity.filesDir, "pocket-uploads")

    init {
        channel.setMethodCallHandler { call, result ->
            when (call.method) {
                "pick" -> {
                    if (pending != null) { result.error("PICK_BUSY", "文件选择正在进行", null); return@setMethodCallHandler }
                    pending = result
                    try {
                        activity.startActivityForResult(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE); type = "*/*"
                            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
                        }, requestCode)
                    } catch (e: Exception) { pending = null; result.error("PICK_FAILED", "无法选择文件", null) }
                }
                "remove" -> {
                    try {
                        val file = File(call.argument<String>("path") ?: error("缺少文件"))
                        check(valid(file)); check(file.delete()); check(file.parentFile!!.delete()); result.success(null)
                    } catch (e: Exception) { result.error("FILE_REMOVE", "无法移除所选文件", null) }
                }
                else -> result.notImplemented()
            }
        }
    }
    private fun valid(file: File): Boolean {
        val parent = file.parentFile ?: return false
        return parent.name.matches(Regex("[a-f0-9-]{36}")) && file.name == "content.tmp" &&
            !Files.isSymbolicLink(file.toPath()) && !Files.isSymbolicLink(parent.toPath()) &&
            parent.canonicalFile.parentFile == root.canonicalFile && file.canonicalFile.parentFile == parent.canonicalFile
    }
    fun onActivityResult(code: Int, resultCode: Int, data: Intent?): Boolean {
        if (code != requestCode) return false
        val result = pending ?: return true
        pending = null
        if (resultCode != Activity.RESULT_OK || data == null) { result.success(emptyList<Any>()); return true }
        val uris = (data.clipData?.let { clip -> (0 until clip.itemCount).map { clip.getItemAt(it).uri } } ?: listOfNotNull(data.data)).distinct()
        if (uris.size > 3 || uris.any { it.scheme != "content" }) { result.error("FILE_LIMIT", "每次最多选择 3 个文件", null); return true }
        Thread {
            val created = mutableListOf<File>()
            try {
                check(root.isDirectory || root.mkdir()); check(!Files.isSymbolicLink(root.toPath()))
                val items = uris.map { uri ->
                    val info = activity.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
                        check(cursor.moveToFirst())
                        Pair(cursor.getString(0), if (cursor.isNull(1)) -1L else cursor.getLong(1))
                    } ?: error("文件信息不可用")
                    check(info.second <= 20L * 1024 * 1024)
                    val name = (info.first ?: "文件").replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(160)
                    val mime = activity.contentResolver.getType(uri) ?: "application/octet-stream"
                    val directory = File(root, UUID.randomUUID().toString()); check(directory.mkdir())
                    val file = File(directory, "content.tmp"); created.add(file)
                    val digest = MessageDigest.getInstance("SHA-256")
                    var length = 0L
                    (activity.contentResolver.openInputStream(uri) ?: error("文件不可读取")).use { input ->
                        file.outputStream().use { output ->
                            val buffer = ByteArray(64 * 1024)
                            while (true) {
                                val count = input.read(buffer); if (count < 0) break
                                length += count; check(length <= 20L * 1024 * 1024)
                                digest.update(buffer, 0, count); output.write(buffer, 0, count)
                            }
                            output.fd.sync()
                        }
                    }
                    check(length > 0 && (info.second < 0 || length == info.second))
                    mapOf("path" to file.absolutePath, "filename" to name, "mimeType" to mime, "size" to length,
                        "sha256" to digest.digest().joinToString("") { "%02x".format(it.toInt() and 255) })
                }
                activity.runOnUiThread {
                    if (closed) { created.forEach { if (valid(it)) { it.delete(); it.parentFile?.delete() } }; result.error("PICK_CANCELLED", "文件选择已关闭", null) }
                    else result.success(items)
                }
            } catch (e: Exception) {
                created.forEach { if (valid(it)) { it.delete(); it.parentFile?.delete() } }
                activity.runOnUiThread { result.error(if (closed) "PICK_CANCELLED" else "FILE_PICK", "读取未完成：仅支持单个 20 MiB 以内且内容稳定的文件", null) }
            }
        }.start()
        return true
    }
    fun close() { closed = true; pending?.error("PICK_CANCELLED", "文件选择已关闭", null); pending = null }
}
