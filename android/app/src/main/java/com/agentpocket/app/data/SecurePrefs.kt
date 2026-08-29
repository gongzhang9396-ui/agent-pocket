package com.agentpocket.app.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal data class BridgeCredentials(val endpoint: String, val deviceId: String, val token: String)

internal class SecurePrefs(context: Context) {
    private val prefs = context.getSharedPreferences("bridge", Context.MODE_PRIVATE)
    private val alias = "agent-pocket-device-token"

    fun save(credentials: BridgeCredentials) {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val plaintext = listOf(credentials.endpoint, credentials.deviceId, credentials.token).joinToString("\u0000")
        prefs.edit()
            .putString("credentials", Base64.encodeToString(cipher.doFinal(plaintext.toByteArray()), Base64.NO_WRAP))
            .putString("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
            .remove("endpoint")
            .remove("deviceId")
            .remove("token")
            .apply()
    }

    fun load(): BridgeCredentials? = runCatching {
        prefs.getString("credentials", null)?.let { encoded ->
            val values = decrypt(encoded).split('\u0000', limit = 3)
            if (values.size != 3 || values.any(String::isBlank)) error("Invalid encrypted Bridge credentials")
            return BridgeCredentials(values[0], values[1], values[2])
        }

        val endpoint = prefs.getString("endpoint", null) ?: return null
        val deviceId = prefs.getString("deviceId", null) ?: return null
        val token = decrypt(prefs.getString("token", null) ?: return null)
        BridgeCredentials(endpoint, deviceId, token).also(::save)
    }.getOrElse { clear(); null }

    private fun decrypt(encoded: String): String {
        val encrypted = Base64.decode(encoded, Base64.NO_WRAP)
        val iv = Base64.decode(prefs.getString("iv", null), Base64.NO_WRAP)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, iv))
        return cipher.doFinal(encrypted).toString(Charsets.UTF_8)
    }

    var lastSeq: Long
        get() = prefs.getLong("lastSeq", 0)
        set(value) { prefs.edit().putLong("lastSeq", value).apply() }

    fun clear() {
        prefs.edit().clear().apply()
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
