package com.agentpocket.app.data

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.WebSocket
import okio.ByteString
import org.junit.Assert.*
import org.junit.Test

class BridgeAuthCloseTest {
    private class Socket : WebSocket {
        var closeCode: Int? = null
        override fun request() = Request.Builder().url("https://relay.example").build()
        override fun queueSize() = 0L
        override fun send(text: String) = true
        override fun send(bytes: ByteString) = true
        override fun close(code: Int, reason: String?): Boolean { closeCode = code; return true }
        override fun cancel() = Unit
    }

    @Test fun serverAuthCloseImmediatelyUnblocksReconnectAndAcknowledgesClose() = runBlocking {
        val client = BridgeRpcClient(OkHttpClient(), "wss://relay.example", "test") { }
        val socket = Socket()
        client.onClosing(socket, 4003, "Device access expired or revoked")
        assertEquals(4003, socket.closeCode)
        try { withTimeout(500) { client.awaitClosed() }; fail("Should retain auth failure") }
        catch (error: BridgeRpcException) { assertEquals("AUTH_FAILED", error.nameCode) }
    }

    @Test fun ordinaryCloseIsNotAnAuthFailure() = runBlocking {
        val client = BridgeRpcClient(OkHttpClient(), "wss://relay.example", "test") { }
        val socket = Socket()
        client.onClosing(socket, 1001, "Restart")
        withTimeout(500) { client.awaitClosed() }
        assertEquals(1001, socket.closeCode)
    }
}
