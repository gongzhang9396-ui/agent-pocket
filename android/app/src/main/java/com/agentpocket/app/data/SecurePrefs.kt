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
) {
    val approved: Boolean get() = deviceStatus == "approved" && !contentKey.isNullOrBlank()
}

internal class SecurePrefs(context: Context) {
    private val prefs = context.getSharedPreferences("relay_v2", Context.MODE_PRIVATE)
    private val alias = "agent-pocket-relay-v2"
    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }

    fun save(credentials: RelayCredentials) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val plaintext = json.encodeToString(credentials).toByteArray()
        prefs.edit()
            .putString("credentials", Base64.encodeToString(cipher.doFinal(plaintext), Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .apply()
    }

    fun load(): RelayCredentials? = runCatching {
        val encoded = prefs.getString("credentials", null) ?: return null
        json.decodeFromString<RelayCredentials>(decrypt(encoded))
    }.getOrElse { clear(); null }

    fun lastSeq(hostId: String): Long = prefs.getLong("lastSeq:$hostId", 0)

    fun setLastSeq(hostId: String, value: Long) {
        prefs.edit().putLong("lastSeq:$hostId", value).apply()
    }

    fun installationId(): String {
        prefs.getString("installationId", null)?.let { return it }
        return UUID.randomUUID().toString().also { prefs.edit().putString("installationId", it).apply() }
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    private fun decrypt(encoded: String): String {
        val encrypted = Base64.decode(encoded, Base64.NO_WRAP)
        val iv = Base64.decode(prefs.getString("iv", null), Base64.NO_WRAP)
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
