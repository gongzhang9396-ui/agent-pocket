package com.agentpocket.app.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import com.agentpocket.app.BuildConfig
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import java.util.Locale
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import okhttp3.OkHttpClient
import okhttp3.Request

sealed interface AppUpdateState {
    data object Idle : AppUpdateState
    data object Checking : AppUpdateState
    data object UpToDate : AppUpdateState
    data class Available(val version: String, val sizeBytes: Long) : AppUpdateState
    data class Downloading(val version: String, val progress: Int) : AppUpdateState
    data class Ready(val version: String) : AppUpdateState
    data class Error(val message: String) : AppUpdateState
}

@Serializable
internal data class GitHubRelease(
    @SerialName("tag_name") val tagName: String,
    val assets: List<GitHubAsset> = emptyList(),
)

@Serializable
internal data class GitHubAsset(
    val name: String,
    @SerialName("browser_download_url") val downloadUrl: String,
    val size: Long = 0,
)

internal data class UpdateCandidate(
    val version: String,
    val apk: GitHubAsset,
    val checksum: GitHubAsset,
)

internal object UpdateProtocol {
    private val versionPart = Regex("\\d+")
    private val checksumPattern = Regex("^[0-9a-fA-F]{64}$")

    fun candidate(release: GitHubRelease, currentVersion: String): UpdateCandidate? {
        val version = release.tagName.trim().removePrefix("v")
        if (!isNewer(version, currentVersion)) return null
        val exactName = "Agent-Pocket-$version-release.apk"
        val apk = release.assets.firstOrNull { it.name == exactName }
            ?: release.assets.singleOrNull { it.name.endsWith(".apk", ignoreCase = true) }
            ?: return null
        val checksum = release.assets.firstOrNull { it.name == "${apk.name}.sha256" } ?: return null
        return UpdateCandidate(version, apk, checksum)
    }

    fun isNewer(candidate: String, current: String): Boolean {
        val left = versionPart.findAll(candidate).map { it.value.toLongOrNull() ?: 0L }.toList()
        val right = versionPart.findAll(current).map { it.value.toLongOrNull() ?: 0L }.toList()
        if (left.isEmpty() || right.isEmpty()) return false
        repeat(maxOf(left.size, right.size)) { index ->
            val comparison = (left.getOrNull(index) ?: 0L).compareTo(right.getOrNull(index) ?: 0L)
            if (comparison != 0) return comparison > 0
        }
        return false
    }

    fun parseChecksum(value: String): String {
        val checksum = value.trim().split(Regex("\\s+"), limit = 2).firstOrNull().orEmpty()
        require(checksumPattern.matches(checksum)) { "更新校验文件格式不正确" }
        return checksum.lowercase(Locale.US)
    }
}

class AppUpdateManager(private val context: Context) {
    private val json = Json { ignoreUnknownKeys = true }
    private val client = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val _state = MutableStateFlow<AppUpdateState>(AppUpdateState.Idle)
    val state: StateFlow<AppUpdateState> = _state.asStateFlow()

    private var activeJob: Job? = null
    private var candidate: UpdateCandidate? = null
    private var downloadedFile: File? = null

    fun checkForUpdates() {
        if (activeJob?.isActive == true || _state.value is AppUpdateState.Downloading) return
        activeJob = scope.launch {
            _state.value = AppUpdateState.Checking
            runCatching {
                val request = Request.Builder()
                    .url(BuildConfig.UPDATE_API_URL)
                    .header("Accept", "application/vnd.github+json")
                    .header("User-Agent", "Agent-Pocket/${BuildConfig.VERSION_NAME}")
                    .build()
                val release = client.newCall(request).execute().use { response ->
                    if (response.code == 404) return@use null
                    if (!response.isSuccessful) throw IOException("更新检查失败 (${response.code})")
                    val body = response.body?.string() ?: throw IOException("更新检查返回为空")
                    json.decodeFromString<GitHubRelease>(body)
                }
                if (release == null) {
                    candidate = null
                    AppUpdateState.UpToDate
                } else {
                    val next = UpdateProtocol.candidate(release, BuildConfig.VERSION_NAME)
                    candidate = next
                    if (next == null) AppUpdateState.UpToDate
                    else AppUpdateState.Available(next.version, next.apk.size)
                }
            }.onSuccess { _state.value = it }
                .onFailure { _state.value = AppUpdateState.Error(updateError(it)) }
        }
    }

    fun downloadUpdate() {
        val update = candidate ?: run {
            checkForUpdates()
            return
        }
        if (activeJob?.isActive == true) return
        activeJob = scope.launch {
            _state.value = AppUpdateState.Downloading(update.version, 0)
            runCatching {
                val expectedChecksum = UpdateProtocol.parseChecksum(downloadText(update.checksum.downloadUrl))
                val updateDir = File(context.cacheDir, "updates").apply { mkdirs() }
                updateDir.listFiles()?.forEach { if (it.isFile) it.delete() }
                val partial = File(updateDir, "${update.apk.name}.part")
                val target = File(updateDir, update.apk.name)
                downloadApk(update, partial)
                val actualChecksum = sha256(partial)
                if (actualChecksum != expectedChecksum) throw IOException("APK 校验失败，请重新下载")
                if (!partial.renameTo(target)) {
                    partial.copyTo(target, overwrite = true)
                    partial.delete()
                }
                verifyInstallablePackage(target)
                downloadedFile = target
                AppUpdateState.Ready(update.version)
            }.onSuccess { _state.value = it }
                .onFailure { _state.value = AppUpdateState.Error(updateError(it)) }
        }
    }

