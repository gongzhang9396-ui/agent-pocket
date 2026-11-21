package com.agentpocket.app

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import io.flutter.plugin.common.StandardMethodCodec
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.app.Activity
import android.content.Intent
import java.io.File
import java.io.FileInputStream
import java.nio.file.Files
import android.system.Os
import android.system.OsConstants
import android.content.Context
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.os.Build
import io.flutter.embedding.engine.dart.DartExecutor

class MainActivity : FlutterActivity() {
    private var initialLinkConsumed = false
    private var reusedEngine = false
    override fun provideFlutterEngine(context: Context): FlutterEngine = (application as PocketApplication).engine().also { reusedEngine = it.dartExecutor.isExecutingDart }
    override fun shouldDestroyEngineWithHost(): Boolean = false
    private data class PendingSave(val file: File, val result: MethodChannel.Result)
    private var pendingSave: PendingSave? = null
    private val saveRequestCode = 49261
    private var files: PocketFileChannels? = null

    private fun isPrivateTemporary(file: File): Boolean {
        val parent = file.parentFile ?: return false
        if (file.name != "content.tmp" || !parent.name.startsWith("pocket-artifact-") ||
            Files.isSymbolicLink(file.toPath()) || Files.isSymbolicLink(parent.toPath()) || !file.isFile) return false
        val allowedRoots = listOf(cacheDir.canonicalFile, codeCacheDir.canonicalFile)
        return allowedRoots.any { root -> parent.canonicalFile.parentFile == root && file.canonicalFile.parentFile == parent.canonicalFile } &&
            file.length() <= 32L * 1024 * 1024
    }

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        val prefs = getSharedPreferences("relay_v2", MODE_PRIVATE)
        val alias = "agent-pocket-relay-v2"
        val lock = (application as PocketApplication).persistenceLock
        val persistenceQueue = (application as PocketApplication).persistenceQueue(flutterEngine)
        fun persistenceChannel(name: String) = MethodChannel(flutterEngine.dartExecutor.binaryMessenger, name, StandardMethodCodec.INSTANCE, persistenceQueue)
        fun key(create: Boolean): SecretKey {
            val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
            (store.getKey(alias, null) as? SecretKey)?.let { return it }
            check(create) { "原有设备密钥不可用" }
            return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
                init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
                generateKey()
            }
        }
        persistenceChannel("agent_pocket/credential_store")
            .setMethodCallHandler { call, result ->
                try {
                    synchronized(lock) {
                        when (call.method) {
                            "installationId" -> {
                                var value = prefs.getString("installationId", null)
                                if (value == null) { value = java.util.UUID.randomUUID().toString(); check(prefs.edit().putString("installationId", value).commit()) }
                                result.success(value)
                            }
                            "readPendingHost" -> {
                                val encoded = prefs.getString("pendingHostEnrollment", null)
                                if (encoded == null) result.success(null) else {
                                    val iv = prefs.getString("pendingHostEnrollment:iv", null) ?: error("缺少待绑定 IV")
                                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                                    cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
                                    result.success(cipher.doFinal(Base64.decode(encoded, Base64.NO_WRAP)).toString(Charsets.UTF_8))
                                }
                            }
                            "writePendingHost" -> {
                                val json = call.argument<String>("json") ?: error("缺少待绑定记录"); check(json.length <= 8192)
                                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                                cipher.init(Cipher.ENCRYPT_MODE, key(!prefs.contains("credentials") && !prefs.contains("pendingHostEnrollment") && !prefs.all.keys.any { it.startsWith("flutter_state:") }))
                                check(prefs.edit().putString("pendingHostEnrollment", Base64.encodeToString(cipher.doFinal(json.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
                                    .putString("pendingHostEnrollment:iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP)).commit()); result.success(null)
                            }
                            "clearPendingHost" -> {
                                check(prefs.edit().remove("pendingHostEnrollment").remove("pendingHostEnrollment:iv").commit()); result.success(null)
                            }
                            "isBlocked" -> result.success(prefs.getBoolean("flutter_session_blocked", false))
                            "block" -> {
                                check(prefs.edit().putBoolean("flutter_session_blocked", true).commit()) { "无法保存会话状态" }
                                result.success(null)
                            }
                            "read" -> {
                                val snapshot = prefs.all
                                val encoded = snapshot["credentials"] as? String
                                if (encoded == null) result.success(null) else {
                                    val iv = snapshot["credentials:iv"] as? String ?: snapshot["iv"] as? String
                                        ?: error("原有设备凭据缺少 IV")
                                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                                    cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
                                    result.success(cipher.doFinal(Base64.decode(encoded, Base64.NO_WRAP)).toString(Charsets.UTF_8))
                                }
                            }
                            "write" -> {
                                val value = call.argument<String>("json") ?: error("凭据为空")
                                // Never replace a missing key while encrypted legacy data exists.
                                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                                cipher.init(Cipher.ENCRYPT_MODE, key(!prefs.contains("credentials") && !prefs.contains("pendingHostEnrollment") && !prefs.all.keys.any { it.startsWith("flutter_state:") }))
                                val ok = prefs.edit().putString("credentials", Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
                                    .putString("credentials:iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                                    .putBoolean("flutter_session_blocked", false).commit()
                                check(ok) { "凭据保存失败" }
                                result.success(null)
                            }
                            "clear" -> {
                                check(prefs.edit().putBoolean("flutter_session_blocked", true).remove("credentials").remove("credentials:iv").remove("iv").commit()) { "凭据清除失败" }
                                result.success(null)
                            }
                            else -> result.notImplemented()
                        }
                    }
                } catch (error: Exception) {
                    // Do not expose the encrypted record or keys in logs/errors.
                    result.error("CREDENTIAL_STORE", "无法读取或保存本机设备凭据", null)
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent_pocket/file_save")
            .setMethodCallHandler { call, result ->
                if (call.method != "save") { result.notImplemented(); return@setMethodCallHandler }
                try {
                    check(pendingSave == null) { "文件保存正在进行" }
                    val path = call.argument<String>("path") ?: error("缺少文件")
                    val file = File(path)
                    check(isPrivateTemporary(file)) { "临时文件无效" }
                    val name = (call.argument<String>("name") ?: "文件").replace(Regex("[\\\\/\\p{Cntrl}]"), "_").take(120).ifBlank { "文件" }
                    val mime = (call.argument<String>("mimeType") ?: "application/octet-stream")
                        .takeIf { it.length <= 128 && it.matches(Regex("[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+")) } ?: "application/octet-stream"
                    pendingSave = PendingSave(file, result)
                    try {
                        startActivityForResult(Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
                            addCategory(Intent.CATEGORY_OPENABLE)
                            type = mime
                            putExtra(Intent.EXTRA_TITLE, name)
                        }, saveRequestCode)
                    } catch (error: Exception) { pendingSave = null; throw error }
                } catch (error: Exception) {
                    result.error("SAVE_FAILED", "无法打开系统保存窗口", null)
                }
            }
        persistenceChannel("agent_pocket/appearance")
            .setMethodCallHandler { call, result ->
                try {
                    val prefs = getSharedPreferences("appearance", MODE_PRIVATE)
                    when (call.method) {
                        "read" -> result.success(prefs.getString("skin", null))
                        "write" -> {
                            val value = call.argument<String>("skin")
                            check(value in setOf("plain", "pixel", "oil")) { "外观无效" }
                            check(prefs.edit().putString("skin", value).commit()) { "外观保存失败" }
                            result.success(null)
                        }
                        else -> result.notImplemented()
                    }
                } catch (error: Exception) { result.error("APPEARANCE", "无法读取或保存外观设置", null) }
            }
        persistenceChannel("agent_pocket/secure_state")
            .setMethodCallHandler { call, result ->
                try {
                    synchronized(lock) {
                        val rawKey = call.argument<String>("key") ?: error("缺少状态键")
                        check(rawKey.length in 1..2048)
                        val digest = java.security.MessageDigest.getInstance("SHA-256").digest(rawKey.toByteArray(Charsets.UTF_8))
                            .joinToString("") { "%02x".format(it.toInt() and 255) }
                        val name = "flutter_state:$digest"
                        when (call.method) {
                            "read" -> {
                                val encoded = prefs.getString(name, null)
                                if (encoded == null) result.success(null) else {
                                    val iv = prefs.getString("$name:iv", null) ?: error("缺少 IV")
                                    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                                    cipher.init(Cipher.DECRYPT_MODE, key(false), GCMParameterSpec(128, Base64.decode(iv, Base64.NO_WRAP)))
                                    result.success(cipher.doFinal(Base64.decode(encoded, Base64.NO_WRAP)).toString(Charsets.UTF_8))
                                }
                            }
                            "write" -> {
                                val json = call.argument<String>("json") ?: error("缺少状态")
                                check(json.length <= 1024 * 1024)
                                val cipher = Cipher.getInstance("AES/GCM/NoPadding")
                                cipher.init(Cipher.ENCRYPT_MODE, key(!prefs.contains("credentials") && !prefs.contains("pendingHostEnrollment") && !prefs.all.keys.any { it.startsWith("flutter_state:") }))
                                check(prefs.edit().putString(name, Base64.encodeToString(cipher.doFinal(json.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP))
                                    .putString("$name:iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP)).commit())
                                result.success(null)
                            }
                            else -> result.notImplemented()
                        }
                    }
                } catch (error: Exception) { result.error("STATE_STORE", "无法读取或保存本机状态，请保留数据并恢复", null) }
            }
        files = PocketFileChannels(this, flutterEngine.dartExecutor.binaryMessenger)
        PocketInstallChannels(this, flutterEngine.dartExecutor.binaryMessenger)
        persistenceChannel("agent_pocket/settings").setMethodCallHandler { call, result ->
            try {
                val settings = getSharedPreferences("settings", MODE_PRIVATE)
                when (call.method) {
                    "read" -> result.success(mapOf("notifications" to settings.getBoolean("notifications", true)))
                    "write" -> { val value = call.argument<Boolean>("notifications") ?: error("缺少设置")
                        check(settings.edit().putBoolean("notifications", value).commit()); result.success(null) }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) { result.error("SETTINGS", "无法保存设置", null) }
        }
        persistenceChannel("agent_pocket/cursors").setMethodCallHandler { call, result ->
            try {
                val host = call.argument<String>("hostId") ?: error("缺少电脑")
                check(host.matches(Regex("[A-Za-z0-9_-]{1,64}")))
                when (call.method) {
                    "read" -> result.success(prefs.getLong("lastSeq:$host", 0))
                    "write" -> {
                        val seq = call.argument<Number>("seq")?.toLong() ?: error("缺少游标"); check(seq >= 0)
                        check(prefs.edit().putLong("lastSeq:$host", seq).commit()); result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) { result.error("CURSOR", "无法读取或保存同步位置", null) }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent_pocket/background").setMethodCallHandler { call, result ->
            try {
                when (call.method) {
                    "start" -> {
                        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                            requestPermissions(arrayOf(android.Manifest.permission.POST_NOTIFICATIONS), 49263)
                        }
                        startForegroundService(Intent(this, PocketSyncService::class.java)); result.success(true)
                    }
                    "stop" -> { stopService(Intent(this, PocketSyncService::class.java)); result.success(null) }
                    "attention" -> {
                        val settings = getSharedPreferences("settings", MODE_PRIVATE)
                        if (!settings.getBoolean("notifications", true)) { result.success(null); return@setMethodCallHandler }
                        val manager = getSystemService(NotificationManager::class.java)
                        manager.createNotificationChannel(NotificationChannel("task_attention", "Codex 任务提醒", NotificationManager.IMPORTANCE_DEFAULT))
                        val host = call.argument<String>("hostId") ?: ""
                        val thread = call.argument<String>("threadId") ?: ""
                        val event = call.argument<String>("eventId") ?: ""
                        if (event.isBlank() || event.length > 128) { result.success(null); return@setMethodCallHandler }
                        val seen = try { org.json.JSONArray(settings.getString("seenAttentionEvents", "[]")) } catch (_: Exception) { org.json.JSONArray() }
                        val ids = (0 until seen.length()).map { seen.optString(it) }.filter { it.isNotEmpty() }.toMutableList()
                        if (ids.contains(event)) { result.success(null); return@setMethodCallHandler }
                        ids.add(event)
                        check(settings.edit().putString("seenAttentionEvents", org.json.JSONArray(ids.takeLast(1024)).toString()).commit())
                        val intent = Intent(this, MainActivity::class.java).putExtra("hostId", host).putExtra("threadId", thread).putExtra("eventId", event)
                        val open = PendingIntent.getActivity(this, event.hashCode(), intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
                        val notification = Notification.Builder(this, "task_attention").setSmallIcon(android.R.drawable.stat_notify_chat)
                            .setContentTitle("Agent Pocket").setContentText("任务有新进展或需要你处理").setAutoCancel(true).setContentIntent(open).build()
                        manager.notify(event.hashCode(), notification); result.success(null)
                    }
                    else -> result.notImplemented()
                }
            } catch (e: Exception) { result.error("BACKGROUND", "系统暂不允许后台连接，请回到前台使用", null) }
        }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "agent_pocket/configuration").setMethodCallHandler { call, result ->
            if (call.method == "read") { result.success(mapOf("defaultRelayUrl" to BuildConfig.DEFAULT_RELAY_URL,
                "deviceName" to Build.MODEL, "version" to BuildConfig.VERSION_NAME, "versionCode" to BuildConfig.VERSION_CODE,
                "engineInstanceId" to (if (BuildConfig.DEBUG) System.identityHashCode(flutterEngine) else null),
                "updatePublicKeySpki" to BuildConfig.UPDATE_PUBLIC_KEY_SPKI, "initialLink" to (if (initialLinkConsumed) null else intent?.dataString),
                "notification" to (if (initialLinkConsumed) null else notificationIntent(intent))))
                initialLinkConsumed = true
            } else result.notImplemented()
        }
        if (!flutterEngine.dartExecutor.isExecutingDart) {
            flutterEngine.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint.createDefault())
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val uri = intent.dataString
        if (uri != null && uri.length <= 8192) (application as PocketApplication).sharedEngine?.let {
            MethodChannel(it.dartExecutor.binaryMessenger, "agent_pocket/configuration").invokeMethod("link", mapOf("uri" to uri))
        }
        notificationIntent(intent)?.let { value -> (application as PocketApplication).sharedEngine?.let {
            MethodChannel(it.dartExecutor.binaryMessenger, "agent_pocket/configuration").invokeMethod("notification", value)
        } }
    }
    override fun onPostResume() {
        super.onPostResume()
        if (reusedEngine && !initialLinkConsumed) {
            initialLinkConsumed = true
            notificationIntent(intent)?.let { value -> (application as PocketApplication).sharedEngine?.let {
                MethodChannel(it.dartExecutor.binaryMessenger, "agent_pocket/configuration").invokeMethod("notification", value)
            } }
            intent?.dataString?.let { value -> (application as PocketApplication).sharedEngine?.let {
                MethodChannel(it.dartExecutor.binaryMessenger, "agent_pocket/configuration").invokeMethod("link", mapOf("uri" to value))
            } }
        }
    }
    private fun notificationIntent(intent: Intent?): Map<String, String>? {
        val host = intent?.getStringExtra("hostId") ?: return null
        val thread = intent.getStringExtra("threadId") ?: return null
        if (host.length !in 1..64 || thread.length !in 1..100) return null
        return mapOf("hostId" to host, "threadId" to thread)
    }

    @Deprecated("Android activity result callback")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (files?.onActivityResult(requestCode, resultCode, data) == true) return
        if (requestCode != saveRequestCode) return
        val pending = pendingSave ?: return
        pendingSave = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) { pending.result.success(false); return }
        if (uri.scheme != "content") { pending.result.error("SAVE_FAILED", "保存目标无效", null); return }
        Thread {
            try {
                val file = pending.file
                check(isPrivateTemporary(file))
                val expectedLength = file.length()
                val expectedModified = file.lastModified()
                check(expectedLength in 0..(32L * 1024 * 1024))
                val fd = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_CLOEXEC or OsConstants.O_NOFOLLOW, 0)
                FileInputStream(fd).use { input ->
                    val original = Os.fstat(input.fd)
                    val before = Os.lstat(file.path)
                    check(original.st_dev == before.st_dev && original.st_ino == before.st_ino && original.st_size == expectedLength)
                    (contentResolver.openOutputStream(uri, "w") ?: error("无法写入目标文件")).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        var remaining = expectedLength
                        while (remaining > 0) {
                            val count = input.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                            check(count > 0)
                            output.write(buffer, 0, count)
                            remaining -= count
                        }
                        val after = Os.fstat(input.fd)
                        val pathAfter = Os.lstat(file.path)
                        check(input.read() == -1 && file.length() == expectedLength && file.lastModified() == expectedModified &&
                            after.st_dev == original.st_dev && after.st_ino == original.st_ino &&
                            pathAfter.st_dev == original.st_dev && pathAfter.st_ino == original.st_ino)
                    }
                }
                runOnUiThread { pending.result.success(true) }
            } catch (error: Exception) {
                // The selected provider may contain a partial file; never delete
                // a user-selected destination automatically on failure.
                runOnUiThread { pending.result.error("SAVE_FAILED", "保存未完成，请检查目标文件", null) }
            }
        }.start()
    }

    override fun onDestroy() {
        pendingSave?.result?.error("SAVE_CANCELLED", "保存窗口已关闭", null)
        pendingSave = null
        files?.close()
        super.onDestroy()
    }
}
