package com.agentpocket.app.data

import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class RelayTokenRefreshTest {
    private fun credentials(endpoint: String) = RelayCredentials(
        endpoint, "account", "user", "device", "phone", "approved", "old", "refresh-old", 1, 9999999999999,
        "public", "private", "public", "private", "public", "public", contentKey = "content",
    )

    @Test fun parsesRealRefreshEnvelopeAndRetainsDeviceKeys() = runBlocking {
        val server = MockWebServer()
        server.enqueue(MockResponse().setBody("""{"accessToken":"new","refreshToken":"refresh-new","accessExpiresAt":12345,"refreshExpiresAt":67890,"sessionId":"session"}"""))
        server.start()
        try {
            val old = credentials(server.url("/").toString().trimEnd('/'))
            val rotated = RelayTokenRefresh { }.refresh(old)
            assertEquals("new", rotated.accessToken)
            assertEquals("refresh-new", rotated.refreshToken)
            assertEquals(12345L, rotated.accessExpiresAt)
            assertEquals(old.deviceEncryptionPrivateKey, rotated.deviceEncryptionPrivateKey)
            assertEquals(old.contentKey, rotated.contentKey)
            val request = server.takeRequest(1, TimeUnit.SECONDS)!!
            assertEquals("/api/auth/refresh", request.path)
            assertEquals("POST", request.method)
            assertEquals("""{"refreshToken":"refresh-old"}""", request.body.readUtf8())
            assertEquals(1, server.requestCount)
        } finally { server.shutdown() }
    }

    @Test fun refresh401IsTerminalAndRedirectsNeverForwardToken() = runBlocking {
        for (status in listOf(401, 302, 503, 200)) {
            val server = MockWebServer()
            server.enqueue(MockResponse().setResponseCode(status).setHeader("Location", "/elsewhere").setBody("{}"))
            server.enqueue(MockResponse().setResponseCode(401))
            server.start()
            try {
                try { RelayTokenRefresh { }.refresh(credentials(server.url("/").toString().trimEnd('/'))); fail("Should fail") }
                catch (error: IOException) {
                    assertEquals(status == 401, error is AccessRejectedException)
                    assertEquals(status == 200, error is RefreshConsumedException)
                }
                assertEquals(1, server.requestCount)
            } finally { server.shutdown() }
        }
    }
}
