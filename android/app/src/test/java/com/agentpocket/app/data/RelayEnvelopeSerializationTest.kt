package com.agentpocket.app.data

import kotlinx.serialization.json.JsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RelayEnvelopeSerializationTest {
    @Test
    fun channelEnvelopeOmitsEventFields() {
        val encoded = encode(RelayEnvelope(
            accountId = "account",
            hostId = "host",
            deviceId = "device",
            channelId = "channel",
            counter = 0,
            kind = "channel.open",
            ciphertext = "ciphertext",
        ))

        assertFalse(encoded.containsKey("eventId"))
        assertFalse(encoded.containsKey("eventType"))
    }

    @Test
    fun eventEnvelopeRetainsEventFields() {
        val encoded = encode(RelayEnvelope(
            accountId = "account",
            hostId = "host",
            deviceId = "device",
            channelId = "channel",
            counter = 1,
            kind = "event.append",
            ciphertext = "ciphertext",
            eventId = "event-1",
            eventType = "completed",
        ))

        assertTrue(encoded.containsKey("eventId"))
        assertTrue(encoded.containsKey("eventType"))
        assertEquals("\"event-1\"", encoded["eventId"].toString())
        assertEquals("\"completed\"", encoded["eventType"].toString())
    }

    private fun encode(envelope: RelayEnvelope) =
        RelayProtocolJson.encodeToJsonElement(RelayEnvelope.serializer(), envelope) as JsonObject
}
