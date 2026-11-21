package com.agentpocket.app

import android.app.Activity
import android.os.Bundle
import android.util.Base64
import android.widget.TextView
import com.agentpocket.app.data.PendingHostEnrollment
import com.agentpocket.app.data.RelayCredentials
import com.agentpocket.app.data.SecurePrefs
import kotlinx.serialization.json.Json

/** Debug-only emulator fixture. Never accepts a real account/Relay identity. */
class LegacyMigrationActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val message = try {
            val encoded = intent.getStringExtra("fixture") ?: error("Missing synthetic fixture")
            check(encoded.length < 16384)
            val data = Base64.decode(encoded, Base64.NO_WRAP).toString(Charsets.UTF_8)
            val credentials = Json.decodeFromString<RelayCredentials>(data)
            check(credentials.endpoint == "https://example.invalid" && credentials.accountId == "migration-fixture-account" && credentials.deviceId == "migration-fixture-device" &&
                credentials.username == "fixture" && credentials.accessToken.startsWith("fixture-") && credentials.refreshToken.startsWith("fixture-"))
            val secure = SecurePrefs(this)
            if (getSharedPreferences("relay_v2", MODE_PRIVATE).contains("credentials")) {
                check(secure.load()?.accountId == "migration-fixture-account") { "Preserve existing identities" }
            }
            secure.save(credentials)
            secure.savePendingHostEnrollment(PendingHostEnrollment("https://example.invalid", "migration-fixture-enrollment", "fixture-pairing-secret", 1900000000000))
            secure.setLastSeq("migration-fixture-host", 7429)
            secure.installationId()
            if (intent.getBooleanExtra("legacyIv", false)) {
                val prefs = getSharedPreferences("relay_v2", MODE_PRIVATE)
                check(prefs.edit().putString("iv", prefs.getString("credentials:iv", null)).remove("credentials:iv").commit())
            }
            check(getSharedPreferences("appearance", MODE_PRIVATE).edit().putString("skin", "pixel").commit())
            check(getSharedPreferences("settings", MODE_PRIVATE).edit().putBoolean("notifications", false).commit())
            "Migration fixture saved"
        } catch (_: Exception) { "Migration fixture rejected" }
        setContentView(TextView(this).apply { text = message; textSize = 22f; setPadding(24, 48, 24, 24) })
    }
}