    fun installUpdate() {
        val file = downloadedFile?.takeIf(File::isFile) ?: run {
            _state.value = AppUpdateState.Error("更新文件已失效，请重新下载")
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.packageManager.canRequestPackageInstalls()) {
            context.startActivity(
                Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            return
        }
        val uri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
        context.startActivity(
            Intent(Intent.ACTION_VIEW)
                .setDataAndType(uri, "application/vnd.android.package-archive")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_GRANT_READ_URI_PERMISSION),
        )
    }

    private fun downloadText(url: String): String {
        val request = Request.Builder().url(url).header("User-Agent", "Agent-Pocket/${BuildConfig.VERSION_NAME}").build()
        return client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("更新校验下载失败 (${response.code})")
            response.body?.string()?.take(4_096) ?: throw IOException("更新校验返回为空")
        }
    }

    private fun downloadApk(update: UpdateCandidate, output: File) {
        val request = Request.Builder().url(update.apk.downloadUrl).header("User-Agent", "Agent-Pocket/${BuildConfig.VERSION_NAME}").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("APK 下载失败 (${response.code})")
            val body = response.body ?: throw IOException("APK 下载返回为空")
            val total = body.contentLength().takeIf { it > 0 } ?: update.apk.size
            if (total <= 0 || total > MAX_APK_BYTES) throw IOException("APK 文件大小异常")
            body.byteStream().use { input ->
                output.outputStream().buffered().use { destination ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var downloaded = 0L
                    var lastProgress = -1
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        downloaded += count
                        if (downloaded > MAX_APK_BYTES) throw IOException("APK 文件超过大小限制")
                        destination.write(buffer, 0, count)
                        val progress = ((downloaded * 100) / total).toInt().coerceIn(0, 100)
                        if (progress != lastProgress) {
                            lastProgress = progress
                            _state.value = AppUpdateState.Downloading(update.version, progress)
                        }
                    }
                }
            }
        }
    }

    private fun verifyInstallablePackage(file: File) {
        val manager = context.packageManager
        val archive = packageInfo(manager, file.absolutePath)
            ?: throw IOException("无法读取下载的 APK")
        val installed = installedPackageInfo(manager)
        if (archive.packageName != context.packageName) {
            throw IOException("更新包与当前应用包名不一致")
        }
        if (longVersionCode(archive) <= longVersionCode(installed)) {
            throw IOException("下载的 APK 版本没有更新")
        }
        val archiveSignatures = signatureDigests(archive)
        val installedSignatures = signatureDigests(installed)
        if (archiveSignatures.isEmpty() || archiveSignatures.intersect(installedSignatures).isEmpty()) {
            throw IOException("更新包签名与当前应用不一致")
        }
    }

    @Suppress("DEPRECATION")
    private fun packageInfo(manager: PackageManager, path: String): PackageInfo? =
        if (Build.VERSION.SDK_INT >= 33) {
            manager.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            manager.getPackageArchiveInfo(path, PackageManager.GET_SIGNING_CERTIFICATES)
        } else {
            manager.getPackageArchiveInfo(path, PackageManager.GET_SIGNATURES)
        }

    @Suppress("DEPRECATION")
    private fun installedPackageInfo(manager: PackageManager): PackageInfo =
        if (Build.VERSION.SDK_INT >= 33) {
            manager.getPackageInfo(context.packageName, PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES.toLong()))
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            manager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
        } else {
            manager.getPackageInfo(context.packageName, PackageManager.GET_SIGNATURES)
        }

    @Suppress("DEPRECATION")
    private fun longVersionCode(info: PackageInfo): Long =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) info.longVersionCode else info.versionCode.toLong()

    @Suppress("DEPRECATION")
    private fun signatureDigests(info: PackageInfo): Set<String> {
        val signatures = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val signingInfo = info.signingInfo ?: return emptySet()
            if (signingInfo.hasMultipleSigners()) signingInfo.apkContentsSigners
            else signingInfo.signingCertificateHistory
        } else {
            info.signatures
        }
        return signatures.orEmpty().mapTo(mutableSetOf()) { signature ->
            MessageDigest.getInstance("SHA-256").digest(signature.toByteArray()).toHex()
        }
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().buffered().use { input ->
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            while (true) {
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
            }
        }
        return digest.digest().toHex()
    }

    private fun ByteArray.toHex(): String = joinToString("") { "%02x".format(it) }

    private fun updateError(error: Throwable): String = when (error) {
        is IOException -> error.message ?: "更新失败，请稍后重试"
        else -> "更新失败，请稍后重试"
    }

    private companion object {
        const val MAX_APK_BYTES = 250L * 1024 * 1024
    }
}
