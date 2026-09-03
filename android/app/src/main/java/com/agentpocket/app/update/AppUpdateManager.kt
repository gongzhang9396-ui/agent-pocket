package com.agentpocket.app.update

import android.content.Context
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import android.util.Base64
import androidx.core.content.FileProvider
import com.agentpocket.app.BuildConfig
import com.agentpocket.app.data.RelayCrypto
import com.agentpocket.app.data.SecurePrefs
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
internal data class RelayUpdateResponse(
    val manifestJson: String,
    val manifestSignature: String,
    val downloadUrl: String,
)

@Serializable
internal data class RelayUpdateManifest(
    val schemaVersion: Int,
    val platform: String,
    val version: String,
    val versionCode: Long,
    val asset: RelayUpdateAsset,
)

@Serializable
internal data class RelayUpdateAsset(
    val name: String,
    val size: Long,
    val sha256: String,
)

internal data class UpdateCandidate(
    val version: String,
    val versionCode: Long,
    val name: String,
    val downloadUrl: String,
    val size: Long,
    val sha256: String,
)

internal object UpdateProtocol {
    private val versionPart = Regex("\\d+")
    private val checksumPattern = Regex("^[0-9a-fA-F]{64}$")
    private val json = Json { ignoreUnknownKeys = false }

    fun candidate(response: RelayUpdateResponse, currentVersion: String, currentVersionCode: Long, signatureValid: Boolean): UpdateCandidate? {
        require(signatureValid) { "更新清单签名验证失败" }
        val manifest = json.decodeFromString<RelayUpdateManifest>(response.manifestJson)
        require(manifest.schemaVersion == 1 && manifest.platform == "android") { "更新清单不兼容" }
        require(manifest.version.matches(Regex("^\\d+\\.\\d+\\.\\d+$"))) { "更新版本无效" }
        require(manifest.asset.name == "Agent-Pocket-${manifest.version}-release.apk") { "APK 文件名无效" }
        require(manifest.asset.size in 1..MAX_APK_BYTES && checksumPattern.matches(manifest.asset.sha256)) { "APK 清单无效" }
        if (manifest.versionCode <= currentVersionCode || !isNewer(manifest.version, currentVersion)) return null
        return UpdateCandidate(
            manifest.version,
            manifest.versionCode,
            manifest.asset.name,
            response.downloadUrl,
            manifest.asset.size,
            manifest.asset.sha256.lowercase(Locale.US),
        )
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

    fun verifyManifest(manifestJson: String, signatureBase64: String, publicKeySpkiBase64: String): Boolean = runCatching {
        val spki = Base64.decode(publicKeySpkiBase64, Base64.DEFAULT)
        val prefix = byteArrayOf(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00)
        require(spki.size == prefix.size + 32 && spki.copyOfRange(0, prefix.size).contentEquals(prefix))
        val signature = Base64.decode(signatureBase64, Base64.DEFAULT)
        RelayCrypto.verify(signature, manifestJson.toByteArray(Charsets.UTF_8), spki.copyOfRange(prefix.size, spki.size))
    }.getOrDefault(false)

    const val MAX_APK_BYTES = 250L * 1024 * 1024
}

private fun sameOrigin(endpoint: String, downloadUrl: String): Boolean = runCatching {
    val base = java.net.URI(endpoint)
    val download = java.net.URI(downloadUrl)
    base.scheme.equals(download.scheme, true) && base.host.equals(download.host, true) && base.port == download.port &&
        download.userInfo == null && download.query == null && download.fragment == null && download.path.startsWith("/api/updates/android/")
}.getOrDefault(false)

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
                val credentials = SecurePrefs(context).load()?.takeIf { it.approved }
                    ?: return@runCatching AppUpdateState.UpToDate
                if (BuildConfig.UPDATE_PUBLIC_KEY_SPKI.isBlank()) throw IOException("当前安装包未配置更新签名公钥")
                val request = Request.Builder()
                    .url("${credentials.endpoint.trimEnd('/')}/api/updates/android/latest")
                    .header("Authorization", "Bearer ${credentials.accessToken}")
                    .header("Accept", "application/json")
                    .header("User-Agent", "Agent-Pocket/${BuildConfig.VERSION_NAME}")
                    .build()
                val release = client.newCall(request).execute().use { response ->
                    if (response.code == 404) return@use null
                    if (!response.isSuccessful) throw IOException("更新检查失败 (${response.code})")
                    val body = response.body?.string() ?: throw IOException("更新检查返回为空")
                    json.decodeFromString<RelayUpdateResponse>(body)
                }
                if (release == null) {
                    candidate = null
                    AppUpdateState.UpToDate
                } else {
                    if (!sameOrigin(credentials.endpoint, release.downloadUrl)) throw IOException("更新下载地址不属于当前 Relay")
                    val signatureValid = UpdateProtocol.verifyManifest(
                        release.manifestJson,
                        release.manifestSignature,
                        BuildConfig.UPDATE_PUBLIC_KEY_SPKI,
                    )
                    val next = UpdateProtocol.candidate(release, BuildConfig.VERSION_NAME, BuildConfig.VERSION_CODE.toLong(), signatureValid)
                    candidate = next
                    if (next == null) AppUpdateState.UpToDate
                    else AppUpdateState.Available(next.version, next.size)
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
                val credentials = SecurePrefs(context).load()?.takeIf { it.approved && sameOrigin(it.endpoint, update.downloadUrl) }
                    ?: throw IOException("登录已失效，请重新登录后下载")
                val updateDir = File(context.cacheDir, "updates").apply { mkdirs() }
                updateDir.listFiles()?.forEach { if (it.isFile) it.delete() }
                val partial = File(updateDir, "${update.name}.part")
                val target = File(updateDir, update.name)
                downloadApk(update, partial, credentials.accessToken)
                val actualChecksum = sha256(partial)
                if (partial.length() != update.size || actualChecksum != update.sha256) throw IOException("APK 校验失败，请重新下载")
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

    private fun downloadApk(update: UpdateCandidate, output: File, accessToken: String) {
        val request = Request.Builder().url(update.downloadUrl)
            .header("Authorization", "Bearer $accessToken")
            .header("User-Agent", "Agent-Pocket/${BuildConfig.VERSION_NAME}")
            .build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("APK 下载失败 (${response.code})")
            val body = response.body ?: throw IOException("APK 下载返回为空")
            val declared = body.contentLength()
            if (declared > 0 && declared != update.size) throw IOException("APK 响应大小与签名清单不一致")
            val total = update.size
            if (total <= 0 || total > UpdateProtocol.MAX_APK_BYTES) throw IOException("APK 文件大小异常")
            body.byteStream().use { input ->
                output.outputStream().buffered().use { destination ->
                    val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                    var downloaded = 0L
                    var lastProgress = -1
                    while (true) {
                        val count = input.read(buffer)
                        if (count < 0) break
                        downloaded += count
                        if (downloaded > update.size || downloaded > UpdateProtocol.MAX_APK_BYTES) throw IOException("APK 文件超过大小限制")
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

}
