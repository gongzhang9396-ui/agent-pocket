package com.agentpocket.app.ui.theme

import org.junit.Assert.assertEquals
import org.junit.Test

class SkinStyleTest {
    @Test fun `theme identifier is persisted independently and unknown values fall back safely`() {
        assertEquals(SkinStyle.Plain, SkinStyle.fromId(null))
        assertEquals(SkinStyle.Plain, SkinStyle.fromId("unknown"))
        SkinStyle.entries.forEach { assertEquals(it, SkinStyle.fromId(it.id)) }
    }
}
