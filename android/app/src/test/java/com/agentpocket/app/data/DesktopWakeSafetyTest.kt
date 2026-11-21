package com.agentpocket.app.data

import com.agentpocket.app.data.model.DesktopRuntimeState
import com.agentpocket.app.data.model.HostRuntime
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DesktopWakeSafetyTest {
    @Test fun `reconnect and downgrade cannot reuse old channel attestation`() {
        val runtime = HostRuntime("host", desktopState = DesktopRuntimeState.Closed, canWake = true, safeLaunch = true)
        assertTrue(canRequestDesktopWake(true, true, "channel-1", "channel-1", runtime))
        assertFalse(canRequestDesktopWake(false, true, "channel-1", null, runtime))
        assertFalse(canRequestDesktopWake(true, true, "channel-1", "channel-2", runtime))
        assertFalse(canRequestDesktopWake(true, false, null, "channel-2", runtime))
        assertFalse(canRequestDesktopWake(true, true, "channel-2", "channel-2", runtime.copy(safeLaunch = false)))
        assertFalse(canRequestDesktopWake(true, true, "channel-2", "channel-2", null))
        val original = Any()
        assertTrue(sameWakeChannel(original, original))
        assertFalse(sameWakeChannel(original, Any()))
        assertFalse(sameWakeChannel(original, null))
    }
}
