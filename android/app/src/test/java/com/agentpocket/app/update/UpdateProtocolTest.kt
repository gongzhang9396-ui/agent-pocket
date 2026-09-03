package com.agentpocket.app.update

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class UpdateProtocolTest {
    @Test
    fun comparesNumericVersionParts() {
        assertTrue(UpdateProtocol.isNewer("0.1.10", "0.1.9"))
        assertTrue(UpdateProtocol.isNewer("v1.0.0", "0.9.99"))
        assertFalse(UpdateProtocol.isNewer("0.1.9", "0.1.10"))
        assertFalse(UpdateProtocol.isNewer("1.0.0", "1.0"))
    }

    @Test
    fun requiresSignedRelayManifestWithExactApkName() {
        val manifest = """{"schemaVersion":1,"platform":"android","version":"0.1.10","versionCode":10,"asset":{"name":"Agent-Pocket-0.1.10-release.apk","size":42,"sha256":"${"a".repeat(64)}"}}"""
        val response = RelayUpdateResponse(manifest, "signature", "https://relay.invalid/api/updates/android/0.1.10/app.apk")
        val candidate = UpdateProtocol.candidate(response, "0.1.9", 9, signatureValid = true)

        assertEquals("0.1.10", candidate?.version)
        assertEquals(42L, candidate?.size)
        assertNull(UpdateProtocol.candidate(response, "0.1.10", 10, signatureValid = true))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsUnsignedManifest() {
        val manifest = """{"schemaVersion":1,"platform":"android","version":"0.1.10","versionCode":10,"asset":{"name":"Agent-Pocket-0.1.10-release.apk","size":42,"sha256":"${"a".repeat(64)}"}}"""
        UpdateProtocol.candidate(
            RelayUpdateResponse(manifest, "", "https://relay.invalid/api/updates/android/0.1.10/app.apk"),
            "0.1.9",
            9,
            signatureValid = false,
        )
    }
}
