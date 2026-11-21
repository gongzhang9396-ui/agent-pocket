package com.agentpocket.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import java.util.UUID
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

@Serializable
internal data class RelayCredentials(
    val endpoint: String,
    val accountId: String,
    val username: String,
    val deviceId: String,
    val deviceName: String,
    val deviceStatus: String,
    val accessToken: String,
    val refreshToken: String,
    val accessExpiresAt: Long,
    val refreshExpiresAt: Long,
    val deviceSigningPublicKey: String,
    val deviceSigningPrivateKey: String,
    val deviceEncryptionPublicKey: String,
    val deviceEncryptionPrivateKey: String,
    val accountSigningPublicKey: String,
    val accountEncryptionPublicKey: String,
    val accountSigningPrivateKey: String? = null,
    val accountEncryptionPrivateKey: String? = null,
    val contentKey: String? = null,
    val requiresLogin: Boolean = false,
) {
    val approved: Boolean get() = deviceStatus == "approved" && !contentKey.isNullOrBlank()
}

@Serializable
internal data class PendingHostEnrollment(
    val endpoint: String,
    val enrollmentId: String,
    val secret: String,
    val capturedAt: Long,
)

internal class SecurePrefs(context: Context) : RelayCredentialStore {
    private companion object { val credentialLock = Any() }
    private val prefs = context.getSharedPreferences("relay_v2", Context.MODE_PRIVATE)
    private val alias = "agent-pocket-relay-v2"
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    override fun save(credentials: RelayCredentials) = synchronized(credentialLock) {
        saveEncrypted("credentials", json.encodeToString(credentials))
    }

    override fun load(): RelayCredentials? = synchronized(credentialLock) {
        runCatching {
            json.decodeFromString<RelayCredentials>(loadEncrypted("credentials") ?: return@synchronized null)
        }.getOrElse { null }
    }

    fun savePendingHostEnrollment(enrollment: PendingHostEnrollment) {
        saveEncrypted("pendingHostEnrollment", json.encodeToString(enrollment))
    }

    fun loadPendingHostEnrollment(): PendingHostEnrollment? = runCatching {
        json.decodeFromString<PendingHostEnrollment>(loadEncrypted("pendingHostEnrollment") ?: return null)
    }.getOrElse { clearPendingHostEnrollment(); null }

    fun clearPendingHostEnrollment() {
        prefs.edit()
            .remove("pendingHostEnrollment")
            .remove("pendingHostEnrollment:iv")
            .apply()
    }

    fun lastSeq(hostId: String): Long = prefs.getLong("lastSeq:$hostId", 0)

    fun setLastSeq(hostId: String, value: Long) {
        prefs.edit().putLong("lastSeq:$hostId", value).apply()
    }

    fun installationId(): String {
        prefs.getString("installationId", null)?.let { return it }
        return UUID.randomUUID().toString().also { prefs.edit().putString("installationId", it).apply() }
    }

    fun clear() = synchronized(credentialLock) {
        check(prefs.edit().clear().commit()) { "无法保存退出状态" }
    }

    override fun clearCredentials() = synchronized(credentialLock) {
        check(prefs.edit().remove("credentials").remove("credentials:iv").remove("iv").commit()) { "无法保存退出状态" }
    }

    private fun saveEncrypted(name: String, value: String) = synchronized(credentialLock) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val saved = prefs.edit()
            .putString(name, Base64.encodeToString(cipher.doFinal(value.toByteArray()), Base64.NO_WRAP))
            .putString("$name:iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .commit()
        check(saved) { "无法保存加密登录信息，请检查手机存储空间" }
    }

    private fun loadEncrypted(name: String): String? {
        val snapshot = prefs.all
        val encoded = snapshot[name] as? String ?: return null
        val encrypted = Base64.decode(encoded, Base64.NO_WRAP)
        // "iv" is the v0.3.1 credential key and remains readable during upgrade.
        val encodedIv = snapshot["$name:iv"] as? String
            ?: (if (name == "credentials") snapshot["iv"] as? String else null)
            ?: error("加密数据缺少 IV")
        val iv = Base64.decode(encodedIv, Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return cipher.doFinal(encrypted).toString(Charsets.UTF_8)
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                    .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }
}
