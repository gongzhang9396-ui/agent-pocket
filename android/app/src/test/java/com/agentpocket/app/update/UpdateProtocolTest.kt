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
    fun requiresMatchingApkAndChecksumAssets() {
        val apk = GitHubAsset("Agent-Pocket-0.1.10-release.apk", "https://example.invalid/app.apk", 42L)
        val checksum = GitHubAsset("${apk.name}.sha256", "https://example.invalid/app.sha256", 64L)
        val candidate = UpdateProtocol.candidate(GitHubRelease("v0.1.10", listOf(apk, checksum)), "0.1.9")

        assertEquals("0.1.10", candidate?.version)
        assertEquals(apk, candidate?.apk)
        assertNull(UpdateProtocol.candidate(GitHubRelease("v0.1.10", listOf(apk)), "0.1.9"))
    }

    @Test
    fun parsesStandardSha256File() {
        val checksum = "a".repeat(64)
        assertEquals(checksum, UpdateProtocol.parseChecksum("$checksum  Agent-Pocket.apk\n"))
    }
}
