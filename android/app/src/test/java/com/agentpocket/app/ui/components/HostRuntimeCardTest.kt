package com.agentpocket.app.ui.components

import com.agentpocket.app.data.model.DesktopRuntimeState
import com.agentpocket.app.data.model.HostRuntime
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostRuntimeCardTest {
    @Test fun `only a fresh safe runtime and advertised capability enable launch`() {
        val safe = HostRuntime("host", desktopState = DesktopRuntimeState.Closed, canWake = true, safeLaunch = true)
        assertTrue(canStartDesktop(true, true, safe))
        assertFalse(canStartDesktop(false, true, safe))
        assertFalse(canStartDesktop(true, false, safe))
        assertFalse(canStartDesktop(true, true, safe.copy(safeLaunch = false)))
        assertFalse(canStartDesktop(true, true, safe.copy(desktopState = DesktopRuntimeState.Starting)))
        assertFalse(canStartDesktop(true, true, null))
    }
}
