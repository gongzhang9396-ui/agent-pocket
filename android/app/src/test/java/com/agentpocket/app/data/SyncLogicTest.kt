package com.agentpocket.app.data

import com.agentpocket.app.data.model.ApprovalDecision
import com.agentpocket.app.data.model.MessageStatus
import com.agentpocket.app.data.model.PlanStatus
import com.agentpocket.app.data.model.PlanStep
import com.agentpocket.app.data.model.Role
import com.agentpocket.app.data.model.StepStatus
import com.agentpocket.app.data.model.TimelineItem
import java.net.SocketTimeoutException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncLogicTest {

    @Test
    fun sequentialEventApplies() {
        assertEquals(EventSeqDecision.Apply, eventSeqDecision(lastSeq = 5, seq = 6))
    }

    @Test
    fun firstEventAfterCursorResetAppliesRegardlessOfSeq() {
        assertEquals(EventSeqDecision.Apply, eventSeqDecision(lastSeq = 0, seq = 4711))
    }

    @Test
    fun duplicateOrOlderEventSkips() {
        assertEquals(EventSeqDecision.Skip, eventSeqDecision(lastSeq = 5, seq = 5))
        assertEquals(EventSeqDecision.Skip, eventSeqDecision(lastSeq = 5, seq = 3))
    }

    @Test
    fun missingEventReportsGapWithoutRewind() {
        assertEquals(EventSeqDecision.Gap, eventSeqDecision(lastSeq = 5, seq = 7))
    }

    @Test
    fun archiveMarkersAreFilteredDefensively() {
        assertEquals(true, isArchivedThread(archived = true, isArchived = null, archivedAtPresent = false))
        assertEquals(true, isArchivedThread(archived = null, isArchived = true, archivedAtPresent = false))
        assertEquals(true, isArchivedThread(archived = false, isArchived = false, archivedAtPresent = true))
        assertEquals(false, isArchivedThread(archived = false, isArchived = false, archivedAtPresent = false))
    }

    @Test
    fun transportAndChannelFailuresAreTransient() {
        assertTrue(isTransientConnectionFailure(SocketTimeoutException("pong timeout")))
        assertTrue(isTransientConnectionFailure(BridgeRpcException("closed", CONNECTION_LOST_CODE)))
        assertTrue(isTransientConnectionFailure(BridgeRpcException("channel closed", CHANNEL_CLOSED_CODE)))
        assertTrue(isTransientConnectionFailure(BridgeRpcException("channel timeout", CHANNEL_TIMEOUT_CODE)))
        assertTrue(isTransientConnectionFailure(BridgeRpcException("hello required", HELLO_REQUIRED_CODE)))
        assertFalse(isTransientConnectionFailure(BridgeRpcException("bad request", "INVALID_PARAMS")))
        assertFalse(isTransientConnectionFailure(BridgeRpcException("one slow metadata request", "REQUEST_TIMEOUT")))
    }

    @Test
    fun mergePreservesUnresolvedLocalItems() {
        val server = listOf<TimelineItem>(
            TimelineItem.Message("m1", Role.Assistant, "done", MessageStatus.Done),
        )
        val existing = listOf<TimelineItem>(
            TimelineItem.Approval("a1", "a1", "允许一次", "rm -rf build", "C:\\ws"),
            TimelineItem.Question("q1:x", "q1", "x", "选哪个？", listOf("A", "B")),
            TimelineItem.Message("u1", Role.User, "发送中", MessageStatus.Streaming),
            TimelineItem.Message("u2", Role.User, "失败的", MessageStatus.Failed),
            TimelineItem.Plan("p1", listOf(PlanStep(0, "step", StepStatus.InProgress)), PlanStatus.InProgress),
        )
        val merged = mergeTimelineItems(server, existing)
        assertEquals(listOf("m1", "a1", "q1:x", "u1", "u2", "p1"), merged.map { it.id })
    }

    @Test
    fun mergeDropsResolvedAndCompletedLocalItems() {
        val server = emptyList<TimelineItem>()
        val existing = listOf<TimelineItem>(
            TimelineItem.Approval("a1", "a1", "允许一次", "ls", "C:\\ws", decision = ApprovalDecision.AllowOnce),
            TimelineItem.Question("q1:x", "q1", "x", "选哪个？", listOf("A"), selectedOption = "A"),
            TimelineItem.Message("m1", Role.Assistant, "旧回复", MessageStatus.Done),
            TimelineItem.Plan("p1", emptyList(), PlanStatus.Done),
            TimelineItem.Command("c1", "npm test", "C:\\ws", com.agentpocket.app.data.model.CommandStatus.Running, "", false),
        )
        assertEquals(emptyList<TimelineItem>(), mergeTimelineItems(server, existing))
    }

    @Test
    fun serverItemWinsOnIdCollision() {
        val server = listOf<TimelineItem>(
            TimelineItem.Message("u1", Role.User, "服务器版本", MessageStatus.Done),
        )
        val existing = listOf<TimelineItem>(
            TimelineItem.Message("u1", Role.User, "本地乐观版本", MessageStatus.Streaming),
        )
        val merged = mergeTimelineItems(server, existing)
        assertEquals(1, merged.size)
        assertEquals("服务器版本", (merged.single() as TimelineItem.Message).text)
    }

    @Test
    fun completedEventArrivingDuringRefreshIsNotOverwritten() {
        val live = TimelineItem.Message("m2", Role.Assistant, "刚完成的回复", MessageStatus.Done)
        val stale = TimelineItem.Message("m2", Role.Assistant, "较旧回复", MessageStatus.Done)
        val merged = mergeTimelineItems(server = listOf(stale), existing = listOf(live), baseline = emptyList())
        assertEquals(listOf(live), merged)
    }

    private fun message(id: String, text: String = id, status: MessageStatus = MessageStatus.Done) =
        TimelineItem.Message(id, Role.Assistant, text, status)

    @Test
    fun latestPageRefreshKeepsLoadedHistoryAndLiveTail() {
        val old = message("old")
        val baseline = listOf(old, message("current", "partial", MessageStatus.Streaming))
        val live = message("current", "complete")
        val result = mergeTimelinePage(
            listOf(message("current", "older snapshot")), listOf(old, live), baseline,
            earlier = false, hasMore = true, historyIds = setOf("old", "current"),
        )
        assertEquals(listOf(old, live), result)
    }

    @Test
    fun olderPagePrependsWithoutDuplicatingOverlapOrDowngradingLiveText() {
        val live = message("new", "live text", MessageStatus.Streaming)
        val existing = listOf(message("middle"), live)
        val result = mergeTimelinePage(
            listOf(message("old"), message("middle", "stale")), existing, existing,
            earlier = true, hasMore = false, historyIds = setOf("middle"),
        )
        assertEquals(listOf(message("old"), message("middle", "stale"), live), result)
    }

    @Test
    fun overlappingOlderPageCorrectsStaleStateButPreservesConcurrentCompletion() {
        val baseline = listOf(message("x", "partial", MessageStatus.Streaming))
        val final = message("x", "final")
        assertEquals(listOf(final), mergeTimelinePage(
            listOf(final), baseline, baseline, true, false, setOf("x"),
        ))
        val live = message("x", "newer completion")
        assertEquals(listOf(live), mergeTimelinePage(
            listOf(final), listOf(live), baseline, true, false, setOf("x"),
        ))
    }

    @Test
    fun latestFullSnapshotStillRemovesObsoleteHistory() {
        val existing = listOf(message("rolled-back"), message("kept"))
        assertEquals(listOf(message("kept")), mergeTimelinePage(
            listOf(message("kept")), existing, existing,
            earlier = false, hasMore = false, historyIds = setOf("rolled-back", "kept"),
        ))
    }

    @Test
    fun acknowledgedOptimisticMessageIsNotMistakenForOlderHistory() {
        val optimistic = TimelineItem.Message("mobile-id", Role.User, "hello", MessageStatus.Done)
        val native = optimistic.copy(id = "native-id")
        val assistant = message("reply")
        val old = message("old")
        val existing = listOf(old, optimistic, assistant)
        assertEquals(listOf(old, native, assistant), mergeTimelinePage(
            listOf(native, assistant), existing, existing,
            earlier = false, hasMore = true, historyIds = setOf("old"),
        ))
    }
}
