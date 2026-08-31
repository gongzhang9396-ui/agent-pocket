package com.agentpocket.app.data

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PendingSessionTest {
    @Test
    fun rejectedAuthenticationInvalidatesPendingSession() {
        assertTrue(isPendingSessionRejected(BridgeRpcException("刷新令牌无效", "AUTH_FAILED")))
    }

    @Test
    fun networkFailureKeepsPendingSessionForRetry() {
        assertFalse(isPendingSessionRejected(BridgeRpcException("网络暂时不可用")))
    }
}
