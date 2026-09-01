package com.agentpocket.app.data

import com.agentpocket.app.data.model.Project
import com.agentpocket.app.data.model.ThreadStatus
import com.agentpocket.app.data.model.ThreadSummary
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class ThreadGroupingTest {

    private fun thread(id: String, cwd: String, epoch: Long, hostId: String = "h1", hostName: String = "PC") =
        ThreadSummary(id, "t-$id", cwd, ThreadStatus.Idle, "", "", 0, hostId, hostName, epoch)

    @Test
    fun groupsByProjectAndOrdersByNewestActivity() {
        val sections = threadSections(
            listOf(
                thread("a", "G:\\项目\\alpha", epoch = 100),
                thread("b", "G:\\项目\\beta", epoch = 300),
                thread("c", "G:\\项目\\alpha\\", epoch = 200),
            ),
            showHost = false,
        )
        assertEquals(listOf("beta", "alpha"), sections.map { it.title })
        assertEquals(listOf("c", "a"), sections[1].threads.map { it.id })
    }

    @Test
    fun desktopProjectRegistryNameWinsOverPathSegment() {
        val sections = threadSections(
            listOf(thread("a", "G:\\项目\\alpha", epoch = 1)),
            showHost = false,
            projects = listOf(Project("p1", "Alpha 计划", "G:\\项目\\Alpha")),
        )
        assertEquals("Alpha 计划", sections.single().title)
    }

    @Test
    fun sameCwdOnDifferentHostsStaysSeparate() {
        val sections = threadSections(
            listOf(
                thread("a", "G:\\项目\\alpha", epoch = 2, hostId = "h1", hostName = "PC1"),
                thread("b", "G:\\项目\\alpha", epoch = 1, hostId = "h2", hostName = "PC2"),
            ),
            showHost = true,
        )
        assertEquals(2, sections.size)
        assertEquals(listOf("PC1", "PC2"), sections.map { it.hostName })
    }

    @Test
    fun hostNameHiddenWhenSingleHostView() {
        val sections = threadSections(listOf(thread("a", "G:\\项目\\alpha", epoch = 1)), showHost = false)
        assertNull(sections.single().hostName)
    }

    @Test
    fun blankCwdFallsBackToPlaceholderTitle() {
        val sections = threadSections(listOf(thread("a", "", epoch = 1)), showHost = false)
        assertEquals("未指定项目", sections.single().title)
    }
}
