package com.agentpocket.app

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.MethodChannel
import java.io.File
import java.nio.file.Files
import java.security.MessageDigest
import java.util.UUID

class PocketInstallChannels(private val activity: Activity, messenger: BinaryMessenger) {
    init {
        Thread { cleanupOldCache() }.start()
        MethodChannel(messenger, "agent_pocket/update").setMethodCallHandler { call, result ->
            if (call.method != "install") { result.notImplemented(); return@setMethodCallHandler }
            val path = call.argument<String>("path")
            val expectedHash = call.argument<String>("sha256")
            val size = call.argument<Number>("size")?.toLong()
            val version = call.argument<String>("version")
            val code = call.argument<Number>("versionCode")?.toLong()
            Thread {
                try {
                    val file = File(path ?: error("缺少文件"))
                    check(privateFile(file, "pocket-update-", "update.apk", 250L * 1024 * 1024))
                    check(size == file.length() && expectedHash?.matches(Regex("[a-f0-9]{64}")) == true)
                    val before = file.lastModified()
                    val digest = MessageDigest.getInstance("SHA-256")
                    file.inputStream().use { input ->
                        val buffer = ByteArray(192 * 1024); var countTotal = 0L
                        while (true) { val count = input.read(buffer); if (count < 0) break; countTotal += count; check(countTotal <= size!!); digest.update(buffer, 0, count) }
                    }
                    check(digest.digest().hex() == expectedHash && file.length() == size && file.lastModified() == before)
                    val flags = if (Build.VERSION.SDK_INT >= 28) PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
                    @Suppress("DEPRECATION") val archive = activity.packageManager.getPackageArchiveInfo(file.path, flags) ?: error("APK 无效")
                    @Suppress("DEPRECATION") val installed = activity.packageManager.getPackageInfo(activity.packageName, flags)
                    fun versionCode(info: PackageInfo): Long = if (Build.VERSION.SDK_INT >= 28) info.longVersionCode else @Suppress("DEPRECATION") info.versionCode.toLong()
                    check(archive.packageName == activity.packageName && versionCode(archive) == code && versionCode(archive) > versionCode(installed) && archive.versionName == version)
                    val current = signatures(installed); check(current.isNotEmpty() && signatures(archive) == current)
                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", file)
                    activity.runOnUiThread {
                        try {
                            if (!activity.packageManager.canRequestPackageInstalls()) {
                                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}"))); result.success(false)
                            } else {
                                activity.startActivity(Intent(Intent.ACTION_VIEW).setDataAndType(uri, "application/vnd.android.package-archive").addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)); result.success(true)
                            }
                        } catch (e: Exception) { result.error("INSTALL", "无法打开系统安装确认", null) }
                    }
                } catch (e: Exception) { activity.runOnUiThread { result.error("INSTALL_VERIFY", "安装包身份、版本、大小、摘要或签名校验失败", null) } }
            }.start()
        }
        MethodChannel(messenger, "agent_pocket/file_actions").setMethodCallHandler { call, result ->
            if (call.method !in setOf("share", "open")) { result.notImplemented(); return@setMethodCallHandler }
            val method = call.method
            val source = call.argument<String>("path")
            val name = call.argument<String>("name")?.replace(Regex("[\\\\/\\p{Cntrl}]"), "_")?.take(120)?.ifBlank { "文件" } ?: "文件"
            val mime = call.argument<String>("mimeType")?.takeIf { it.matches(Regex("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")) } ?: "application/octet-stream"
            Thread {
                try {
                    val file = File(source ?: error("缺少文件")); check(privateFile(file, "pocket-artifact-", "content.tmp", 32L * 1024 * 1024))
                    val root = File(activity.cacheDir, "pocket-shared"); check(root.isDirectory || root.mkdir()); check(!Files.isSymbolicLink(root.toPath()))
                    val dir = File(root, UUID.randomUUID().toString()); check(dir.mkdir())
                    val copy = File(dir, name)
                    file.inputStream().use { input -> copy.outputStream().use { output ->
                        val buffer = ByteArray(64 * 1024); var total = 0L
                        while (true) { val count = input.read(buffer); if (count < 0) break; total += count; check(total <= 32L * 1024 * 1024); output.write(buffer, 0, count) }
                        check(total == file.length()); output.fd.sync()
                    } }
                    val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.fileprovider", copy)
                    activity.runOnUiThread { try {
                        val intent = if (method == "share") Intent(Intent.ACTION_SEND).setType(mime).putExtra(Intent.EXTRA_STREAM, uri)
                            else Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime)
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                        intent.clipData = android.content.ClipData.newRawUri(name, uri)
                        activity.startActivity(Intent.createChooser(intent, if (method == "share") "分享文件" else "打开文件")); result.success(null)
                    } catch (e: Exception) { result.error("FILE_ACTION", "没有可处理此文件的应用", null) } }
                } catch (e: Exception) { activity.runOnUiThread { result.error("FILE_ACTION", "文件准备未完成", null) } }
            }.start()
        }
    }
    private fun privateFile(file: File, prefix: String, filename: String, max: Long): Boolean {
        val parent = file.parentFile ?: return false
        return file.name == filename && parent.name.startsWith(prefix) && !Files.isSymbolicLink(file.toPath()) && !Files.isSymbolicLink(parent.toPath()) &&
            file.isFile && file.length() in 0..max && file.canonicalFile.parentFile == parent.canonicalFile &&
            listOf(activity.cacheDir.canonicalFile, activity.codeCacheDir.canonicalFile).contains(parent.canonicalFile.parentFile)
    }
    @Suppress("DEPRECATION") private fun signatures(info: PackageInfo): Set<String> {
        val values = if (Build.VERSION.SDK_INT >= 28) info.signingInfo?.apkContentsSigners else info.signatures
        return values?.map { MessageDigest.getInstance("SHA-256").digest(it.toByteArray()).hex() }?.toSet() ?: emptySet()
    }
    private fun ByteArray.hex() = joinToString("") { "%02x".format(it.toInt() and 255) }
    private fun cleanupOldCache() {
        val before = System.currentTimeMillis() - 24L * 60 * 60 * 1000
        for (root in listOf(activity.cacheDir, activity.codeCacheDir)) {
            for (dir in root.listFiles().orEmpty()) {
                try {
                    if (!dir.isDirectory || Files.isSymbolicLink(dir.toPath()) || dir.canonicalFile.parentFile != root.canonicalFile) continue
                    if (dir.name.startsWith("pocket-update-") && dir.lastModified() < before) {
                        val apk = File(dir, "update.apk")
                        if (privateFile(apk, "pocket-update-", "update.apk", 250L * 1024 * 1024) && apk.lastModified() < before) { apk.delete(); dir.delete() }
                    } else if (dir.name == "pocket-shared") {
                        for (share in dir.listFiles().orEmpty()) {
                            if (!share.isDirectory || !share.name.matches(Regex("[a-f0-9-]{36}")) || share.lastModified() >= before || Files.isSymbolicLink(share.toPath()) || share.canonicalFile.parentFile != dir.canonicalFile) continue
                            val files = share.listFiles().orEmpty()
                            if (files.all { it.isFile && !Files.isSymbolicLink(it.toPath()) && it.canonicalFile.parentFile == share.canonicalFile && it.lastModified() < before }) {
                                files.forEach { it.delete() }; share.delete()
                            }
                        }
                    }
                } catch (_: Exception) { /* Preserve unexpected cache contents. */ }
            }
        }
    }
}
