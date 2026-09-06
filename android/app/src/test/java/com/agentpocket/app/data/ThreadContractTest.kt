package com.agentpocket.app.data

import com.agentpocket.app.data.model.ThreadStatus
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Test

class ThreadContractTest {
    private fun obj(value: String) = Json.parseToJsonElement(value) as JsonObject

    @Test fun sharedGrokAllowsContinuationWithExplicitCapabilitiesAndQueueStatus() {
        val execution = threadExecution(obj("""{"source":"grok","execution":{"backend":"grok","owner":"shared","statusMessage":"等待 Grok 开始这一轮","capabilities":{"send":true,"interrupt":true,"approval":true}}}"""))
        assertEquals("shared", execution.owner)
        assertTrue(execution.send && execution.interrupt && execution.approval)
        assertEquals("等待 Grok 开始这一轮", execution.statusMessage)
        assertFalse(execution.handoff || execution.steer || execution.attachments || execution.plan)
        assertFalse(threadExecution(obj("""{"source":"grok","execution":{"backend":"grok","owner":"shared"}}""")).send)
    }

    @Test fun nativeGrokHistoryNeverInheritsDesktopOrWriteCapabilities() {
        val execution = threadExecution(obj("""{"source":"grok","execution":{"backend":"grok","owner":"external","readOnlyReason":"在原终端继续","capabilities":{}}}"""))
        assertEquals("grok", execution.backend)
        assertEquals("external", execution.owner)
        assertEquals("在原终端继续", execution.readOnlyReason)
        assertFalse(execution.send || execution.interrupt || execution.approval || execution.question)
        assertFalse(execution.handoff || execution.plan || execution.goal || execution.steer || execution.attachments)
        assertFalse(threadExecution(obj("""{"source":"grok","execution":{"backend":"grok","owner":"external"}}""")).send)
    }

    @Test fun desktopExecutionDoesNotReplaceRunningState() {
        val value = obj("""{"source":"desktop","status":{"type":"active"},"execution":{"backend":"desktop","owner":null,"capabilities":{"send":true,"interrupt":false}}}""")
        val execution = threadExecution(value)
        assertEquals("desktop", execution.backend)
        assertNull(execution.owner)
        assertTrue(execution.send)
        assertFalse(execution.interrupt)
        assertFalse(execution.handoff)
        assertEquals(ThreadStatus.Active, threadLifecycle(value["status"] as JsonObject))
    }

    @Test fun historyAndApprovalDescribeLifecycleWithoutAClientOwnedTurn() {
        assertEquals(ThreadStatus.Active, threadLifecycle(obj("""{"type":"notLoaded"}"""), true))
        assertEquals(ThreadStatus.Idle, threadLifecycle(obj("""{"type":"notLoaded"}""")))
        assertEquals(ThreadStatus.NeedsAttention, threadLifecycle(obj("""{"type":"active","activeFlags":["waitingOnApproval"]}"""), true))
        assertEquals(ThreadStatus.Completed, threadLifecycle(obj("""{"type":"completed"}""")))
    }

    @Test fun absentNewCapabilitiesAreClosedButLegacyHostsRemainCompatible() {
        assertTrue(threadExecution(obj("""{"source":"appServer"}""")).send)
        assertFalse(threadExecution(obj("""{"source":"desktop"}""")).approval)
        val unavailable = threadExecution(obj("""{"execution":{"backend":"bridge","capabilities":{"send":false,"interrupt":true}}}"""))
        assertFalse(unavailable.send)
        assertTrue(unavailable.interrupt)
        assertFalse(unavailable.goal)
    }

    @Test fun grokKeepsApprovalAndInterruptWithoutCodexOnlyActions() {
        val execution = threadExecution(obj("""{"source":"grok","execution":{"backend":"grok","owner":"host","capabilities":{"send":true,"interrupt":true,"approval":true,"steer":false,"attachments":false}}}"""))
        assertEquals("grok", execution.backend)
        assertEquals("host", execution.owner)
        assertTrue(execution.send)
        assertTrue(execution.interrupt)
        assertTrue(execution.approval)
        assertFalse(execution.steer)
        assertFalse(execution.attachments)
        assertFalse(execution.plan)
        assertFalse(execution.goal)
        assertFalse(execution.handoff)
        assertFalse(threadExecution(obj("""{"source":"grok"}""")).send)
    }
}
