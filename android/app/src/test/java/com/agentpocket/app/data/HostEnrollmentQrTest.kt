package com.agentpocket.app.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class HostEnrollmentQrTest {
    @Test
    fun parsesEncodedRelayHostQr() {
        val parsed = parseHostEnrollmentQr(
            "agentpocket://relay-host?relay=https%3A%2F%2Frelay.example.test&enrollmentId=enroll-1&secret=secret-1",
            capturedAt = 1234,
        )

        assertEquals("https://relay.example.test", parsed?.endpoint)
        assertEquals("enroll-1", parsed?.enrollmentId)
        assertEquals("secret-1", parsed?.secret)
        assertEquals(1234L, parsed?.capturedAt)
    }

    @Test
    fun rejectsNonHttpsAndMalformedCodes() {
        assertNull(parseHostEnrollmentQr("agentpocket://relay-host?relay=http://relay.test&enrollmentId=a&secret=b"))
        assertNull(parseHostEnrollmentQr("https://relay.example.test/not-a-code"))
        assertNull(parseHostEnrollmentQr("agentpocket://relay-host?relay=https://relay.test&enrollmentId=a"))
    }
}
