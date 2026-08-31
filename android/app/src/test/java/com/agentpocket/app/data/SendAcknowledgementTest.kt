package com.agentpocket.app.data

import com.agentpocket.app.data.model.MessageStatus
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SendAcknowledgementTest {
    @Test
    fun `server acknowledged message never regresses to failed`() {
        assertFalse(shouldMarkSendFailed(MessageStatus.Done))
    }

    @Test
    fun `unacknowledged message may still be marked failed`() {
        assertTrue(shouldMarkSendFailed(MessageStatus.Streaming))
        assertTrue(shouldMarkSendFailed(MessageStatus.Failed))
        assertTrue(shouldMarkSendFailed(null))
    }
}
