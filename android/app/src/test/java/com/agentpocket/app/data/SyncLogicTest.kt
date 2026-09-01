package com.agentpocket.app.data

import com.agentpocket.app.data.model.ApprovalDecision
import com.agentpocket.app.data.model.MessageStatus
import com.agentpocket.app.data.model.PlanStatus
import com.agentpocket.app.data.model.PlanStep
import com.agentpocket.app.data.model.Role
import com.agentpocket.app.data.model.StepStatus
import com.agentpocket.app.data.model.TimelineItem
import org.junit.Assert.assertEquals
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
}
