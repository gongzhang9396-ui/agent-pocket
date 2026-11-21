package com.agentpocket.app.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Test

class PairingScreenTest {
    @Test
    fun `device verification code binds ID and encryption public key`() {
        assertEquals("1BA1 CD2F F06A BA12", deviceVerificationCode("test-device", "public-key"))
        org.junit.Assert.assertNotEquals(deviceVerificationCode("other-device", "public-key"), deviceVerificationCode("test-device", "public-key"))
    }
    @Test
    fun `fresh install uses build default relay`() {
        assertEquals(
            "https://relay.example.com",
            initialRelayUrl("", "https://relay.example.com"),
        )
    }

    @Test
    fun `saved relay always wins over build default`() {
        assertEquals(
            "https://saved.example.com",
            initialRelayUrl("https://saved.example.com", "https://relay.example.com"),
        )
    }
}
