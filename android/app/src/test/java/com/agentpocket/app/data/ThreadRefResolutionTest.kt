package com.agentpocket.app.data

import com.agentpocket.app.data.model.ThreadRef
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ThreadRefResolutionTest {
    @Test
    fun `encoded thread ref keeps its host`() {
        assertEquals(
            ThreadRef("host-1", "thread-1"),
            resolveThreadRef(ThreadRef("host-1", "thread-1").encoded(), "host-2"),
        )
    }

    @Test
    fun `raw thread id uses selected host`() {
        assertEquals(ThreadRef("host-1", "thread-1"), resolveThreadRef("thread-1", "host-1"))
    }

    @Test
    fun `raw thread id without host is rejected without throwing`() {
        assertNull(resolveThreadRef("thread-1", null))
        assertNull(resolveThreadRef("thread-1", ""))
    }
}
