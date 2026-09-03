package com.agentpocket.app.ui.screens

import org.junit.Assert.assertEquals
import org.junit.Test

class PairingScreenTest {
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
